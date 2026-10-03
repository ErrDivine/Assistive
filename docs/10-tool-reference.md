# 10. Tool reference (`src/llm/tools.ts`)

This document describes each tool that the LLM can use. There are 19 tools in four families. For each tool, the document gives the purpose, the modes, the parameters, the result and the errors.

## 10.1 Design rules

The tools follow decision D3 in `DESIGN.md`:

- **Few, orthogonal tools.** Each tool does one job. No two tools do the same job.
- **Batch arguments.** One call can add many nodes or edges. A draft takes 2 or 3 calls.
- **Enums.** Node kinds, edge kinds, issue kinds, severities and resource types are closed lists. The model cannot invent values.
- **Results that the model can act on.** Each graph item gives one `ok:` or `error:` line. Errors include a "Did you mean" hint, the list of valid values, or the next step. Graph tools add the totals of nodes and edges. Read tools tell the model how to read the next page.
- **Tolerance.** The validator removes unknown fields and tells the model about them. It does not fail the call.
- **1-based lines.** Lines are 1-based in all arguments and results. The code changes them to 0-based inside.
- **A subset for each mode.** Each kind of turn receives only the tools that it needs.
- **Text results.** Each tool returns plain text for the model to read.

## 10.2 Tool sets for each mode

`toolsFor(mode, env)` returns the tools of a mode. The modes are `draft`, `chat`, `sync`, `heartbeat` and `struggling` (the struggle turn).

| Tool | Family | draft | chat | sync | heartbeat | struggling |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `get_file_outline` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `read_file` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `read_symbol` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `search_code` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `list_files` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `get_diagnostics` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `get_project_context` | Look | | ✓ | ✓ | ✓ | ✓ |
| `get_graph` | Look | ✓ | ✓ | ✓ | ✓ | ✓ |
| `get_recent_edits` | Look | | ✓ | ✓ | ✓ | ✓ |
| `add_nodes` | Graph | ✓ | ✓ | ✓ | | |
| `update_nodes` | Graph | ✓ | ✓ | ✓ | ✓ | |
| `remove_nodes` | Graph | ✓ | ✓ | ✓ | | |
| `connect` | Graph | ✓ | ✓ | ✓ | | |
| `disconnect` | Graph | ✓ | ✓ | ✓ | | |
| `recommend_resources` | Talk | ✓ | ✓ | | ✓ | ✓ |
| `ask_programmer` | Talk | ✓ | ✓ | | | |
| `point_to_code` | Talk | | ✓ | | | |
| `interrupt_programmer` | Heartbeat | | | | ✓ | |
| `stand_down` | Heartbeat | | | | ✓ | |

The reasons for the differences are:

- A draft receives the project context in its first message. Thus it does not need `get_project_context`. It has no edits to examine, and no code to point to.
- A sync only changes the graph. It does not talk to the programmer.
- A heartbeat can interrupt and flag nodes, but it cannot change the structure of the plan.
- A struggle turn can only look and recommend resources. It cannot interrupt and it cannot change the graph.

## 10.3 The tool environment (`ToolEnv`)

The Assistant gives each tool an environment. The tools use only this environment.

| Member | Function |
|---|---|
| `ws` | The `WorkspaceAccess` of the file. |
| `file` | The workspace-relative path of the current file. |
| `language` | The language ID of the current file. |
| `liveText()` | The current text of the file, with unsaved edits. |
| `outlineOf(rel, text)` | The outline of a file (with the controller cache). |
| `editor` | The `GraphEditor` of this turn. |
| `edits` | The `EditTracker`. |
| `checkLinks(items)` | The link check. |
| `emit(item)` | Adds an item to the feed of the panel. Returns `false` if the item was not added because it is a duplicate. |
| `feed()` | The feed of the file. The tools use it so that they do not repeat what the programmer saw. |
| `plannedOf(rel)` | The signatures that the graph of a different file plans but that are not typed yet. |

### 10.3.1 Path rules of the look tools

The look tools that accept a `path` resolve it in this way:

1. An absent or empty path means the current file.
2. `normalizeRel` changes the path to a workspace-relative path. If the path escapes the workspace, the result is `error: 'x' is outside the workspace. Use a workspace-relative path such as 'wc.py'.`
3. If the path looks like a secret, the result is `error: '.env' looks like a secrets or credentials file; it is never read.`
4. For the current file, the tool uses the live text. For other files, it uses `ws.read`, which also prefers an open buffer.

## 10.4 Look tools

### 10.4.1 `get_file_outline`

**Purpose:** Show the outline of a source file: the module docstring, the imports, and each class, function, method and constant with its line range, signature, first docstring line and stub flag. This is the cheapest way to see what exists.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `path` | string | | | A workspace-relative path. Omit it for the current file. |

**Result:**

```text
wc.py (24 lines)
Module docstring (L1-1):
Count the most common words in a text file and print them.

imports: collections
L5-7 def parse_line(line: str) -> list[str]
    "Split one line into lowercase words."
```

**Errors:** `error: no file 'x'. Use list_files to find the right path.` and the path errors.

### 10.4.2 `read_file`

**Purpose:** Read lines of a file with 1-based line numbers. For the current file, the text includes unsaved edits.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `path` | string | | | A workspace-relative path. Omit it for the current file. |
| `start_line` | integer | | ≥ 1 | The first line. The default is 1. |
| `end_line` | integer | | ≥ 1 | The last line, inclusive. |

The tool returns a maximum of 400 lines. If `start_line` is after the end of the file, the tool uses the last line.

**Result:**

```text
wc.py lines 1-400 of 512:
  1| """Count the most common words in a text file and print them."""
  2|
…
(112 more lines; call again with start_line=401)
```

**Errors:** `error: no file 'x'. Use list_files to find the right path.` and the path errors.

### 10.4.3 `read_symbol`

**Purpose:** Read the code of one class, function, method or constant by its name, with 1-based line numbers. This is more precise than `read_file` when the model knows what it wants to see.

| Parameter | Type | Required | Rules | Meaning |
|---|---|:-:|---|---|
| `symbol` | string | ✓ | Not empty | The name as the outline shows it, for example `parse_args` or `Cache.get`. A keyword at the start (`def`, `class`, `function`) and a parameter list are ignored. |
| `path` | string | | | A workspace-relative path. Omit it for the current file. |

The tool finds the symbol by its exact dotted name first. If there is no exact match, it accepts a short name that only one symbol has. It returns a maximum of 400 lines.

**Result:**

```text
app/main.py: function count, lines 5-7:
5| def count(text: str) -> dict[str, int]:
6|     words = tokenize(text)
7|     return {w: words.count(w) for w in words}
```

A stub has "(stub)" after the line range.

**Errors:**

- `error: 'get' is ambiguous in two.py: A.get, B.get. Use the dotted name.`
- `error: no symbol 'cuont' in app/main.py. Did you mean 'count'? Symbols: count, top.`
- The path errors and `error: no file 'x'. …`.

### 10.4.4 `search_code`

**Purpose:** Search the text of the workspace for a word, an identifier or a regular expression. The search is case-sensitive.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `query` | string | ✓ | Not empty | The text or the regular expression. |
| `is_regex` | boolean | | | `true`: the query is a JavaScript regular expression. The default is `false`. |
| `glob` | string | | | Search only files that match, for example `**/*.py`. |
| `max_results` | integer | | 1 to 50 | The maximum number of lines. The default is 20. |

**Result:** One line for each match: `path:line: text`. The text is trimmed and has a maximum of 200 characters. If there are more matches, the last line is `(more matches; narrow the query or glob)`. The tool hides matches in secret files.

**Errors:** `error: invalid regex: …`. If nothing matches, the result is `No matches for 'x'.` (this is not an error).

### 10.4.5 `list_files`

**Purpose:** List the files of the workspace. Vendor, virtual environment and build folders are excluded.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `glob` | string | | | A glob, for example `tests/**`. The default is all files. |
| `max` | integer | | 1 to 300 | The maximum number of files. The default is 200. |

**Result:** One path on each line. If there are more files, the last line is `(more files; use a narrower glob)`. The tool hides secret files. If nothing matches, the result is `No files match x.`

### 10.4.6 `get_diagnostics`

**Purpose:** Show the errors and warnings that the language tools of the editor report (type checker, linter).

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `path` | string | | | A workspace-relative path, or `*` for all files. Omit it for the current file. |

**Result:** A maximum of 60 lines in the form `path:line severity (source): message`, with 1-based lines. Errors come first. The squiggles of Assistive itself are not included. If there are none, the result is `No diagnostics for x.`

### 10.4.7 `get_project_context`

**Purpose:** Show the project around the current file. The result has these parts:

- the file tree;
- the manifests;
- the head of the README;
- the outlines of the local modules that the file imports;
- the docstrings of sibling modules;
- for imported files with a graph, the planned symbols that are not typed yet.

The model must call it one time, when it needs to know the libraries and conventions of the project.

**Parameters:** none.

**Result:** The output of `projectSummary`. Refer to [Code analysis](07-code-analysis.md#758-projectsummaryws-file-current-outlineof).

### 10.4.8 `get_graph`

**Purpose:** Show the current graph of the file: each node with its ID, kind, status, line, symbol, signature, description and notes, in typing order, and each edge.

**Parameters:** none.

**Result:** `Graph for wc.py (revision 3):` and the output of `compactGraph`. The graph is the copy that this turn changes, so it includes the edits that the model made in the same turn.

### 10.4.9 `get_recent_edits`

**Purpose:** Show what the programmer changed in the current file, as a diff with new-file line numbers.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `since` | string | | `last_heartbeat` or `graph_created` | The baseline. The default is `last_heartbeat` (the latest typing). `graph_created` shows all changes after the draft. |

**Result:** The output of `renderDiff`, with a maximum of 8000 characters. If there are no changes, the result is `No changes since the last heartbeat.` or `No changes since the graph was created.`

## 10.5 Graph tools

Each graph tool calls one `GraphEditor` method. It returns one line for each item and then the totals, for example:

```text
ok: added 'parse_line'.
ok: added 'cache_get' (id normalized from 'Cache.get').
error: node 'main': kind 'func' is not one of module, class, function, method, data, constant, test, external, step.
Graph now has 6 nodes and 4 edges.
```

For the rules of each method, refer to [Graph model](08-graph-model.md#84-class-grapheditor).

### 10.5.1 `add_nodes`

**Purpose:** Add planned pieces to the graph. If one node fails, the others are still added.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `nodes` | object[] | ✓ | 1 to 20 items | The nodes to add. |
| `nodes[].id` | string | ✓ | 1 to 48 characters | A stable snake_case ID, for example `parse_args`. |
| `nodes[].kind` | string | ✓ | A node kind | What the node is. |
| `nodes[].description` | string | ✓ | Not empty | The responsibility in one or two sentences. |
| `nodes[].symbol` | string | | | The exact name to type, dotted for members: `Cache.get`. |
| `nodes[].signature` | string | | | The planned signature with types, in the language of the file. |
| `nodes[].notes` | string[] | | Maximum 8 | Technical considerations, one in each item. |
| `nodes[].order` | integer | | 1 to 99 | The typing order. 1 is the first. |
| `nodes[].label` | string | | | A short display name. |

The tool description explains each node kind to the model:

| Kind | Description for the model |
|---|---|
| `module` | The file itself. |
| `class` | A class. |
| `function` | A function. |
| `method` | A method. The symbol is `Class.method`. |
| `data` | A dataclass, record, typed dict or interface. The signature lists the fields. |
| `constant` | A constant. |
| `test` | A test function. |
| `external` | A library, a service or a module of the project that the file uses. The programmer does not type it here. The signature names the API in use. |
| `step` | A unit of work that is not a named symbol, for example "validate input inside main". |

### 10.5.2 `update_nodes`

**Purpose:** Change nodes that exist. `set` replaces the given fields. `append_notes` adds notes. `set.attention` flags a node, and an empty `set.attention` clears the flag.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `updates` | object[] | ✓ | 1 to 30 items | The updates. |
| `updates[].id` | string | ✓ | | The ID of the node. |
| `updates[].set` | object | | | The fields to replace: `kind`, `label`, `symbol`, `signature`, `description`, `notes`, `order`, `status`, `attention`. |
| `updates[].set.status` | string | | `planned`, `stubbed`, `done`, `attention` | Only for `step` and `external` nodes. The code sets the status of symbol nodes. |
| `updates[].set.attention` | string | | | The reason for a flag. An empty string clears it. |
| `updates[].append_notes` | string[] | | Maximum 8 | Notes to add. |

### 10.5.3 `remove_nodes`

**Purpose:** Remove nodes, and their edges, that are no longer a part of the plan.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `ids` | string[] | ✓ | 1 to 30 items | The IDs to remove. |
| `reason` | string | ✓ | Not empty | Why, in a few words. |

The change summary keeps the reason of each removed node. In the panel, the line "Graph: −1 removed" shows the reasons in its tooltip.

### 10.5.4 `connect`

**Purpose:** Add edges between nodes that exist. If an edge exists, the tool changes only its label.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `edges` | object[] | ✓ | 1 to 40 items | The edges. |
| `edges[].from` | string | ✓ | | The source node ID. |
| `edges[].to` | string | ✓ | | The target node ID. |
| `edges[].kind` | string | ✓ | An edge kind | The relation. |
| `edges[].label` | string | | | A detail of a few words, for example "on cache miss". |

The tool description explains each edge kind to the model:

| Kind | Description |
|---|---|
| `calls` | `from` calls `to`. |
| `uses` | `from` reads a constant, a type or an external API. |
| `contains` | A class contains a method. A module contains a symbol. |
| `creates` | `from` makes an instance of `to`. |
| `reads` / `writes` | Data flows from or to storage or state. |
| `returns` | `from` produces a value of `to`. |
| `depends` | `to` must exist first. This is for the order only. |

### 10.5.5 `disconnect`

**Purpose:** Remove edges. Without `kind`, the tool removes each edge between the two nodes in that direction.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `edges` | object[] | ✓ | 1 to 40 items | The edges to remove. |
| `edges[].from` | string | ✓ | | The source node ID. |
| `edges[].to` | string | ✓ | | The target node ID. |
| `edges[].kind` | string | | An edge kind | Remove only this kind. |

## 10.6 Talk tools

### 10.6.1 `recommend_resources`

**Purpose:** Show the programmer the best 1 to 4 resources to learn a concept that the programmer needs now. The tool description tells the model to prefer official documentation, then well-known tutorials or articles, and to use deep links.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `topic` | string | ✓ | Not empty | The concept, for example "HTTP conditional requests with ETag". |
| `resources` | object[] | ✓ | 1 to 4 items | The resources. |
| `resources[].title` | string | ✓ | Not empty | The page title. |
| `resources[].url` | string | ✓ | 8 characters or more | The full `https` URL. |
| `resources[].type` | string | ✓ | `docs`, `tutorial`, `article`, `video`, `book`, `reference`, `course` | The kind of resource. |
| `resources[].why` | string | ✓ | Not empty | One sentence: what the programmer learns there for this task. |

**Procedure in the code:**

1. The tool removes the links that the feed of the file already shows. If no link is left, the result is `ok: the programmer already has these links in the panel; nothing new was shown. …`.
2. The tool calls `checkLinks` (refer to [Store and resources](13-store-and-resources.md#132-link-check-resourceslinksts)).
3. If no link is usable, the result is `error: none of the links could be used: <url> (<reason>), …. Recommend other pages you are sure exist.` The panel shows nothing.
4. If not, the tool adds a `resources` item to the feed with the links that it kept.
5. The result is `ok: showed 2 resource(s) on 'topic'. Dropped: <url> (HTTP 404).` If the tool removed links in step 1, the result also names them.

### 10.6.2 `ask_programmer`

**Purpose:** Ask the programmer a short question about a design decision that only the programmer can make. The answer comes as a later message. The model must not wait. It must make a sensible default choice in the graph.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `question` | string | ✓ | Not empty | One sentence. |
| `options` | string[] | | Maximum 4 | Two to four short answers to click. Empty answers are removed. |

**Result:** `ok: question shown. Continue with your default; the answer will come as a later message.`

When the programmer clicks an answer, the controller sends a chat message `Answer to "<question>": <option>`.

### 10.6.3 `point_to_code`

**Purpose:** Show the programmer a link to specific lines, with a short note.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `path` | string | | | A workspace-relative path. Omit it for the current file. |
| `line` | integer | ✓ | ≥ 1 | The first line. |
| `end_line` | integer | | ≥ 1 | The last line. |
| `note` | string | ✓ | Not empty | What to look at there, in one sentence. |

**Result:** `ok: reference shown.` The feed shows a `code_ref` item. The item keeps 0-based lines.

**Errors:** `error: 'x' is outside the workspace.`

## 10.7 Heartbeat tools

### 10.7.1 `interrupt_programmer`

**Purpose:** Interrupt the programmer about one concrete problem in the code that the programmer just typed. The panel shows it, the line receives a squiggle, and a notification shows if the panel is hidden. The tool description tells the model to explain the problem and the direction of the fix in a maximum of four sentences. The model must not write the corrected code.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `title` | string | ✓ | 1 to 80 characters (longer text is cut) | About 8 words, for example "Off-by-one in the page loop". |
| `message` | string | ✓ | Not empty | What is wrong, why it is important, and what to change (short Markdown). |
| `line` | integer | ✓ | ≥ 1 | The line of the problem. |
| `end_line` | integer | | ≥ 1 | The last line of the problem. |
| `issue` | string | ✓ | `typo`, `syntax`, `logic_error`, `api_misuse`, `better_implementation`, `missing_edge_case`, `deviates_from_graph`, `security`, `other` | The kind of problem. |
| `severity` | integer | ✓ | 1 to 3 | 1: useful to know. 2: fix before you continue. 3: the code will break or progress is blocked. |

**Procedure in the code:**

1. If the tool ran before in this turn, the result is `error: you already interrupted in this heartbeat; one interruption at a time.`
2. If `line` is after the end of the file, the result is `error: line N is past the end of the file (M lines).`
3. The tool adds an `interrupt` item to the feed. The item has these fields:
   - the 0-based line;
   - the end line, only if it is not before `line` (the tool keeps it in the file);
   - the severity, rounded and kept between 1 and 3;
   - the status `open`;
   - `lineText`, the text of the line now. The controller uses it to find out when the programmer changes the line.
4. The Assistant does not add a duplicate item. Then the result is `error: this <issue> on line N was already reported and the line has not changed; it is not shown again. Call stand_down, or report a different problem.` The turn continues, and the model can report a different problem. Refer to [Assistant turns](12-assistant.md#126-feed-output-and-duplicate-interrupts).
5. If not, the tool sets `ctx.stop`, so the loop ends after this round.
6. The result is `ok: the programmer was interrupted.`

### 10.7.2 `stand_down`

**Purpose:** Decide not to interrupt, because the code is correct, unfinished but on track, or the problem is too small. This ends the heartbeat turn.

| Parameter | Type | Required | Rules | Description |
|---|---|:-:|---|---|
| `reason` | string | ✓ | Not empty | A few words, for example "still typing the loop". |

**Result:** `ok.` The tool sets `ctx.stop` to the reason.

## 10.8 Helper: `cursorDescription(outline, line)`

This function makes the cursor text for prompts, for example `line 42, inside def fetch(repo)` or `line 3, at module level`. If the line is not known, it returns `unknown`.
