// Assistive: an implementation graph that the programmer and an LLM build
// together from the module docstring, kept in sync with the code the
// programmer types, with a Jev-triaged heartbeat that interrupts only when it matters.

import * as vscode from "vscode";
import { Controller } from "./controller";

export interface AssistiveApi {
  controller: Controller;
}

export function activate(context: vscode.ExtensionContext): AssistiveApi {
  const c = new Controller(context);
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("assistive.focus", () => c.panel.reveal());
  register("assistive.ask", () => c.panel.reveal(""));
  register("assistive.draftGraph", () => c.draft());
  register("assistive.syncGraph", () => c.sync());
  register("assistive.undoGraph", () => c.undo());
  register("assistive.clearGraph", () => c.clear());
  register("assistive.heartbeatNow", () => c.beatNow());
  register("assistive.toggleHeartbeat", () => c.toggleHeartbeat());
  register("assistive.exportGraph", () => c.exportGraph());
  register("assistive.openConfig", () => c.openConfig());
  register("assistive.testConnection", async () => {
    const lines = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Assistive: testing the LLM and Jev connections…" },
      () => c.testConnection(),
    );
    const ok = !lines.some((l) => /error|rejected|not configured|could not|did not/i.test(l));
    const show = ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(lines.join("  ·  "), ...(ok ? [] : ["Open .env"])).then((choice) => {
      if (choice === "Open .env") void c.openConfig();
    });
    return lines;
  });

  context.subscriptions.push(c);
  return { controller: c };
}

export function deactivate(): void {
  // Disposables registered on the context clean up.
}
