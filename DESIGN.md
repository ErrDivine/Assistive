# Assistive: design notes

## Goal

A side panel holding an implementation graph that a programmer and an LLM build together, for a programmer who is still learning:
- the graph is drafted from the module docstring the programmer writes, using the project context;
- the programmer steers it with plain-language instructions;
- the programmer types every line of code;
- the graph tracks that code as it appears;
- a heartbeat triaged by Jev, a System One model, watches at a calm interval and interrupts only when something matters.

When a concept is the obstacle, the panel offers a few checked learning resources.

## Invariants

| ID | Rule | Enforced by |
|---|---|---|
| I1 | Never modify the programmer's buffers. **Copy signature** uses the clipboard; **Export** opens a new untitled document. | eslint `no-restricted-syntax` (no `applyEdit`/`edit`/`insertSnippet`/`WorkspaceEdit` in `src/`); integration test "never modified the programmer's buffer" |
| I2 | The LLM changes the graph only through validated tools. | `GraphEditor`: every batch item returns `ok …` or `error …`; schema check before any tool runs |
| I3 | Interruptions are rare and earned. | Jev thresholds, cooldown, one interrupt per beat, no repeats for an unchanged line, `stand_down` |
| I4 | Secrets are never sent. | The tools refuse `.env`, keys and credential files (`isSecretPath`); the `.env` is created with mode 600 and is git-ignored |
| I5 | Typing is never blocked. | All network work is async; the heartbeat runs only after a 2 s pause and never twice at once; webview updates are debounced |

## Components (`extension/src/`)

| Module | Role |
|---|---|
| `code/outline.ts` (+ `treesitter.ts`) | Module string (closed or still being typed), symbols with qualnames, ranges, signatures, docstrings and stub detection, imports. Uses tree-sitter WASM grammars, with an indentation-based Python fallback. |
| `code/changes.ts` | `EditTracker`: two baselines per file (last heartbeat, graph creation) and diffs with new-file line numbers |
| `code/context.ts`, `code/workspace.ts` | `WorkspaceAccess` (list, read the live buffer, search, diagnostics) and the project summary for drafts |
| `graph/model.ts` | `GraphEditor` (batch add/update/remove/connect/disconnect with did-you-mean errors), outline sync, attention flags, renderings for prompts, Jev and Mermaid |
| `llm/agent.ts` | Chat Completions loop with tools: `tool_choice: auto` for each round, then `tool_choice: none` once the budget is spent. Retries without `temperature` when a model rejects it. Errors are explained in terms of the `.env` settings. |
| `llm/tools.ts`, `llm/schema.ts` | The tools: JSON Schemas, validation, a per-mode tool set |
| `llm/jev.ts` | Jev client: `POST {base}/systemone` with `{model, state, questions}`. Answers are normalized to `noul` / `choice` / `score`. |
| `llm/prompts.ts` | The persona (senior engineer, never writes the implementation) and per-mode instructions |
| `assistant/Assistant.ts` | Draft, chat, sync, heartbeat escalation and struggling turns. Shows graph edits live; rolls back on failure or Stop; one turn per file at a time, with programmer requests queued and heartbeat turns giving way. |
| `heartbeat/policy.ts`, `heartbeat/Heartbeat.ts` | Jev questions, verdicts, decisions, timing, interrupt reconciliation, and the runner |
| `store/GraphStore.ts` | Per-file graph, feed (last 200 items) and undo history (last 20 revisions), stored as JSON in workspace storage |
| `panel/` | Webview built with cytoscape + dagre (graph), a steps list, node details, a markdown feed (marked + DOMPurify) and the input box |
| `controller.ts` | Ties it to VS Code: active file, auto-draft, `.env` watching, squiggles, status bar, toasts, commands |

## Decisions

**D1. TypeScript only.** Everything the product needs runs inside the extension host: parsing via tree-sitter WASM, and plain HTTP to the LLM and to Jev. There is no second process to install, start or restart. This replaces the earlier design that used a Python server.

**D2. The graph is the shared artifact.** A node is something to type (or an external dependency), with a symbol, a signature, a description, notes and a typing order. Status is derived from the code, not set by the model:
- planned: the symbol is missing;
- stubbed: the body is `pass`, `...`, `raise NotImplementedError`, an empty `{}`, or `throw "not implemented"`;
- done: the body is real;
- attention: set by an interrupt, cleared when the interrupt resolves or is dismissed.

**D3. How the tools are designed:**
- Few, orthogonal tools.
- Batch arguments, such as `add_nodes{nodes:[…]}`, so a draft takes 2–3 calls.
- Enums for kinds, issues, severities and resource types.
- Results the model can act on: per-item `ok`/`error` lines, "Did you mean", running totals, and paging hints.
- Unknown fields are dropped with a note instead of failing.
- Lines are 1-based at the tool boundary and 0-based inside.
- Each mode gets a subset of the tools:

  | Mode | Tools |
  |---|---|
  | draft | look, graph edits, resources, questions |
  | chat | everything except the heartbeat tools |
  | sync | look and graph edits |
  | heartbeat | look, `update_nodes`, resources, `interrupt_programmer`, `stand_down` |
  | struggling | look, resources |

**D4. The draft gets the context up front.** The first message already contains:
- the docstring;
- the outline;
- the file tree;
- the manifests (`pyproject.toml`, `package.json`, …);
- the head of the README;
- the outlines of imported local modules;
- the docstrings of sibling modules.

The model is told to look at no more than 4 more files, which keeps drafts to about 2–3 round trips.

**D5. Jev is the System One; the LLM is the System Two.** Each beat sends one Jev request (latency 70–500 ms) with five parallel typed questions; the LLM is consulted only when the answers justify it. In the decision rules below:
- $p_i$ is Jev's $P(\text{interrupt})$ and $\tau$ the interrupt threshold;
- $p_\varnothing$ is the probability that Jev's `issue` answer is `none`;
- $s \in [0,3]$ is the severity score, the probability-weighted mean of the level numbers.

Escalation needs all of:
- $p_i \ge \tau$, with $\tau = 0.65$ by default;
- $1 - p_\varnothing \ge 0.5$;
- $s \ge 1.5$.

A 90 s cooldown follows an interrupt; when $s \ge 2.5$, the problem comes through anyway. A graph sync needs $P(\text{graph\_outdated}) \ge 0.7$ and is limited to once every 3 minutes. Resource suggestions need $P(\text{struggling}) \ge 0.75$, are limited to once every 5 minutes, and never accompany an interrupt. With `ASSISTIVE_TRIAGE=llm`, a JSON verdict from the LLM replaces Jev, so the product works without a Jev key.

**D6. How the heartbeat is timed.** The minimum interval is 15 s and the default 45 s. A beat runs only when all of these hold:
- there were edits since the last beat;
- the programmer has paused for 2 s;
- the window is focused.

The diff baseline moves to the text that was triaged, so typing done during an escalation shows up in the next beat.

**D7. How interrupts are delivered:**
- a feed card with Show line, Explain more and Got it;
- a `vscode.Diagnostic` from source "Assistive" on the flagged range, with severity mapped from 1–3 to Information, Warning or Error;
- a status bar badge;
- a toast when the panel is hidden, if enabled;
- an attention flag on the graph node that contains the line.

An interrupt whose line text changes is resolved. One whose line only moved, because lines were inserted above it, follows the line.

**D8. Resources are verified before they are shown.** Links are checked with `HEAD`, falling back to a 1-byte ranged `GET`. Links that answer 404/410, and URLs that are not http(s), are dropped and the model is told which ones. Links that cannot be checked are kept and marked "link not checked". Links open through `vscode.env.openExternal`.

**D9. Configuration lives in a `.env` with placeholders.**
- The values `REPLACE_ME`, `YOUR_…`, `<…>` and empty strings count as unset.
- `.env.example` is identical to the template the extension writes; a unit test checks this.
- The file is watched, so a change takes effect when it is saved.
- `ASSISTIVE_*` process variables override the file, for CI and containers.

**D10. Rendering.** The graph uses Cytoscape.js with the dagre layout, top to bottom:
- node shapes encode the kind;
- borders and fills encode the status, using the VS Code theme's chart colors;
- the layout re-runs only when the set of nodes or edges changes.

The Steps tab lists the same nodes in typing order: first by explicit `order`, then dependencies before dependents.

## Verification

- **Unit tests** (`npm run test:unit`, offline) cover:
  - the outline on real tree-sitter grammars;
  - the graph editor;
  - the schema validator;
  - every tool;
  - the agent loop against a fake OpenAI server: tool calls, malformed arguments, budget exhaustion, the temperature retry, error mapping;
  - the Jev client against a fake `/systemone` server, including errors and timeouts;
  - the heartbeat policy;
  - link checks;
  - the store;
  - the configuration;
  - the Assistant and Heartbeat end to end.
- **Integration tests** (`npm run test:integration`) run the real extension in VS Code against fake servers:
  - auto-draft after typing a docstring;
  - instruction, then summary;
  - undo;
  - status tracking on save;
  - a calm heartbeat;
  - interrupt, then squiggle, then node flag, then resolution after the fix;
  - Mermaid export;
  - `.env` template creation;
  - the I1 buffer check.
- **Not verified here:**
  - the live Jev service, whose documentation domain is not reachable from the build environment. The format follows TypeSafe's published examples: `questions` keyed by name, `criteria` per type, and `score` answers as a probability-weighted mean of 0-based levels.
  - a live LLM provider.

  **Test LLM and Jev Connections** checks both once the keys are filled in.
