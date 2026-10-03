# Assistive

An **implementation graph** that you and an LLM build together, in a VS Code side panel.

1. **Write the module docstring.** Describe what the file should do at its top. The assistant drafts a graph of what you will type: functions, classes and methods with concrete signatures, the technical considerations for each, the external APIs involved, and a suggested typing order. It drafts from your docstring and your project (file tree, manifests, README, and the modules you import).
2. **Steer it in plain language.** Type instructions in the panel's input box, such as "split parsing into its own function" or "what's the best way to cache this?". The LLM edits the graph through a set of tools and replies with a brief summary.
3. **Type the code yourself.** The assistant never writes your implementation or touches your buffers. As your code appears, the graph follows it within a second, no save needed: nodes go from *planned* to *stub* to *done*, and the next piece to type is highlighted.
4. **A heartbeat watches, calmly.** While you type, a heartbeat runs at a relaxed interval (45 s by default). [Jev](https://typesafe.ai), TypeSafe AI's System One model, triages each beat in about 100 ms with calibrated probabilities. It looks for a typo, a logic error, API misuse, a missed edge case, a clearly better approach, a security problem, or drift from the plan. Only when Jev's answers cross the thresholds does the LLM take a closer look and decide whether to interrupt you. An interrupt shows in the panel, squiggles the line, and flags the graph node. It resolves itself once you change that line.
5. **Learn what you're missing.** When the assistant notices that you lack a concept, it recommends a few resources. They are mostly official docs, and every link is checked before it appears in the panel.

![Graph drafted from the module docstring](docs/images/panel-draft.png)

| Heartbeat interrupt | Steps and node details |
|---|---|
| ![Interrupt](docs/images/panel-interrupt.png) | ![Steps](docs/images/panel-steps.png) |

## Documentation

The [`docs/`](docs/README.md) folder has the full documentation, written in ASD-STE100 Simplified Technical English:
- **User guides:** installation, configuration, step-by-step use and troubleshooting.
- **Implementation guides:** one chapter for each part of the code, a reference for each LLM tool, and how to extend Assistive.

## Quick start

Requirements:
- VS Code 1.101 or newer (or VSCodium or Cursor);
- Node.js 22 to build;
- an OpenAI-compatible LLM endpoint with tool calling (OpenAI, Azure OpenAI, OpenRouter, vLLM, Ollama, LM Studio, and others);
- a Jev API key (optional: the heartbeat can triage with the LLM instead).

```sh
git clone https://github.com/ErrDivine/Assistive && cd Assistive/extension
npm ci
npm run install-local                 # or: npm run install-local -- --editor codium|cursor|insiders
```

`install-local` builds the extension, links it into your editor, and creates `Assistive/.env` from [`.env.example`](.env.example). Fill in the placeholders:

```dotenv
ASSISTIVE_LLM_BASE_URL=https://api.openai.com/v1
ASSISTIVE_LLM_API_KEY=REPLACE_ME
ASSISTIVE_LLM_MODEL=REPLACE_ME

ASSISTIVE_JEV_BASE_URL=https://api.typesafe.ai/v1
ASSISTIVE_JEV_API_KEY=REPLACE_ME
ASSISTIVE_JEV_MODEL=jev-latest
```

To finish setting up:
1. Restart the editor, then run **Assistive: Test LLM and Jev Connections** from the Command Palette.
2. Open a Python, TypeScript or JavaScript file and write its docstring.

The `.env` is reloaded whenever you save it; **Assistive: Open API Configuration** opens it.

## Using it

| Action | How |
|---|---|
| Open the panel | Activity bar → Assistive, or `Ctrl+Alt+G` |
| Draft a graph | Write the module docstring and close it: the draft starts by itself when the file has no graph yet. Files you only open are not drafted automatically; press **Draft** for those, or **Redraft** after changing a docstring. |
| Tell the assistant something | Type in the input box (`Enter` sends, `Shift+Enter` adds a line), or press `Ctrl+Alt+/` from the editor |
| See what to type next | **Steps** tab: nodes in typing order with signatures; the tab shows your progress (`Steps 3/7`) and the next piece has a **next** badge (also a halo in the graph and `3/7` in the status bar) |
| See the plan while you type | Hover a function, class or method name in the editor: its planned signature, description and notes |
| Inspect a node | Click it to see its signature, description, notes and edges, plus **Go to code**, **Copy signature** and **Ask about this**. Double-click jumps to the code. |
| Bring the graph in line with the code | **Sync** (also runs on its own when a heartbeat finds the graph out of date) |
| Undo a graph change | **Undo** (keeps the last 20 revisions per file) |
| Stop a request in progress | **Stop** on the busy line above the input box |
| Check now instead of waiting for the heartbeat | **♥ Check now** |
| Pause or resume the heartbeat | **Pause** / **Resume** |
| Handle an interrupt | **Show line**, **Explain more** (a deeper explanation with resources) or **Got it** (it is not raised again) |
| Export | **Assistive: Export Graph as Mermaid** |

**Settings:**
- `assistive.envFile`: path to the `.env` file.
- `assistive.autoDraft`
- `assistive.heartbeat.enabled`
- `assistive.notifications`: `toast` also shows a notification when the panel is hidden.
- `assistive.languages`

Graphs and conversations are stored per workspace in the extension's storage folder, never in your repository.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTIVE_LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible Chat Completions endpoint |
| `ASSISTIVE_LLM_API_KEY` | — | API key (sent as `Authorization: Bearer`) |
| `ASSISTIVE_LLM_MODEL` | — | A model that supports tool calling |
| `ASSISTIVE_LLM_TEMPERATURE` | `0.2` | Dropped automatically for models that reject it |
| `ASSISTIVE_LLM_TIMEOUT_SECONDS` | `120` | Per request |
| `ASSISTIVE_LLM_MAX_TOOL_ROUNDS` | `8` | Tool-calling rounds per turn before a summary is forced |
| `ASSISTIVE_LLM_EXTRA_HEADERS` | — | JSON object of extra headers (e.g. OpenRouter's `HTTP-Referer`) |
| `ASSISTIVE_JEV_BASE_URL` | `https://api.typesafe.ai/v1` | Jev endpoint; requests go to `{base}/systemone` |
| `ASSISTIVE_JEV_API_KEY` | — | Jev API key |
| `ASSISTIVE_JEV_MODEL` | `jev-latest` | |
| `ASSISTIVE_JEV_TIMEOUT_SECONDS` | `10` | |
| `ASSISTIVE_TRIAGE` | `jev` | Who triages heartbeats: `jev`, `llm` (a cheap JSON verdict), or `off` |
| `ASSISTIVE_HEARTBEAT_SECONDS` | `45` | Minimum time between beats (at least 15) |
| `ASSISTIVE_INTERRUPT_THRESHOLD` | `0.65` | Jev's P(interrupt) needed before the LLM is asked |
| `ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS` | `90` | Quiet time after an interrupt (severe problems still come through) |
| `ASSISTIVE_GRAPH_SYNC_THRESHOLD` | `0.7` | P(graph out of date) that triggers a sync |
| `ASSISTIVE_EXPLAIN_THRESHOLD` | `0.75` | P(you are stuck on a concept) that triggers resource suggestions |
| `ASSISTIVE_VERIFY_LINKS` | `true` | Check recommended links before showing them |

Variables in the process environment (`ASSISTIVE_*`) override the file.

**Where the `.env` is looked up:**
1. `assistive.envFile`;
2. `<repository>/.env` when the extension is linked from a checkout;
3. `~/.assistive/.env`.

## How it works

```
 module docstring ──► draft ──┐        programmer's message ──► chat ──┐
                              ▼                                        ▼
                      ┌──────────────────── LLM agent loop ───────────────────┐
                      │ OpenAI chat.completions + tools: look, graph, talk     │
                      └────────────────────────────────────────────────────────┘
                              │ validated batch edits          │ resources, questions,
                              ▼                                ▼ code pointers, interrupts
                       implementation graph ◄── statuses ── tree-sitter outline of your code
                              ▲
   typing ─► heartbeat ─► Jev triage (5 typed questions) ─► thresholds ─► LLM: interrupt or stand down
                                                         └► graph out of date ─► sync
                                                         └► stuck on a concept ─► resources
```

**The tools.** The LLM works only through tools. Every tool has a JSON Schema with enums and bounds, is validated before it runs, and returns text written for the model, such as `ok: added 'cache_get'` or `error: unknown node id 'fetch_isues'. Did you mean 'fetch_issues'?`. The model can then correct itself within the same turn.

| Family | Tools |
|---|---|
| Look (read-only) | `get_file_outline`, `read_file` (live buffer, numbered lines, secrets refused), `read_symbol` (one symbol by name), `search_code`, `list_files`, `get_diagnostics`, `get_project_context`, `get_graph`, `get_recent_edits` |
| Graph (batch edits) | `add_nodes`, `update_nodes`, `remove_nodes`, `connect`, `disconnect` |
| Talk | `recommend_resources` (links are checked), `ask_programmer` (clickable options), `point_to_code` |
| Heartbeat only | `interrupt_programmer` (once per beat), `stand_down` |

Each kind of turn gets only the tools it needs. Drafting cannot point to code that does not exist yet; a heartbeat can interrupt but not restructure the plan; offering resources to a stuck programmer can do only that. Requests for the same file queue: a message sent during a draft runs after it, and a heartbeat check gives way to anything you ask.

**The heartbeat.** A beat runs when all of these hold:
- you typed since the last beat;
- the interval has passed;
- you paused for 2 s;
- the window is focused.

Jev receives a compact state:
- the file and its docstring;
- the plan;
- the cursor's enclosing scope, with line numbers;
- the diff since the last beat;
- the diagnostics;
- the recent conversation.

It answers five questions in its official format:

| Question | Type |
|---|---|
| `interrupt` | noul |
| `issue` | choice: none, typo, syntax, logic_error, api_misuse, better_implementation, missing_edge_case, deviates_from_graph, security |
| `severity` | score over 4 described levels |
| `graph_outdated` | noul |
| `struggling` | noul |

The LLM is woken when all of these hold:
- $P(\text{interrupt}) \ge 0.65$;
- $1 - P(\text{none}) \ge 0.5$;
- $\text{severity} \ge 1.5$;
- the 90 s cooldown has passed, unless $\text{severity} \ge 2.5$.

Even then it may stand down. Repeated problems on an unchanged line are never re-raised. See [DESIGN.md](DESIGN.md).

**What leaves your machine:**
- **To the LLM endpoint:** the docstring, outlines, code you or it asks for, diffs, diagnostics and your messages.
- **To Jev:** the compact state above, which holds at most about 60 lines of the current scope and 3000 characters of diff.
- **To the recommended sites:** the link checks are `HEAD` requests to those URLs.

Files that look like secrets are never read by the tools: `.env`, keys, credentials and similar files.

## Development

```sh
cd extension
npm ci
npm run lint && npm run typecheck && npm run build
npm run test:unit           # mocha; fake OpenAI and Jev HTTP servers, no network
xvfb-run -a npm run test:integration   # the real extension in VS Code (VSCODE_EXECUTABLE=… for VSCodium)
```

Layout of `extension/src/`:
- `code/`: tree-sitter outline and module strings, edit tracking, workspace access.
- `graph/`: the graph model and its validated editor.
- `llm/`: the OpenAI agent loop, the tools, the prompts and the Jev client.
- `assistant/`: draft, chat, sync and heartbeat turns.
- `heartbeat/`: policy and runner.
- `panel/`: the webview, built with cytoscape + dagre, marked and DOMPurify.
- `controller.ts`: the VS Code wiring.

Built on these open-source projects:
- [@vscode/tree-sitter-wasm](https://github.com/microsoft/vscode-tree-sitter-wasm);
- [Cytoscape.js](https://js.cytoscape.org) with [cytoscape-dagre](https://github.com/cytoscape/cytoscape.js-dagre);
- [openai-node](https://github.com/openai/openai-node);
- [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify);
- [jsdiff](https://github.com/kpdecker/jsdiff);
- [dotenv](https://github.com/motdotla/dotenv).

## Limitations

- Languages: Python, TypeScript and JavaScript (TSX/JSX included). Other languages get no outline or graph yet.
- The Jev request and response format follows TypeSafe's public documentation. In this repository it is exercised against a faithful fake server, not the live service. Run **Test LLM and Jev Connections** after filling in your key. If your account uses a different base URL, set `ASSISTIVE_JEV_BASE_URL`.
- Quality depends on the LLM. Use a model that is good at tool calling.
