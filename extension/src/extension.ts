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
  register("assistive.stop", () => c.stop());
  register("assistive.clearConversation", () => c.clearConversation());
  register("assistive.openPlannedFile", () => c.openPlannedFile());
  register("assistive.showNode", (id) => c.showNode(String(id)));
  register("assistive.explainNote", (id) => c.noteCommand("explain", String(id)));
  register("assistive.dismissNote", (id) => c.noteCommand("dismiss", String(id)));
  register("assistive.heartbeatNow", () => c.beatNow());
  register("assistive.toggleHeartbeat", () => c.toggleHeartbeat());
  register("assistive.exportGraph", () => c.exportGraph());
  register("assistive.openConfig", () => c.openConfig());
  register("assistive.setup", () => c.setup());
  register("assistive.testConnection", () => c.showConnectionTest());

  context.subscriptions.push(c);
  return { controller: c };
}

export function deactivate(): void {
  // Disposables registered on the context clean up.
}
