// Spawns rail-server over stdio, restarts it with backoff, discovers interpreters.

import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PythonExtension } from "@vscode/python-extension";
import { InitializeParams, RailClient } from "../rpc/Client";
import type { InitializeResult } from "../types";
import { RestartPolicy } from "./RestartPolicy";

export interface ServerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export type ServerState = "stopped" | "starting" | "running" | "crashed" | "failed";

function venvPython(venv: string): string {
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}

/** Candidate directories holding the bundled server sources. */
export function serverDirs(extensionPath: string): string[] {
  let real = extensionPath;
  try {
    real = fs.realpathSync(extensionPath);
  } catch {
    // keep the given path
  }
  const dirs = [path.join(real, "server"), path.join(real, "..", "server")];
  return dirs.filter((d) => fs.existsSync(path.join(d, "pyproject.toml")));
}

export function resolveServerCommand(extensionPath: string): ServerCommand | undefined {
  const cfg = vscode.workspace.getConfiguration("referenceRail");
  const explicit = cfg.get<string>("serverPath")?.trim();
  if (explicit) {
    return { command: explicit, args: ["-m", "rail_server"] };
  }
  for (const dir of serverDirs(extensionPath)) {
    const py = venvPython(path.join(dir, ".venv"));
    if (fs.existsSync(py)) {
      return { command: py, args: ["-m", "rail_server"], cwd: dir };
    }
  }
  return undefined;
}

/** The interpreter of the project being edited (design plan §9.2). */
export async function resolveUserPython(
  folder: vscode.Uri | undefined,
  log: vscode.OutputChannel,
): Promise<string> {
  const setting = vscode.workspace.getConfiguration("referenceRail").get<string>("pythonPath")?.trim();
  if (setting) {
    return setting;
  }
  if (vscode.extensions.getExtension("ms-python.python")) {
    try {
      const api = await withTimeout(PythonExtension.api(), 5000);
      const envPath = api.environments.getActiveEnvironmentPath(folder);
      const env = await withTimeout(api.environments.resolveEnvironment(envPath), 5000);
      const exe = env?.executable.uri?.fsPath;
      if (exe) {
        return exe;
      }
    } catch (err) {
      log.appendLine(`[rail] Python extension did not report an interpreter: ${String(err)}`);
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class ServerProcess implements vscode.Disposable {
  private proc?: ChildProcess;
  private conn?: MessageConnection;
  private client?: RailClient;
  private disposed = false;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private readonly policy = new RestartPolicy();
  private _state: ServerState = "stopped";
  private _info?: InitializeResult;

  private readonly onStartEmitter = new vscode.EventEmitter<RailClient>();
  readonly onDidStart = this.onStartEmitter.event;
  private readonly onStateEmitter = new vscode.EventEmitter<ServerState>();
  readonly onDidChangeState = this.onStateEmitter.event;

  constructor(
    private readonly resolveCommand: () => ServerCommand | undefined,
    private readonly initParams: () => Promise<InitializeParams>,
    private readonly log: vscode.OutputChannel,
  ) {}

  get state(): ServerState {
    return this._state;
  }

  get info(): InitializeResult | undefined {
    return this._info;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get rail(): RailClient | undefined {
    return this._state === "running" ? this.client : undefined;
  }

  get restartCount(): number {
    return this.policy.recentRestarts;
  }

  private setState(s: ServerState): void {
    this._state = s;
    this.onStateEmitter.fire(s);
  }

  async start(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const cmd = this.resolveCommand();
    if (!cmd) {
      this.setState("failed");
      return false;
    }
    this.setState("starting");
    this.stopping = false;
    this.log.appendLine(`[rail] starting ${cmd.command} ${cmd.args.join(" ")}`);
    const proc = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => this.log.append(d));
    proc.on("error", (err) => this.log.appendLine(`[rail] server spawn error: ${err.message}`));
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal));

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout!),
      new StreamMessageWriter(proc.stdin!),
    );
    conn.onError(([err]) => this.log.appendLine(`[rail] rpc error: ${err.message}`));
    conn.listen();
    this.conn = conn;
    const client = new RailClient(conn);
    this.client = client;
    try {
      const params = await this.initParams();
      this._info = await client.initialize(params);
    } catch (err) {
      this.log.appendLine(`[rail] initialize failed: ${String(err)}`);
      if (this.proc === proc && proc.exitCode === null) {
        proc.kill();
      }
      return false;
    }
    if (this.proc !== proc) {
      return false;
    }
    this.log.appendLine(`[rail] server ${this._info.serverVersion} running (pid ${proc.pid})`);
    this.setState("running");
    this.onStartEmitter.fire(client);
    return true;
  }

  private onExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (proc !== this.proc) {
      return;
    }
    this.log.appendLine(`[rail] server exited (code ${code}, signal ${signal})`);
    this.conn?.dispose();
    this.conn = undefined;
    this.client = undefined;
    this.proc = undefined;
    if (this.disposed || this.stopping) {
      this.setState("stopped");
      return;
    }
    const delay = this.policy.nextDelay();
    if (delay === null) {
      this.setState("failed");
      void vscode.window
        .showErrorMessage(
          "Reference Rail: the server crashed 3 times in 5 minutes and was not restarted.",
          "Show Log",
          "Restart",
        )
        .then((choice) => {
          if (choice === "Show Log") {
            this.log.show();
          } else if (choice === "Restart") {
            this.policy.reset();
            void this.start();
          }
        });
      return;
    }
    this.setState("crashed");
    this.log.appendLine(`[rail] restarting in ${delay} ms`);
    this.restartTimer = setTimeout(() => void this.start(), delay);
  }

  async restart(): Promise<boolean> {
    await this.stop();
    this.policy.reset();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    const proc = this.proc;
    const client = this.client;
    if (!proc) {
      return;
    }
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    await Promise.race([client?.shutdown(), delay(1500)]);
    await Promise.race([exited, delay(2000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.stop();
    this.onStartEmitter.dispose();
    this.onStateEmitter.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
