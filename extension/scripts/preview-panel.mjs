// Preview the real webview with a fake host: npm run preview:panel.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const node = (id, kind, label, signature, status = "planned", order) => ({ id, kind, label, signature, status, order, description: `The ${label.toLowerCase()} part of the shared implementation plan.`, notes: ["Refine edge cases through discussion as you code."], ...(status === "done" ? { line: 4 } : {}) });
const graph = { file: "issue_cache.py", language: "python", moduleString: "Fetch repository issues and cache responses with ETags.", revision: 1, updatedAt: new Date().toISOString(), nodes: [
  node("retrieve", "concept", "Retrieve remote issues", "GitHub API · ETag revalidation", "stubbed"),
  node("persist", "concept", "Keep a local cache", "Cache policy · persistent storage", "stubbed"),
  node("client", "class", "IssueClient", "class IssueClient", "stubbed", 2),
  node("fetch", "method", "Fetch repository issues", "fetch(repo: str) -> list[Issue]", "stubbed", 3),
  node("cache", "function", "Read cached response", "load_cache(repo: str) -> Cache", "done", 1),
  node("save", "function", "Persist response", "save_cache(repo: str, data: Cache)", "planned", 4),
  node("validate", "step", "Validate repository input", "repo: owner/name; reject empty input"),
  node("api", "external", "GitHub REST API", "GET /repos/{owner}/{repo}/issues"),
], edges: [
  { from: "retrieve", to: "client", kind: "contains" }, { from: "client", to: "fetch", kind: "contains" },
  { from: "fetch", to: "validate", kind: "contains" }, { from: "retrieve", to: "api", kind: "contains" },
  { from: "persist", to: "cache", kind: "contains" }, { from: "persist", to: "save", kind: "contains" },
  { from: "fetch", to: "cache", kind: "calls" }, { from: "fetch", to: "save", kind: "calls" }, { from: "fetch", to: "api", kind: "uses" },
] };
const state = { file: graph.file, language: "python", moduleString: graph.moduleString, moduleStringClosed: true, graph, feed: [{ id: "draft", ts: graph.updatedAt, kind: "assistant", mode: "draft", text: "Two responsibilities: retrieve issues and keep the cache consistent. Start with **Persist response**, then refine the client as you code." }], status: { llm: "ready", llmModel: "Preview model", jev: "ready", triage: "jev", heartbeat: "on", heartbeatSeconds: 45 }, canUndo: true, supported: true };
const bootstrap = `<script nonce="preview">window.previewFixture=${JSON.stringify(state)};window.previewMessages=[];window.previewUpdate=s=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:s}}));window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem('panel')||'{}'),setState:s=>sessionStorage.setItem('panel',JSON.stringify(s)),postMessage:m=>{window.previewMessages.push(m);if(m.type==='ready')setTimeout(()=>window.previewUpdate(window.previewFixture),50)}});</script>`;
const theme = `<style>:root{--vscode-font-family:system-ui;--vscode-font-size:12px;--vscode-foreground:#d4d4d4;--vscode-descriptionForeground:#a3a3a3;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-panel-border:#333;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#026ec1;--vscode-focusBorder:#007fd4;--vscode-textLink-foreground:#4daafc;--vscode-editor-font-family:monospace;--vscode-charts-yellow:#e5c07b;--vscode-charts-green:#89d185;--vscode-charts-red:#f48771;}</style>`;
const html = readFileSync(`${root}dist/webview/index.html`, "utf8").replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "preview").replace("{{styleUri}}", "/panel.css").replace("{{scriptUri}}", "/panel.js").replace("</head>", `${theme}</head>`).replace('<script nonce="preview" src=', `${bootstrap}<script nonce="preview" src=`);
createServer((req, res) => {
  const file = { "/panel.js": ["panel.js", "text/javascript"], "/panel.css": ["panel.css", "text/css"] }[req.url];
  if (req.url !== "/" && !file) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", file ? file[1] : "text/html");
  res.end(file ? readFileSync(`${root}dist/webview/${file[0]}`) : html);
}).listen(4173, "127.0.0.1", () => console.log("Panel preview: http://127.0.0.1:4173"));
