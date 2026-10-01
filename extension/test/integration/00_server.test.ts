// Phase 0 acceptance: Ping shows the server version; a killed server restarts.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { api, waitFor, waitRunning } from "./helpers";

describe("Phase 0: server lifecycle", () => {
  it("Ping shows the server version", async () => {
    const a = await api();
    await waitRunning(a);
    const pong = (await vscode.commands.executeCommand("referenceRail.ping")) as {
      serverVersion: string;
      pid: number;
    };
    assert.match(pong.serverVersion, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(pong.pid, a.server.pid);
  });

  it("killing the server process triggers an automatic restart", async () => {
    const a = await api();
    await waitRunning(a);
    const old = a.server.pid!;
    process.kill(old, "SIGKILL");
    await waitFor(() => a.server.state !== "running", 10_000, "server to notice the crash");
    await waitFor(
      () => a.server.state === "running" && a.server.pid !== undefined && a.server.pid !== old,
      30_000,
      "server restart",
    );
    const pong = (await vscode.commands.executeCommand("referenceRail.ping")) as { pid: number };
    assert.notStrictEqual(pong.pid, old);
  });
});
