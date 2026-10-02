// Hosts the panel webview in the Assistive activity-bar container.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { FromPanel, PanelState, ToPanel } from "../types";

export class PanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "assistive.panel";
  private view?: vscode.WebviewView;
  private ready = false;
  private last?: PanelState;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly visibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibility.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: FromPanel) => void,
  ) {}

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = randomBytes(16).toString("base64");
    const template = fs.readFileSync(vscode.Uri.joinPath(root, "index.html").fsPath, "utf8");
    view.webview.html = template
      .replace(/{{cspSource}}/g, view.webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace("{{scriptUri}}", view.webview.asWebviewUri(vscode.Uri.joinPath(root, "panel.js")).toString())
      .replace("{{styleUri}}", view.webview.asWebviewUri(vscode.Uri.joinPath(root, "panel.css")).toString());
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: FromPanel) => {
        if (m.type === "ready") {
          this.ready = true;
          if (this.last) {
            void view.webview.postMessage({ type: "state", state: this.last } satisfies ToPanel);
          }
        }
        this.onMessage(m);
      }),
      view.onDidChangeVisibility(() => this.visibility.fire(view.visible)),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        this.visibility.fire(false);
      }),
    );
    this.visibility.fire(view.visible);
  }

  setState(state: PanelState): void {
    this.last = state;
    this.post({ type: "state", state });
  }

  post(msg: ToPanel): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(msg);
    }
  }

  async reveal(focusInput?: string): Promise<void> {
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
    if (focusInput !== undefined) {
      // The view may still be loading; retry briefly until the webview is ready.
      for (let i = 0; i < 20 && !this.ready; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      this.post({ type: "focusInput", text: focusInput });
    }
  }

  dispose(): void {
    this.visibility.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
