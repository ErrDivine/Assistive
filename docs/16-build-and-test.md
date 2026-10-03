# 16. Build, test and CI

This document tells how the code is built, examined and tested. It also describes the CI workflow.

## 16.1 Repository layout

```text
Assistive/
├── .env.example            the configuration template (same text as ENV_TEMPLATE)
├── .github/workflows/ci.yml
├── DESIGN.md               invariants and design decisions
├── README.md               product overview
├── docs/                   this documentation
└── extension/
    ├── package.json        manifest: commands, settings, views, scripts
    ├── esbuild.mjs         build script
    ├── eslint.config.mjs   lint rules (with the I1 rule)
    ├── tsconfig.json       host and test code
    ├── tsconfig.webview.json
    ├── media/graph.svg     activity bar icon
    ├── scripts/install-local.mjs
    ├── src/                source (refer to the Architecture document)
    └── test/
        ├── unit/           mocha unit tests
        ├── integration/    tests inside VS Code
        ├── support/        fake servers and an in-memory workspace
        └── runIntegration.ts
```

## 16.2 npm scripts

Run these scripts in the `extension/` folder.

| Script | Command | Function |
|---|---|---|
| `build` | `node esbuild.mjs` | Builds the host bundle, the webview bundle and the static files, with source maps. |
| `watch` | `node esbuild.mjs --watch` | Builds again after each change. |
| `typecheck` | `tsc -p . --noEmit && tsc -p tsconfig.webview.json --noEmit` | Type-checks the host, the tests and the webview. |
| `lint` | `eslint src test` | Runs the lint rules. |
| `test:unit` | `node esbuild.mjs --tests && mocha --timeout 10000 'out/test/unit/**/*.test.js'` | Builds and runs the unit tests. |
| `test:integration` | `node esbuild.mjs --tests && node out/test/runIntegration.js` | Builds and runs the tests inside VS Code. |
| `test` | `npm run test:unit` | The default test. |
| `install-local` | `node scripts/install-local.mjs` | Builds a production bundle and installs it (refer to [Installation](02-installation.md#222-what-the-install-script-does)). |

## 16.3 Build (`esbuild.mjs`)

The build uses esbuild. It makes these outputs:

| Output | Entry | Platform | Format | Target | Notes |
|---|---|---|---|---|---|
| `dist/extension.js` | `src/extension.ts` | Node | CommonJS | node22 | `vscode` is external. |
| `dist/webview/panel.js` | `src/panel/webview/panel.ts` | Browser | IIFE | es2022 | Includes cytoscape, dagre, marked and DOMPurify. |
| `out/test/**` | All `.ts` files in `test/` (only with `--tests`) | Node | CommonJS | node22 | `vscode`, `mocha` and `@vscode/test-electron` are external. |

The build also copies these static files:

- `src/panel/webview/index.html` and `panel.css` to `dist/webview/`;
- the tree-sitter runtime and the Python, TypeScript, TSX, JavaScript, Go, Rust and Java grammars to `dist/wasm/`.

| Flag | Effect |
|---|---|
| (none) | Source maps, no minification. |
| `--production` | Minification, no source maps. |
| `--tests` | Adds the test bundle. |
| `--watch` | Uses esbuild contexts that build again after each change. |

## 16.4 TypeScript configuration

| File | Includes | Important options |
|---|---|---|
| `tsconfig.json` | `src/**/*.ts`, `test/**/*.ts`, except `src/panel/webview/**` | `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, target ES2023, types `node`, `mocha`, `vscode` |
| `tsconfig.webview.json` | `src/panel/webview/**/*.ts`, `src/types.ts` | `strict`, DOM libraries, no global types. Thus the webview code cannot use Node.js or the VS Code API by mistake. |

## 16.5 Lint rules (`eslint.config.mjs`)

The configuration uses the recommended rules of ESLint and typescript-eslint, and adds these rules:

- **Unused variables** are errors. A parameter name that starts with `_` is permitted.
- **Invariant I1.** The rule `no-restricted-syntax` forbids:
  - a call of a member named `applyEdit`, `edit` or `insertSnippet`;
  - `new …WorkspaceEdit(…)`.

  The message is "Invariant I1: Assistive never modifies the user's buffers." The tests are exempt, because the integration tests type into documents like a programmer.

The lint ignores `dist/`, `out/`, `node_modules/` and `*.mjs` files.

## 16.6 Unit tests

The unit tests use mocha. They run in plain Node.js, without VS Code and without a network. There are more than 800 test cases.

### 16.6.1 Test support

| File | Function |
|---|---|
| `test/support/fakeServers.ts` | `FakeServers`: one local HTTP server. It answers in the OpenAI Chat Completions format at `/chat/completions` and in the Jev format at `/systemone`. It serves pages under `/docs/` for link checks, and `/docs/missing…` answers 404. It records all requests. |
| | `jevAnswers(req, values)`: makes Jev answers in the official format for each question of a request. |
| | `scriptedAssistant(base, opts)`: a fake LLM. It finds the kind of turn from the system prompt and answers with realistic tool calls, then a summary. |
| | `systemPrompt`, `lastMessage`, `toolNames`: helpers to examine the requests. |
| `test/support/memoryWorkspace.ts` | `MemoryWorkspace`: a `WorkspaceAccess` on a map of files, with glob support. |
| `test/unit/fakeClock.ts` | `FakeClock`: a manual clock for the debouncer. Timers fire only on `advance(ms)`. It stops a test that re-arms timers without end. |

### 16.6.2 Test files

| File | Subject |
|---|---|
| `outline.test.ts` | Module docstrings, tree-sitter outlines on the real grammars, the regex fallback, `formatOutline`. |
| `langs.test.ts` | Go, Rust and Java: module docstrings, symbols, stubs, imports, import resolution, `symbolName`. |
| `pyscope.test.ts` | `pythonEnclosingRange` and multi-line headers. |
| `changes.test.ts` | `renderDiff`, `changedLineCount`, `EditTracker` (with `move`). |
| `context.test.ts` | `isSecretPath`, `normalizeRel`, `numberLines`, `fileTree`, `resolveImport`, `projectSummary`. |
| `debounce.test.ts` | `Debouncer` with the fake clock. |
| `model.test.ts` | `slugify`, every `GraphEditor` method, summaries, `findSymbol`, `syncWithOutline`, `unplannedSymbols`, `orderedNodes`, `compactGraph`, `graphForJev`, `toMermaid`. |
| `schema.test.ts` | The schema validator and its corrections. |
| `agent.test.ts` | The tool-call loop against the fake server: tool calls, malformed arguments, the round budget, the temperature retry, the error messages. |
| `tools.test.ts` | Each tool with a memory workspace. |
| `jev.test.ts` | The Jev client against the fake `/systemone` server: the format, errors, timeouts, `parseAnswer`. |
| `policy.test.ts` | `JEV_QUESTIONS`, the verdicts, `decide`, `beatDue`, `describeVerdict`, `reconcileInterrupts`, `firstJsonObject`. |
| `links.test.ts` | `isWebUrl` and `checkLinks`: filters, duplicates, verification, the `GET` fallback, network failures. |
| `store.test.ts` | `GraphStore`: records, persistence, undo, feed, listeners, `move`, `moveTree`, `findOrphan`. |
| `env.test.ts` | `isPlaceholder`, `parseConfig`, `envCandidates`, `loadConfig`, `ensureEnvFile`, `ENV_TEMPLATE`. |
| `envExample.test.ts` | `.env.example` is the same text as `ENV_TEMPLATE`. |
| `setup.test.ts` | The setup wizard with a scripted UI, `chatModels`, `quoteEnvValue` (read back with `dotenv`), `setEnvValues`, and `listModels` against the fake server. |
| `assistant.test.ts` | The `Assistant` and the `Heartbeat` end to end with fake OpenAI and Jev servers, with the queue, **Stop** and `settle`. |
| `presenters.test.ts` | The text of the hover, the code lens, the status bar item, the squiggles and their quick fixes, the planned-file picker and the Markdown export. |
| `regressions.test.ts` | Tests for bugs that the test work found. |

### 16.6.3 Run the unit tests

1. Go to the `extension/` folder.
2. Run `npm run test:unit`.
3. Make sure that the last line shows "passing" and no "failing".

## 16.7 Integration tests

The integration tests run the real extension inside VS Code against the fake servers.

### 16.7.1 The runner (`test/runIntegration.ts`)

The runner does these steps:

1. It makes a scratch folder with a workspace `project/` and a configuration folder.
2. It writes these files into the workspace: an empty `wc.py`, an `existing.py` with a docstring, a `greet.go` with a package comment, a `README.md`, a `pyproject.toml`, and `.vscode/settings.json`. The workspace settings set `assistive.notifications` to `panel`, and they point `assistive.envFile` to a decoy file. The user settings in the temporary user data folder point `assistive.envFile` to the scratch `.env` file. The tests prove that VS Code ignores the decoy.
3. It starts VS Code with `@vscode/test-electron`. It uses `VSCODE_EXECUTABLE` (for example VSCodium) or downloads the version in `VSCODE_VERSION` (default `stable`).
4. It gives these arguments: the workspace, `--disable-extensions`, `--disable-workspace-trust`, `--skip-welcome`, `--skip-release-notes`, `--no-sandbox`, `--disable-gpu` and a temporary user data folder.
5. It gives the paths to the tests in `ASSISTIVE_IT_WORKSPACE` and `ASSISTIVE_IT_ENV`.
6. It deletes the scratch folders at the end and exits with the test result.

`test/integration/index.ts` runs mocha inside the extension host with a timeout of 60 seconds for each test.

### 16.7.2 The tests (`test/integration/assistive.test.ts`)

The tests start the fake servers and write the `.env` file with the fake URLs. The heartbeat interval in that file is 600 s, so only the test starts beats. They type with `editor.edit` in small pieces, like a programmer. The `type` command is not used, because it adds automatic indentation.

| Test | What it proves |
|---|---|
| ignores a workspace setting that redirects the API configuration | VS Code ignores `assistive.envFile` in workspace settings and refuses to write it there. |
| registers its commands and the panel | The commands exist and the panel opens. |
| tests the LLM and Jev connections | The connection test reaches both fake services. |
| supports Go files: the package comment is the module docstring | A Go file is supported, its package comment is the closed module docstring, and the outline finds a stub. |
| asks to save an untitled buffer before planning it | An untitled Python buffer is not planned; the panel state has `unsaved`. |
| does not draft files that are only opened | A file with a docstring that the programmer only opens does not start a draft. |
| drafts the graph once the module docstring is written | The auto-draft runs, the draft prompt contains the README, the dead link is dropped, and the panel receives the state. |
| changes the graph from an instruction and summarizes | A chat message adds a node and posts a summary. |
| undoes the last graph change | Undo removes the node. |
| lets the programmer mark a step done and remove a node without the LLM (undoable) | Direct node edits work without an LLM request, and Undo restores a removed node. |
| tracks the code the programmer types | A saved stub sets the node to `stubbed` with the correct line. |
| updates statuses while the programmer types, before a save | The live status sync sets a node to `done` while the document is not saved. |
| shows progress and the next piece in a code lens above the docstring | The code lens shows `1/3 done` and the signature of the next piece, with the `assistive.showNode` command. |
| shows the plan of a symbol on hover | The hover of a planned symbol shows "Assistive plan", its status and step, its signature and its description. |
| stays quiet on a calm heartbeat | A calm Jev verdict gives `no_action` and no feed item. Jev receives the plan. |
| interrupts on a real problem, squiggles the line, and resolves when fixed | A typo gives an interrupt, an Error squiggle with the code `typo`, and a flagged node. The squiggle has the quick fixes "Explain" and "Got it", which run commands and have no edit. The correction resolves the interrupt, removes the squiggle and sets the node to `done`. |
| exports the graph as Markdown (Mermaid and a step checklist) in a new untitled document | The export opens a `flowchart TD` and a "Steps" checklist. |
| moves a file's graph when the file or its folder is renamed in VS Code | A rename of the file, then of its folder, moves the graph and gives it the new relative path. The old paths have no graph. |
| finds the plan of a file that was renamed outside VS Code by its docstring | After `fs.renameSync`, the opened file receives the plan of the lost file and the note "Moved the plan of …". |
| creates the .env template when the configured file is missing | **Open API Configuration** creates the template, and the LLM state becomes `missing`, then `ready` again. |
| sets up the LLM with the wizard: endpoint, key, a listed model and the triage | A scripted wizard writes a new `.env` file with the endpoint of the fake server, the key, a model from its list and `ASSISTIVE_TRIAGE=llm`. The comments of the template stay, and the LLM becomes `ready`. |
| never modified the programmer's buffer (I1) | The extension made no change to the buffer that the test did not type. |

### 16.7.3 Run the integration tests

1. Go to the `extension/` folder.
2. On Linux without a display, run `xvfb-run -a npm run test:integration`. On macOS or Windows, run `npm run test:integration`.
3. To use VSCodium, set `VSCODE_EXECUTABLE` to the path of the VSCodium program first.

## 16.8 CI (`.github/workflows/ci.yml`)

The workflow runs on each push and each pull request. A new run on the same branch cancels the old run.

| Item | Value |
|---|---|
| Operating systems | `ubuntu-latest` and `macos-latest` (each one runs to the end, also if the other fails) |
| Node.js | 22, with the npm cache |
| Folder for the commands | `extension/` |

The steps are:

1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run build`
5. `npm run test:unit`
6. Linux: `xvfb-run -a npm run test:integration`. macOS: `npm run test:integration`.

## 16.9 Procedure: examine a change before a commit

1. Go to the `extension/` folder.
2. Run `npm run lint`.
3. Run `npm run typecheck`.
4. Run `npm run build`.
5. Run `npm run test:unit`.
6. If the change touches the controller, the panel or the activation, run the integration tests.
7. If you changed `ENV_TEMPLATE`, copy the same text to `.env.example`.
