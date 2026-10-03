# 15. Controller (`src/controller.ts`, `src/extension.ts`)

This document describes how Assistive connects to VS Code. The `Controller` class owns all parts. It listens to the editor events and keeps the configuration. It shows the interrupts as squiggles and updates the status bar. It also handles the commands and the panel messages.

> **Note:** The controller never edits the buffers of the programmer (invariant I1). **Copy signature** uses the clipboard. **Export** opens a new untitled document.

## 15.1 Activation (`extension.ts`)

### 15.1.1 Activation events

VS Code activates the extension on these events (from `package.json`):

- `onLanguage:python`, `onLanguage:typescript`, `onLanguage:javascript`;
- `onStartupFinished`.

### 15.1.2 `activate(context)`

The function does these steps:

1. It makes a `Controller`.
2. It registers the 16 commands:

   | Command ID | Controller call |
   |---|---|
   | `assistive.focus` | `panel.reveal()` |
   | `assistive.ask` | `panel.reveal("")` (focus the input box) |
   | `assistive.draftGraph` | `draft()` |
   | `assistive.syncGraph` | `sync()` |
   | `assistive.undoGraph` | `undo()` |
   | `assistive.clearGraph` | `clear()` |
   | `assistive.stop` | `stop()` |
   | `assistive.clearConversation` | `clearConversation()` |
   | `assistive.openPlannedFile` | `openPlannedFile()` |
   | `assistive.showNode` | `showNode(id)` (from the code lens; hidden in the palette) |
   | `assistive.heartbeatNow` | `beatNow()` |
   | `assistive.toggleHeartbeat` | `toggleHeartbeat()` |
   | `assistive.exportGraph` | `exportGraph()` |
   | `assistive.setup` | `setup()` |
   | `assistive.openConfig` | `openConfig()` |
   | `assistive.testConnection` | `showConnectionTest()` |

3. It adds the controller to `context.subscriptions`, so VS Code disposes it.
4. It returns `{controller}` as the extension API. The integration tests use this API.

`showConnectionTest()` shows the progress "Assistive: testing the LLM and Jev connections…" and calls `testConnection()`. Then it shows the result lines in one notification. A line can contain "error", "rejected", "not configured", "could not" or "did not". Then the notification is a warning with the buttons **Set Up…** and **Open .env**.

`deactivate()` does nothing. The disposables clean up.

## 15.2 Configuration and clients

### 15.2.1 Constructor

The constructor makes these objects, in this order:

1. The output channel "Assistive" (a log channel).
2. The `GraphStore` in the workspace storage folder (or the global storage folder).
3. The `TreeSitter` with `dist/wasm/`.
4. The diagnostic collection "Assistive".
5. The status bar item (right side, priority 90, command `assistive.focus`).
6. Four debouncers:
   - the panel refresh (60 ms);
   - the live status sync (800 ms);
   - the auto-draft (2.5 s);
   - the interrupt reconcile (400 ms).
7. The configuration and the clients (`reloadConfig`).
8. The `Assistant`, the `Heartbeat` and the `PanelProvider`.
9. The event listeners and the disposables.
10. The `.env` watchers.

Then it tracks the open documents, sets the active editor, starts the heartbeat and shows the status bar item.

### 15.2.2 `reloadConfig()`

1. It calls `loadConfig(envCandidates(setting, extensionPath))`.
2. It makes an `Llm` if `llmReady` is true, and a `JevClient` if `jevReady` is true. Otherwise, the client is `undefined`.
3. It clears the last LLM and Jev errors.
4. It writes one line with the source, the model, the triage and the interval to the log. It writes each problem as a warning.
5. If the source file changed, it makes new watchers.
6. It refreshes the panel.

### 15.2.3 Reload triggers

| Event | Action |
|---|---|
| The programmer saves the `.env` file in the editor | `reloadConfig()` |
| A watcher reports a change, a creation or a deletion of a candidate `.env` file | `reloadConfig()` |
| A setting that starts with `assistive.` changes | `reloadConfig()` and a panel refresh |

`watchEnv()` makes one file system watcher for each candidate location. Each watcher watches one file name in its folder.

### 15.2.4 `openConfig()`

1. The target is the file that the configuration came from, or the first candidate.
2. `ensureEnvFile(target)` creates the file from the template if it does not exist.
3. The controller opens the file in an editor (not a preview).
4. If there was no file before, it reloads the configuration.

### 15.2.5 `setup(ui?)`

The setup wizard (refer to [Configuration](03-configuration.md#367-the-setup-wizard-setupts)). The method does these steps:

1. It calls `runSetup` with the current values. The UI is `vsSetupUi`: `showQuickPick` and `showInputBox`, which stay open when the focus moves. The tests give a scripted UI.
2. It lists the models with a progress notification "Assistive: listing the models of `<url>`…". It sends the extra headers only to the endpoint that they were configured for, because they can contain credentials.
3. If the programmer cancels, it returns `false`.
4. It writes the values with `setEnvValues` to the current `.env` file, or to a new file from the template.
5. It writes the names of the keys (not the values) to the log. If a process environment variable overrides a written key, it shows a warning (refer to [3.2.6](03-configuration.md#326-process-environment)). Then it reloads the configuration.
6. It calls `showConnectionTest()` and returns `true`.

## 15.3 Files and outlines

### 15.3.1 Supported documents

`supported(doc)` returns `true` if the document scheme is `file` and the language ID is in the setting `assistive.languages`. Untitled buffers are not supported: the store keeps graphs by path, and VS Code reuses untitled names such as `Untitled-1`. For an untitled buffer in a supported language, the panel state has `unsaved: true`, and the panel asks the programmer to save the file.

### 15.3.2 Workspaces and handles

- `wsFor(uri)` returns the `VsWorkspace` of the workspace folder that contains the file. If the file is not in a workspace folder, the root is the folder of the file. The controller keeps one `VsWorkspace` for each root.
- `handleFor(doc)` makes a `FileHandle` (refer to [Assistant turns](12-assistant.md#1211-inputs)). The cursor line comes from a visible editor of the document.
- `handle()` returns the handle of the active document, if it is open and supported.

### 15.3.3 The active document

`onActiveEditor(editor)` decides which file the panel shows:

- If there is no editor (the focus moved to the panel or to a different view), the panel keeps the last file.
- If the new document is not supported and the last document is still open, the panel keeps the last document. Thus the programmer can read documentation and keep the plan in view. An untitled buffer in a supported language is an exception: the panel shows it, with the request to save it.
- In all other cases, the new document becomes the active document. The controller tracks it and refreshes the panel. Then it calls `adoptOrphan` (refer to [15.3.6](#1536-renamed-files)).

### 15.3.4 Outline cache

`outlineOf(rel, text, language?)` keeps a cache of outlines. The key is `language:path`. A cache hit needs the same text. The cache keeps a maximum of 60 entries. When it is full, it removes the oldest entry. If the language is not given, the controller finds it from the file extension.

### 15.3.5 Document tracking

`track(doc)` calls `edits.open(key, text)` for each supported document. This sets the two baselines of the `EditTracker` the first time.

### 15.3.6 Renamed files

The store keeps graphs by absolute path. Thus the controller moves the records when a file moves.

**Renames in VS Code.** `onRename(event)` receives `workspace.onDidRenameFiles`. For each renamed file or folder with the `file` scheme, it does these steps:

1. It finds the keys at or in the old path, from the saved graphs and from memory.
2. It calls `assistant.settle` for each key and waits.
3. It calls `store.moveTree(old, new, relOf)`. `relOf` is `relPath`, the workspace-relative path with forward slashes.
4. For each move, it calls `edits.move` and writes "graph moved" to the log.

**Renames outside VS Code.** `git mv`, a terminal or a branch switch do not cause a rename event. `adoptOrphan(doc)` runs when a supported document becomes active. It does these steps:

1. It stops if the file has a graph with nodes. It also stops if it examined the path before in this session (the set `orphanChecked`).
2. It reads the module docstring. It stops if the docstring is not closed or is shorter than 15 characters.
3. It calls `store.findOrphan(docstring, language, fs.existsSync)`. It stops if there is no single plan.
4. It calls `assistant.settle` for the old key. Then it calls `store.move` and `edits.move`.
5. It adds the system note "Moved the plan of `<old path>` here: that file no longer exists, and its docstring is the same as this file's."

If a rename event and `adoptOrphan` both try to move a record, the second `move` finds no record and does nothing.

## 15.4 Edits and auto-draft

### 15.4.1 `onDocChange(event)`

For each change of a supported document, the controller:

1. computes the touched lines: from the start line of each change to the start line plus the number of new lines (maximum 50 lines);
2. calls `edits.edited(key, lines)`;
3. if the document is the active document: refreshes the panel, records the first touched line for the auto-draft, and triggers the auto-draft and live sync debouncers;
4. triggers the interrupt reconcile debouncer.

### 15.4.2 `maybeAutoDraft()`

This method runs 2.5 seconds after the last change. It drafts only if all of these conditions are true:

1. There is an active supported file.
2. The setting `assistive.autoDraft` is `true`.
3. The LLM is configured.
4. No turn runs for the file.
5. The file has no graph with nodes.
6. The module docstring is closed and has 15 characters or more (`MIN_DOCSTRING_CHARS`).
7. The first touched line is not more than one line after the end of the docstring. Thus a change far below the docstring does not start a draft.
8. The controller did not try a draft for the same file and the same docstring text before. The set `drafted` records each attempt. Thus a failed draft does not repeat in a loop. The **Draft** button can always try again.

### 15.4.3 `onSave(doc)`

- If the saved document is the `.env` file, the controller reloads the configuration.
- If the document is supported and has a graph, the controller calls `assistant.localSync`. The statuses then follow the saved code.

## 15.5 Interrupts

### 15.5.1 Reconcile

`reconcileInterrupts()` runs 400 ms after the last change. For each open document with open interrupts, it calls `reconcileInterrupts(feed, lines)` from `policy.ts`:

- A resolved interrupt goes to `closeInterrupt(key, id, "resolved")`.
- A moved interrupt receives its new line.

### 15.5.2 `closeInterrupt(key, id, status)`

If the interrupt is open, the controller sets its status to `resolved` or `dismissed`. For a dismissal, it calls `heartbeat.noteDismissed` with the issue kind. Then it calls `assistant.unflag` to clear the node flag.

### 15.5.3 Squiggles

`renderDiagnostics(key)` makes one `vscode.Diagnostic` for each open interrupt of the file. The values come from the presenters `interruptRange`, `diagnosticLevel` and `diagnosticMessage` (refer to [15.9](#159-presenters)):

| Property | Value |
|---|---|
| Range | From the first non-space character of the start line to the end of the end line. The range is at least one character long. It never ends before the start line. |
| Severity | 3 → Error, 2 → Warning, 1 → Information. |
| Message | `<title>: <message as plain text>`. The function `plain` removes code blocks, Markdown characters and link targets, and joins the lines. |
| Source | `Assistive` |
| Code | The issue kind, for example `typo`. |

`VsWorkspace.diagnostics` ignores the source `Assistive`. Thus the LLM never sees its own interrupts as diagnostics.

### 15.5.4 Notifications

`maybeToast(key)` examines each open interrupt one time:

1. If the interrupt is older than 120 seconds, it was restored from an earlier session. The controller does not show it again.
2. It calls `heartbeat.noteInterrupt(key)`, so that the cooldown starts.
3. If the panel is visible, or `assistive.notifications` is `panel`, it shows nothing more.
4. If not, it shows a notification: a warning for severity 3 and an information message for the other severities. The text is `Assistive: <title> (line <n>)`. The buttons are **Show**, **Explain** and **Got it**.

## 15.6 State for the panel and the status bar

### 15.6.1 Store changes

When the store reports a change for a file, the controller:

1. draws the squiggles of the file again;
2. examines the new interrupts for notifications;
3. updates the status bar item;
4. refreshes the panel if the file is the active file.

### 15.6.2 Beat reports

`onBeat(report)` keeps the report as the last beat. A `skipped` report without a verdict does not replace the last beat, so the tooltip keeps the last verdict. It also keeps the error state of each service:

- An error that contains "jev" marks Jev as failed. A different error marks the LLM as failed.
- A verdict from Jev clears the Jev error.
- A verdict from the LLM, or an outcome that is not `no_action`, clears the LLM error.

### 15.6.3 `status()`

| Field | Value |
|---|---|
| `llm` | `missing` if not configured, `error` after a failure, else `ready`. |
| `jev` | `off` if the triage is not `jev`, `missing` if not configured, `error` after a failure, else `ready`. |
| `heartbeat` | `on` if the setting is on and the triage is not `off`, else `paused`. |
| `heartbeatSeconds` | The interval in seconds. |
| `lastBeat`, `lastVerdict` | From the last beat report. `lastVerdict` is the error, if there was one. |
| `busy` | The busy label of the active file. |
| `configPath` | The `.env` file in use. |
| `llmModel` | The model name, if the LLM is configured. |
| `llmUsage` | `sessionUsage()`: the requests and tokens of this session. When `reloadConfig` replaces the LLM client, it first adds the `usage` of the old client to `pastUsage`. Thus the total continues over reloads. |

### 15.6.4 `buildState()` and `pushState()`

`buildState()` makes the `PanelState`:

- If the active document is not supported, the state has the file name, the language, an empty feed and `supported: false`.
- If not, the state has the module docstring and its `closed` flag (from the outline), the graph, the feed, the status, `canUndo` and `supported: true`.

`pushState()` sends the state to the panel. It runs 60 ms after the last refresh trigger. The property `lastPanelState` gives the last state to the tests.

### 15.6.5 Status bar item

`updateStatusItem()` gives the busy label, the number of open interrupts and the graph to the presenter `statusView`. It sets the text, the tooltip and the background from the result.

| Condition | Text | Background |
|---|---|---|
| A turn runs | Spinner and the busy label | Default |
| Open interrupts | Graph icon, warning icon, number | Warning color |
| Other | Graph icon, and `done/total` if the file has a graph | Default |

### 15.6.6 Streamed replies

The Assistant calls `setStreaming(key, text)` while the LLM writes a reply. `streamToPanel` keeps the latest text and sends it to the panel a maximum of one time in 80 ms, as a `stream` message. It sends the end of the stream (no text) at once, for any file, so that a reply never stays on screen. It sends no text for a file that is not the active file.

### 15.6.7 Live status sync

The live sync runs 800 ms after the last change to the active file. If the file has a graph with nodes, it calls `assistant.localSync`. Thus the statuses follow the code while the programmer types, without a save and without the LLM.

### 15.6.8 Editor hover

The controller registers a hover provider for all `file` and `untitled` documents. `hover(doc, position)` does these steps:

1. It returns nothing if the document is not supported or has no graph.
2. It finds the word at the position.
3. It calls `nodeForWord(graph, outline, word, line)` (refer to [Graph model](08-graph-model.md#856-nodeforwordgraph-outline-word-line)).
4. It makes a Markdown hover from the presenter `hoverMarkdown`. The hover has "**Assistive plan**", the status and the step number. Then it has the signature as a code block in the language of the file. Last, it has the description, the notes and the attention reason.

The hover only reads data. It does not change the document (invariant I1).

### 15.6.9 Code lens

The controller registers a code lens provider for all `file` and `untitled` documents. `codeLenses(doc)` returns nothing if the document is not supported, has no graph, or `assistive.codeLens` is `false`. Else it returns two lenses on the first line of the module docstring. The presenter `lensItems` gives their titles and commands:

- "Assistive: done/total done", with the command `assistive.focus`;
- "Next: signature" of the next piece, with the command `assistive.showNode` and the node ID. If all pieces are done, the second lens says so.

Each store change fires `onDidChangeCodeLenses`, so the lenses follow the code. `showNode(id)` calls `PanelProvider.revealNode`, which opens the panel, waits for the webview, and sends `selectNode`. The palette hides `assistive.showNode`.

## 15.7 Actions

### 15.7.1 `run(fn)`

All assistant actions go through `run`. If the action succeeds, `run` clears the LLM error. If it fails, `run` keeps the error message (the LLM pill becomes red) and writes it to the log. The Assistant already added the error note to the feed. At the end, `run` refreshes the panel.

### 15.7.2 Commands

| Method | Behavior |
|---|---|
| `draft()` | `Assistant.draft` for the active file. |
| `sync()` | `Assistant.sync` for the active file. |
| `send(text)` | `Assistant.chat` with the trimmed text, if the text is not empty. |
| `undo()` | `GraphStore.undo`. Shows "Assistive: nothing to undo." if the history is empty. |
| `clear()` | Asks for confirmation in a modal dialog, then `GraphStore.clear`. |
| `stop()` | `Assistant.cancel` for the active file. The **Stop** button sends the same request. |
| `clearConversation()` | Asks for confirmation in a modal dialog, then `GraphStore.clearFeed`. |
| `editNode(id, op)` | A direct edit without the LLM. `remove` removes the node and its edges. `toggleDone` changes a `step` or `external` node between `done` and `planned`. It does nothing for code nodes, because the code sets their status. The edit goes through a `GraphEditor`, and the store keeps the previous graph for **Undo**. |
| `openPlannedFile()` | Shows a quick pick of the files from `GraphStore.plannedFiles()` that still exist, newest first. Each item shows the path, the progress, the next piece and the first line of the docstring. Opens the file that the programmer selects. |
| `beatNow()` | `Heartbeat.beat` for the active file. Returns the report. |
| `toggleHeartbeat()` | Changes the user setting `assistive.heartbeat.enabled`. Shows "Assistive heartbeat paused" or "resumed" in the status bar for 2.5 seconds. |
| `exportGraph()` | Opens a new untitled Markdown document beside the editor. The presenter `graphMarkdown` makes the text (refer to [15.9](#159-presenters)). |
| `testConnection()` | Sends one LLM request and one Jev request. Returns one line for each service. |
| `goto(line, endLine?, rel?, key?)` | Opens the active file, or `rel` in the same workspace. Keeps the lines in the file. Puts the cursor at the start of the range. Shows the range in the center if it is not visible. |

All commands that need a file call `requireFile()`. If there is no supported file, it shows "Assistive: open a Python, TypeScript, JavaScript, Go, Rust or Java file first."

### 15.7.3 Panel messages

`panelMessage(message, key)` handles each `FromPanel` message (refer to [Panel](14-panel.md#1432-webview-to-host-frompanel)). Some messages need extra steps:

- **`dismiss`:** finds the interrupt in all records and closes it as dismissed.
- **`explain`:** finds the interrupt and its open document, opens the panel, and runs `Assistant.explain`.
- **`answer`:** finds the question and its open document, records the answer in the question item, and sends the chat message `Answer to "<question>": <option>`.
- **`openLink`:** opens the URL only if it starts with `http://` or `https://`.
- **`copy`:** writes the text to the clipboard and shows "Copied to the clipboard" in the status bar for 2 seconds.

## 15.8 Disposal

`dispose()` disposes each disposable and continues if one fails. The disposables do these steps:

- They stop the heartbeat timer.
- They flush the store.
- They cancel the four debouncers.
- They remove the watchers, the listeners, the diagnostic collection, the status bar item, the output channel and the panel.

## 15.9 Presenters

The module `editor/presenters.ts` makes the text that the editor shows. It does not import `vscode`. Thus the unit tests (`presenters.test.ts`) examine the text without VS Code. The controller changes each result into a VS Code object.

| Function | Result |
|---|---|
| `hoverMarkdown(graph, node, language)` | The Markdown of the hover (refer to [15.6.8](#1568-editor-hover)). |
| `lensItems(graph)` | The title, the command, the arguments and the tooltip of each code lens. The result is empty if the graph has no typed pieces. |
| `statusView({busy, open, graph})` | The text, the tooltip and the `warning` flag of the status bar item. |
| `interruptRange(f, firstText, lastText)` | The lines and columns of a squiggle. |
| `diagnosticLevel(severity)` | `error` for 3, `warning` for 2, `information` for 1. |
| `diagnosticMessage(f)` | `<title>: <message as plain text>`. |
| `plannedFileDescription(graph)` | The progress and the next piece, for the planned-file picker. |
| `graphMarkdown(graph)` | The Markdown export. Refer to the subsequent list. |
| `escapeMarkdown(text)`, `plain(markdown)`, `codeBlock(code, language)` | Helpers. `codeBlock` makes the fence longer than each run of backticks in the code. |

`graphMarkdown` makes a document with these parts:

1. The title "Implementation graph: `<file>`".
2. The docstring, as a quote.
3. The progress and the next piece, if the graph has typed pieces.
4. The Mermaid text from `toMermaid`, in a code fence.
5. The heading "Steps" and a numbered checklist. The checklist has all nodes except the module node, in typing order. Each item has a box (`[x]` for done), the label, the kind and the signature. Under the item are the description, the notes and the attention reason.

The export is raw text that the programmer reads. Thus it does not escape the Markdown characters. It joins the lines of each text and changes `<` to `&lt;`, so that the text cannot add HTML or break the list.
