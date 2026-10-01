// "Reference Rail: Show Metrics" — the MetricsReport as a table, with CSV export.

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { MetricsReport } from "../types";
import { reportRows, reportToCsv } from "./csv";

const DESCRIPTIONS: Record<string, string> = {
  external_lookups: "Window blurs of 3 s–10 min right after editing, with no debug session (proxy for leaving the editor to look something up).",
  lookups_per_active_hour: "North-star metric: external lookups per active editing hour. Lower is better.",
  active_hours: "Hours with at least 6 minutes that contained edits.",
};

export class MetricsPanel {
  private static current?: MetricsPanel;
  private report?: MetricsReport;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      if (MetricsPanel.current === this) {
        MetricsPanel.current = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  static show(report: MetricsReport, refresh: (days: number) => Promise<MetricsReport>): MetricsPanel {
    let p = MetricsPanel.current;
    if (!p) {
      const panel = vscode.window.createWebviewPanel(
        "referenceRail.metrics",
        "Reference Rail Metrics",
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [] },
      );
      p = new MetricsPanel(panel);
      MetricsPanel.current = p;
    }
    p.refresh = refresh;
    p.render(report);
    p.panel.reveal();
    return p;
  }

  private refresh?: (days: number) => Promise<MetricsReport>;

  get csv(): string | undefined {
    return this.report ? reportToCsv(this.report) : undefined;
  }

  private async onMessage(msg: { type: string; days?: number }): Promise<void> {
    if (msg.type === "export" && this.report) {
      const target = await vscode.window.showSaveDialog({
        filters: { CSV: ["csv"] },
        saveLabel: "Export metrics",
        defaultUri: vscode.Uri.file(`reference-rail-metrics-${this.report.generatedAt.slice(0, 10)}.csv`),
      });
      if (target) {
        await vscode.workspace.fs.writeFile(target, Buffer.from(reportToCsv(this.report), "utf8"));
        void vscode.window.showInformationMessage(`Metrics exported to ${target.fsPath}`);
      }
    } else if (msg.type === "copy" && this.report) {
      await vscode.env.clipboard.writeText(reportToCsv(this.report));
    } else if (msg.type === "range" && msg.days && this.refresh) {
      this.render(await this.refresh(msg.days));
    }
  }

  render(report: MetricsReport): void {
    this.report = report;
    const nonce = crypto.randomBytes(16).toString("base64");
    const esc = (s: unknown) =>
      String(s ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const rows = reportRows(report)
      .map(([k, v]) => {
        const help = DESCRIPTIONS[k] ? ` title="${esc(DESCRIPTIONS[k])}"` : "";
        return `<tr${help}><td>${esc(k)}</td><td class="v">${esc(v)}</td></tr>`;
      })
      .join("");
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}
h2{font-size:14px} table{border-collapse:collapse;min-width:420px}
td{padding:3px 10px;border-bottom:1px solid var(--vscode-panel-border)} td.v{text-align:right;font-family:var(--vscode-editor-font-family)}
.north{font-size:13px;margin:6px 0 12px} button{margin-right:6px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none;padding:4px 10px;cursor:pointer}
select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border)}
</style></head><body>
<h2>Reference Rail metrics — last ${esc(report.sinceDays)} days</h2>
<div class="north">External lookups per active editing hour: <b>${esc(report.lookupsPerActiveHour)}</b>
 (rail on: ${esc(report.lookupsPerActiveHourRailOn)}, rail off: ${esc(report.lookupsPerActiveHourRailOff)}). Lower is better.</div>
<p><select id="days"><option value="1">1 day</option><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
<button id="export">Export CSV…</button><button id="copy">Copy CSV</button></p>
<table>${rows}</table>
<p style="font-size:11px;color:var(--vscode-descriptionForeground)">All data is local (~/.reference-rail/). Generated ${esc(report.generatedAt)}.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('days').value = '${Number(report.sinceDays)}';
document.getElementById('export').onclick = () => vscode.postMessage({type:'export'});
document.getElementById('copy').onclick = () => vscode.postMessage({type:'copy'});
document.getElementById('days').onchange = (e) => vscode.postMessage({type:'range', days: Number(e.target.value)});
</script></body></html>`;
  }
}
