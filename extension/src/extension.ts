// Reference Rail: activate/deactivate and wiring (design plan §4).

import * as fs from "node:fs";
import * as vscode from "vscode";
import { PythonExtension } from "@vscode/python-extension";
import {
  copyText,
  downloadModel,
  openSource,
  setupServerEnvironment,
  SOURCE_SCHEME,
} from "./commands";
import { ContextCollector } from "./context/ContextCollector";
import { MetricsPanel } from "./metrics/MetricsPanel";
import { CardAction, RailViewProvider } from "./rail/RailViewProvider";
import { RailClient } from "./rpc/Client";
import {
  resolveServerCommand,
  resolveUserPython,
  ServerProcess,
} from "./server/ServerProcess";
import { dataDir, SessionRecorder } from "./session/SessionRecorder";
import { EventLogger } from "./telemetry/EventLogger";
import type { Card, ContextFrame, IndexProgress, QueryResult } from "./types";

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("referenceRail");
}

/** Sends frames and routes only the newest result to the rail. */
export class RailController {
  private latestSent = 0;
  lastLatencyMs?: number;
  lastResult?: QueryResult;
  /** Results that reached the rail (used by tests). */
  delivered = 0;

  constructor(
    private readonly server: ServerProcess,
    private readonly rail: RailViewProvider,
    private readonly recorder: SessionRecorder,
    private readonly logger: EventLogger,
    private readonly onLatency: (ms: number) => void,
  ) {}

  async submit(frame: ContextFrame): Promise<Card[] | undefined> {
    const client = this.server.rail;
    if (!client) {
      return undefined;
    }
    this.latestSent = Math.max(this.latestSent, frame.requestId);
    let outcome;
    try {
      outcome = await client.query(frame);
    } catch (err) {
      console.error("context/query failed", err);
      return undefined;
    }
    this.recorder.record(frame, outcome.result, outcome.latencyMs, outcome.superseded);
    if (outcome.superseded || !outcome.result || frame.requestId !== this.latestSent) {
      return undefined;
    }
    this.lastLatencyMs = outcome.latencyMs;
    this.lastResult = outcome.result;
    this.delivered += 1;
    this.onLatency(outcome.latencyMs);
    const cards = outcome.result.cards;
    this.rail.showLive(cards);
    if (frame.trigger === "explicit") {
      this.logger.log("explicit_query", {
        qualname: cards[0]?.qualname,
        trigger: "explicit",
        payload: { question: Boolean(frame.explicitQuestion), nCards: cards.length },
      });
    }
    return cards;
  }
}

export interface RailApi {
  server: ServerProcess;
  rail: RailViewProvider;
  collector: ContextCollector;
  controller: RailController;
  logger: EventLogger;
  refreshMemory(): Promise<void>;
  /** Perform a card action as if its button was clicked (tests, keybindings). */
  act(action: CardAction, card: Card, section?: string): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<RailApi> {
  const log = vscode.window.createOutputChannel("Reference Rail");
  context.subscriptions.push(log);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = "referenceRail.focus";
  status.text = "$(book) Rail";
  status.show();
  context.subscriptions.push(status);

  let enabled = cfg().get<boolean>("enabled", true);
  let indexText = "starting";
  let latencyText = "";
  const updateStatus = () => {
    const text = enabled ? `Index: ${indexText}${latencyText ? ` · last query ${latencyText}` : ""}` : "Paused";
    status.text = enabled ? `$(book) Rail${latencyText ? ` ${latencyText}` : ""}` : "$(debug-pause) Rail";
    status.tooltip = `Reference Rail — ${text}`;
    rail.setStatus(text);
  };

  const userPython = async () =>
    resolveUserPython(vscode.workspace.workspaceFolders?.[0]?.uri, log);

  const server = new ServerProcess(
    () => resolveServerCommand(context.extensionPath),
    async () => ({
      workspaceRoots: (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath),
      pythonPath: await userPython(),
      config: {
        maxCards: cfg().get("maxCards", 3),
        extraRepos: cfg().get("extraRepos", []),
        historyDepth: cfg().get("historyDepth", 500),
        indexStdlib: cfg().get("indexStdlib", true),
        embeddingBackend: cfg().get("embeddingBackend", "auto"),
        embeddingModel: cfg().get("embeddingModel"),
        precedentThreshold: cfg().get("precedentThreshold") ?? undefined,
      },
    }),
    log,
  );
  context.subscriptions.push(server);

  const logger = new EventLogger(
    (events) => server.rail?.logEvents(events),
    () => enabled,
  );
  context.subscriptions.push({ dispose: () => logger.dispose() });

  const refreshMemory = async () => {
    const client = server.rail;
    if (!client) {
      return;
    }
    try {
      const [pinned, frequent] = await Promise.all([client.pinned(), client.frequent()]);
      rail.setPinned(pinned);
      rail.setFrequent(frequent);
    } catch (err) {
      log.appendLine(`[rail] memory refresh failed: ${String(err)}`);
    }
  };

  const onAction = async (action: CardAction, card: Card, section: string) => {
    const client = server.rail;
    const fields = { cardId: card.id, qualname: card.qualname, payload: { kind: card.kind, section } };
    switch (action) {
      case "open":
        logger.log("card_opened", fields);
        try {
          await openSource(card);
        } catch (err) {
          void vscode.window.showWarningMessage(`Reference Rail: cannot open source: ${String(err)}`);
        }
        break;
      case "pin":
        logger.log("card_pinned", fields);
        await client?.pin(card.id);
        await refreshMemory();
        break;
      case "unpin":
        await client?.unpin(card.id, card.qualname);
        await refreshMemory();
        break;
      case "copy":
        await vscode.env.clipboard.writeText(copyText(card));
        logger.log("card_copied", fields);
        break;
      case "dismiss":
        logger.log("card_dismissed", fields);
        break;
    }
    if (action === "open") {
      // Opening counts toward Frequent; refresh it a little later (events batch every 2 s).
      setTimeout(() => void refreshMemory(), 2500);
    }
  };

  const rail = new RailViewProvider(context.extensionUri, {
    onAction: (a, c, s) => void onAction(a, c, s),
    onShown: (cards) => {
      for (const c of cards) {
        logger.log("card_shown", {
          cardId: c.id,
          qualname: c.qualname,
          payload: { kind: c.kind, confidence: c.confidence },
        });
      }
    },
    onReady: () => {
      rail.setPaused(!enabled);
      updateStatus();
    },
  });
  context.subscriptions.push(
    rail,
    vscode.window.registerWebviewViewProvider(RailViewProvider.viewId, rail, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const recorder = new SessionRecorder(() => cfg().get<boolean>("recordSessions", false));
  const controller = new RailController(server, rail, recorder, logger, (ms) => {
    latencyText = `${ms} ms`;
    updateStatus();
  });

  const collector = new ContextCollector({
    onFrame: (frame) => void controller.submit(frame),
    onEdit: () => {
      logger.noteEdit();
      server.rail?.cancelInflight();
    },
    onSave: (doc) => server.rail?.fileChanged(doc.uri.fsPath),
    enabled: () => enabled,
  });
  context.subscriptions.push(collector);

  // Window focus → external-lookup proxy (§9.8).
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        logger.log("focus_gained", { payload: { railEnabled: enabled } });
      } else {
        const since = collector.lastEditTime ? Date.now() - collector.lastEditTime : null;
        logger.log("focus_lost", {
          payload: { debug: !!vscode.debug.activeDebugSession, msSinceLastEdit: since, railEnabled: enabled },
        });
        logger.flush();
      }
    }),
  );

  // Read-only virtual documents for runtime docs and code recovered from git history.
  const sourceEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SOURCE_SCHEME, {
      onDidChange: sourceEmitter.event,
      provideTextDocumentContent: async (uri) => {
        const client = server.rail;
        if (!client) {
          return "Reference Rail server is not running.";
        }
        try {
          return (await client.readSource(JSON.parse(uri.query))).text;
        } catch (err) {
          return `Cannot read source: ${String(err)}`;
        }
      },
    }),
  );

  server.onDidStart((client: RailClient) => {
    client.onProgress((p: IndexProgress) => {
      if (p.phase === "done") {
        indexText = "up to date";
        void refreshMemory();
      } else if (p.phase === "error") {
        indexText = "error (see log)";
        log.appendLine(`[rail] ${p.message}`);
      } else {
        indexText = p.total ? `${p.phase} ${p.done}/${p.total}` : p.message;
      }
      updateStatus();
    });
    indexText = "syncing";
    updateStatus();
    void refreshMemory();
  });
  server.onDidChangeState((s) => {
    if (s === "crashed") {
      indexText = "server restarting";
    } else if (s === "failed") {
      indexText = "server stopped (see log)";
    }
    updateStatus();
  });

  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("referenceRail.focus", () => vscode.commands.executeCommand(`${RailViewProvider.viewId}.focus`));
  register("referenceRail.askAboutSymbol", async (question?: unknown) => {
    let q = typeof question === "string" ? question : undefined;
    if (q === undefined) {
      q = await vscode.window.showInputBox({
        prompt: "Ask about the symbol at the cursor (optional question, Enter to skip)",
        placeHolder: "e.g. what does requests.get raise on timeout?",
      });
      if (q === undefined) {
        return undefined;
      }
    }
    const frame = await collector.ask(q || undefined);
    return frame;
  });
  register("referenceRail.pinTopCard", async () => {
    const top = rail.liveCards[0];
    if (!top) {
      void vscode.window.showInformationMessage("Reference Rail: no card to pin.");
      return;
    }
    await onAction("pin", top, "live");
  });
  register("referenceRail.toggle", async () => {
    enabled = !enabled;
    await cfg().update("enabled", enabled, vscode.ConfigurationTarget.Global);
    logger.log("rail_toggled", { payload: { enabled } });
    rail.setPaused(!enabled);
    updateStatus();
    return enabled;
  });
  register("referenceRail.showMetrics", async () => {
    const client = server.rail;
    if (!client) {
      void vscode.window.showWarningMessage("Reference Rail: the server is not running.");
      return undefined;
    }
    logger.flush();
    await new Promise((r) => setTimeout(r, 100)); // let the batch reach the server
    const report = await client.metrics(14);
    const panel = MetricsPanel.show(report, (days) => client.metrics(days));
    return { report, csv: panel.csv };
  });
  register("referenceRail.reindex", async () => {
    const client = server.rail;
    if (!client) {
      return;
    }
    await client.sync({ full: true });
    indexText = "re-indexing";
    updateStatus();
  });
  register("referenceRail.ping", async () => {
    const client = server.rail;
    if (!client) {
      void vscode.window.showWarningMessage(`Reference Rail: server is ${server.state}.`);
      return undefined;
    }
    const pong = await client.ping();
    void vscode.window.showInformationMessage(
      `Reference Rail server ${pong.serverVersion} (pid ${pong.pid}, Python ${pong.python}) is running.`,
    );
    return pong;
  });
  register("referenceRail.showLog", () => log.show());
  register("referenceRail.clearData", async () => {
    const dir = dataDir();
    const ok = await vscode.window.showWarningMessage(
      `Delete all Reference Rail data in ${dir} (index, events, pins, models)?`,
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") {
      return;
    }
    await server.stop();
    await fs.promises.rm(dir, { recursive: true, force: true });
    rail.setPinned([]);
    rail.setFrequent([]);
    rail.showLive([]);
    await server.restart();
  });
  register("referenceRail.setupServer", async () => {
    if (await setupServerEnvironment(context.extensionPath, log)) {
      await server.restart();
    }
  });
  register("referenceRail.downloadModel", async () => {
    const cmd = resolveServerCommand(context.extensionPath);
    if (!cmd) {
      return;
    }
    const model = cfg().get<string>("embeddingModel", "sentence-transformers/all-MiniLM-L6-v2");
    const ok = await vscode.window.showInformationMessage(
      `Download the local embedding model ${model} (~90 MB) for better precedent search? ` +
        "This is the only network access Reference Rail makes; everything else runs offline.",
      "Download",
    );
    if (ok === "Download" && (await downloadModel(cmd.command, model, log))) {
      await server.restart();
      await server.rail?.sync({});
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("referenceRail.enabled")) {
        enabled = cfg().get<boolean>("enabled", true);
        rail.setPaused(!enabled);
        updateStatus();
      } else if (
        e.affectsConfiguration("referenceRail.pythonPath") ||
        e.affectsConfiguration("referenceRail.serverPath") ||
        e.affectsConfiguration("referenceRail.extraRepos") ||
        e.affectsConfiguration("referenceRail.historyDepth") ||
        e.affectsConfiguration("referenceRail.maxCards") ||
        e.affectsConfiguration("referenceRail.embeddingBackend") ||
        e.affectsConfiguration("referenceRail.embeddingModel") ||
        e.affectsConfiguration("referenceRail.precedentThreshold") ||
        e.affectsConfiguration("referenceRail.indexStdlib")
      ) {
        void server.restart();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void server.rail?.sync({
      roots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    })),
  );

  // A different project interpreter means different libraries: restart and re-index.
  if (vscode.extensions.getExtension("ms-python.python")) {
    PythonExtension.api().then(
      (py) =>
        context.subscriptions.push(
          py.environments.onDidChangeActiveEnvironmentPath(() => {
            if (!cfg().get<string>("pythonPath")?.trim()) {
              log.appendLine("[rail] active interpreter changed; restarting the server");
              void server.restart();
            }
          }),
        ),
      (err) => log.appendLine(`[rail] Python extension API unavailable: ${String(err)}`),
    );
  }

  updateStatus();
  if (!resolveServerCommand(context.extensionPath)) {
    indexText = "server not set up";
    updateStatus();
    void vscode.window
      .showInformationMessage(
        "Reference Rail needs its local Python server environment (one-time setup with uv or pip; downloads packages from PyPI).",
        "Set Up Now",
        "Later",
      )
      .then(async (choice) => {
        if (choice === "Set Up Now" && (await setupServerEnvironment(context.extensionPath, log))) {
          await server.start();
        }
      });
  } else {
    void server.start();
  }

  return {
    server,
    rail,
    collector,
    controller,
    logger,
    refreshMemory,
    act: (action, card, section = "live") => {
      if (action === "dismiss") {
        rail.dismiss(card.id);
      }
      return onAction(action, card, section);
    },
  };
}

export function deactivate(): void {
  // Disposables registered on the context stop the server.
}
