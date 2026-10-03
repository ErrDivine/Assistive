# 7. Code analysis (`src/code/`)

This document describes how Assistive reads the code of the programmer. The modules in `src/code/` find the module docstring, the symbols and the imports of a file. They also record the changes of the programmer and give the LLM tools access to the workspace.

| Module | Function |
|---|---|
| `treesitter.ts` | Loads the tree-sitter WASM runtime and the grammars. |
| `outline.ts` | Makes the outline of a file: the module docstring, the symbols and the imports. |
| `pyscope.ts` | Python helpers for the fallback outline. |
| `changes.ts` | Makes diffs and records the edits of each file (`EditTracker`). |
| `context.ts` | Defines `WorkspaceAccess`, the path rules, and the project summary. |
| `workspace.ts` | Implements `WorkspaceAccess` with the VS Code API (`VsWorkspace`). |
| `debounce.ts` | A debouncer with replaceable timers. |

All modules except `workspace.ts` are pure. They do not import `vscode`.

## 7.1 Tree-sitter (`treesitter.ts`)

Tree-sitter is an incremental parser. Assistive uses the WASM build from the package `@vscode/tree-sitter-wasm`. The build script copies the runtime and four grammars to `dist/wasm/`: `tree-sitter.wasm`, `tree-sitter-python.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` and `tree-sitter-javascript.wasm`.

### 7.1.1 `grammarFor(languageId)`

This function changes a VS Code language ID into a grammar name.

| Language ID | Grammar |
|---|---|
| `python` | `python` |
| `typescript` | `typescript` |
| `typescriptreact` | `tsx` |
| `javascript`, `javascriptreact` | `javascript` |
| All other IDs | `undefined` |

### 7.1.2 `class TreeSitter`

The constructor receives the folder of the WASM files.

- `ready()` calls `Parser.init` one time. The `locateFile` function points the runtime to the WASM folder.
- `parser(grammar)` loads the grammar and makes one `Parser` for each grammar. It keeps the promise in a map. If the load fails, it removes the promise from the map, so the next call tries again.
- `parse(grammar, text)` returns a `Tree`. The caller must call `tree.delete()`, because the tree uses WASM memory.

## 7.2 Outline (`outline.ts`)

The outline is the main view of a file for the graph and the prompts.

### 7.2.1 Data types

**`OutlineSymbol`**

| Field | Description |
|---|---|
| `name` | The name as written, for example `get`. |
| `qualname` | The dotted name in the file, for example `Cache.get`. |
| `kind` | `class`, `function`, `method`, `constant`, `variable` or `type`. |
| `line`, `endLine` | The 0-based first and last line. `line` includes the decorators. |
| `signature` | The header up to the body on one line, for example `def get(self, key: str) -> bytes \| None`. |
| `docstring` | The docstring or JSDoc comment, if there is one. |
| `isStub` | `true` if the body is only a placeholder. |
| `parent` | The `qualname` of the class that contains a method. |

**`ModuleString`:** `text` (the cleaned docstring), `closed` (the docstring is complete), `startLine` and `endLine` (0-based).

**`FileOutline`:** `language`, `moduleString`, `symbols`, `imports`, `parser` (`tree-sitter`, `regex` or `none`) and `hasErrors` (the parse tree has syntax errors).

### 7.2.2 `cleandoc(raw)`

This function does the same work as `inspect.cleandoc` of Python (PEP 257):

1. It changes tabs to four spaces.
2. It trims the first line.
3. It finds the smallest indent of the other lines that are not empty. It removes that indent from these lines.
4. It removes empty lines at the start and at the end.

### 7.2.3 `pythonModuleString(text)`

A Python module docstring is the first statement of the file if that statement is a string literal. The function does these steps:

1. It skips blank lines, comment lines (for example `#!/usr/bin/env python` and `# -*- coding: utf-8 -*-`) and spaces.
2. It accepts a prefix of up to two letters from `r`, `R`, `u`, `U`, then `"""`, `'''`, `"` or `'`. If there is no quote, there is no module docstring.
3. For a triple quote, it finds the next identical triple quote.
4. For a single quote, it reads to the next identical quote. It skips characters after a backslash. A line break before the quote means that the string is not closed.
5. If the string is closed, it returns the cleaned text and `closed: true`.
6. If the string is not closed, the programmer is still typing it. It returns `closed: false` and the text so far. The text ends at the end of the file (triple quote) or of the line (single quote).

### 7.2.4 `jsModuleString(text)`

A JavaScript or TypeScript module docstring is the comment at the top of the file. The function skips blank lines, a shebang line (`#!`) and `"use strict"`. Then it accepts two forms:

- **Block comment** (`/* … */` or `/** … */`). The function finds `*/`. It removes the `*` characters at the start of each line. The comment is closed if `*/` exists.
- **Line comments** (a group of `//` lines). The function collects the consecutive `//` lines and removes the `//` markers. The comment is closed if code follows it, or if two line breaks follow it.

### 7.2.5 `moduleStringOf(languageId, text)`

This function calls `pythonModuleString` for Python. It calls `jsModuleString` for the other languages that have a grammar. It returns `undefined` for all other languages.

### 7.2.6 `normalizeSignature(raw)`

This function changes a header into one line:

1. It changes each group of white space into one space.
2. It removes the space after `(`, `[` and `{`.
3. It removes a comma and the space before `)`, `]` and `}`.
4. It removes `:`, `=>` or `{` at the end.
5. It cuts the result at 300 characters and adds `…`.

Example: a multi-line Python header becomes `def fetch(repo: str, *, timeout: float = 5.0) -> list[Issue]`.

### 7.2.7 Python symbols (tree-sitter)

`pythonSymbols(root)` visits the statements at the top level and in class bodies:

- A `decorated_definition` gives its inner definition. The symbol line is the line of the first decorator.
- A `function_definition` is a `function` at the top level and a `method` in a class.
- A `class_definition` is a `class`. The function visits its body for methods.
- At the top level, an assignment to a simple name gives a `constant` or a `variable`. A name in upper case, for example `MAX_RETRIES`, gives a `constant`. The function ignores names such as `__all__`. The signature of these symbols is the first line of the statement, with a maximum of 160 characters.

The function does not visit functions inside functions.

The signature comes from `header(def, body)`. This function takes the text from the start of the definition to the start of the body. It removes the comments between the parameters and the body. Then it calls `normalizeSignature`.

**Docstring.** `pyDocstring(body)` takes the first statement of the body that is not a comment. If it is a string expression, the function removes the quotes and cleans the text.

**Stub detection.** `pyIsStub(body)` returns `true` if there is no body, or if each statement after the docstring is one of these:

- `pass`;
- `...`;
- a `raise` statement that contains `NotImplementedError`.

Thus a function with only a docstring is also a stub.

**Imports.** `pythonImports(root)` collects:

- each name of `import a.b, c as d` (here `a.b` and `c`);
- the module of `from x.y import z` (here `x.y`), with the dots at the start of a relative import (for example `.cache`);
- `__future__` for `from __future__ import …`.

### 7.2.8 JavaScript and TypeScript symbols (tree-sitter)

`jsSymbols(root, moduleEnd)` visits the top-level statements. It unwraps `export` statements. It accepts these declarations:

| Declaration | Symbol kind | Stub rule |
|---|---|---|
| `function`, generator function | `function` | `jsIsStub(body)` |
| TypeScript overload (`function_signature`) | `function` | Never a stub |
| `class`, `abstract class` | `class` | Stub if the body is empty |
| `const f = () => …`, `const f = function …` | `function` | `jsIsStub(body)` |
| Other `const`, `let`, `var` | `constant` (upper-case name) or `variable` | Never a stub |
| `interface`, `type`, `enum` | `type` | Never a stub |

For each class, `classMembers` adds the methods. A method is a `method_definition`, an abstract method, a method signature, or a class field whose value is an arrow function or a function expression. The `qualname` is `Class.method`.

**JSDoc.** `jsDoc(node, moduleEnd)` takes a `/** … */` comment that ends on the line above the declaration (or on the same line). It ignores the comment if that comment is the module docstring.

**Stub detection.** `jsIsStub(body)` returns:

- `true` if there is no body;
- `false` if the body is an expression (an arrow function without braces);
- `true` if each statement in the block is a `throw` with the text "not implemented", "not yet implemented", "unimplemented" or "todo" (any case). An empty block `{}` is also a stub.

**Imports.** `jsImports(root)` collects the source string of each `import … from "x"` and `export … from "x"`.

### 7.2.9 Regex fallback for Python

If tree-sitter is not available or fails, Python files use `pythonOutlineRegex(text)`. This function reads the file line by line:

1. A line that matches `def`, `async def` or `class` starts a symbol. The function keeps a stack of open symbols by indent. It skips a `def` inside a function.
2. `pythonEnclosingRange` from `pyscope.ts` gives the first and last line of the symbol.
3. The header ends at the first line that ends with `:` after the function removes strings and comments.
4. If the first body line starts with a triple quote, the function reads the docstring. It then removes the docstring from the body.
5. The symbol is a stub if each other body line is `pass`, `...` or `raise NotImplementedError…`.
6. A line at column 0 such as `MAX_SIZE = 10` or `MAX_SIZE: int = 10` gives a `constant`.

`pythonImportsRegex(text)` finds `from X import …` and `import a, b as c` lines.

### 7.2.10 `outline(ts, languageId, text)`

This is the entry point. It does these steps:

1. It finds the module docstring with `moduleStringOf`.
2. If a tree-sitter instance and a grammar exist, it parses the text. It collects the symbols and the imports for Python or for JavaScript and TypeScript. It sets `hasErrors` from `root.hasError`. It always deletes the tree.
3. If the parse fails, and the language is Python, it uses the regex fallback (`parser: "regex"`).
4. For all other cases, it returns an outline without symbols (`parser: "none"`).

The controller keeps a cache of outlines. Refer to [Controller](15-controller.md#153-files-and-outlines).

### 7.2.11 `symbolAt(outline, line)`

This function returns the innermost symbol that contains the 0-based line. "Innermost" means the symbol with the smallest range. For a line in a method, it returns the method, not the class.

### 7.2.12 `formatOutline(outline, {docstrings})`

This function makes the compact text that the prompts and the `get_file_outline` tool use. The line numbers are 1-based. Example:

```text
imports: collections, pathlib
L4-9 def parse_line(line: str) -> list[str]
L12-30 class WordCounter
  L13-16 def __init__(self) -> None
  L18-30 def add(self, line: str) -> None  [stub]
```

With `docstrings: true`, the function adds the first line of each docstring (maximum 140 characters) in quotes under the symbol. If there are no symbols, the text is "(no symbols yet)". If the parse tree has errors, the text ends with "(the file currently has syntax errors)".

## 7.3 Python scope helpers (`pyscope.ts`)

### 7.3.1 `stripStrings(text)`

This function replaces the content of each string literal with spaces. The quotes stay. The columns do not change. Thus a `#` or a `:` in a string does not confuse the other helpers.

### 7.3.2 `headerEnd(lines, i)` (internal)

This function finds the line that ends a `def` or `class` header that starts at line `i`. It counts the open brackets in the code without strings and comments. It returns the first line where the bracket depth is 0 and the code ends with `:`. It examines a maximum of 50 lines.

### 7.3.3 `pythonEnclosingRange(lines, line)`

This function returns the 0-based first and last line of the innermost `def` or `class` that contains `line`. It uses only the indentation. It does these steps:

1. It finds the indent of the cursor line, or of the nearest line above that is not blank.
2. It goes up line by line and finds each `def`, `async def` or `class` header.
3. It skips a header if its indent is equal to or more than the cursor indent. It does not skip the header that contains the cursor.
4. It adds the decorator lines above the header.
5. It extends the range over each next line with a larger indent. It ignores blank lines and comment lines.
6. If the range contains `line`, it returns the range. If not, it uses the indent of that header as the new limit and continues up.

A multi-line header with `):` at the indent of the `def` (the style of the Black formatter) is a part of the `def`.

## 7.4 Changes (`changes.ts`)

### 7.4.1 `renderDiff(oldText, newText, context = 2, maxChars = 6000)`

This function makes a diff with the line numbers of the new file. The LLM can then point at lines. It uses `structuredPatch` from the `diff` package. Example:

```text
@@ new lines 12-15 @@
  12 | def fetch(repo):
-    |     return get(url)
+ 13 |     resp = get(url, timeout=5)
  14 |     resp.raise_for_status()
```

- Each hunk starts with `@@ new lines A-B @@`.
- A removed line has `-` and no number.
- An added line has `+` and its number in the new file.
- A context line has a space and its number.
- The numbers have the same width in each hunk.
- The function skips the line "\ No newline at end of file".
- If the text is longer than `maxChars`, the function cuts it and adds "…(diff truncated)".
- If the two texts are the same, the function returns an empty string.

### 7.4.2 `changedLineCount(oldText, newText)`

This function returns the number of added lines plus the number of removed lines.

### 7.4.3 `class EditTracker`

The `EditTracker` keeps two **baselines** for each file. A baseline is a copy of the text at an earlier time.

| Baseline | Set by | Use |
|---|---|---|
| `last_heartbeat` | `open()` the first time, then `beat()` | The diff for the heartbeat and for `get_recent_edits` |
| `graph_created` | `open()` the first time, then `graphCreated()` | The diff for a sync, and for `get_recent_edits` with `since: "graph_created"` |

For each file, it also keeps these values:

- the time of the last edit;
- the number of edits since the last beat;
- a set of touched lines (maximum 500).

| Method | Function |
|---|---|
| `open(file, text)` | Sets both baselines, if they are not set. |
| `edited(file, lines)` | Records an edit: the time, the count and the 0-based lines. |
| `beat(file, text)` | Sets the `last_heartbeat` baseline to `text`. Resets the count and the touched lines. |
| `graphCreated(file, text)` | Sets the `graph_created` baseline to `text`. |
| `diff(file, text, since, maxChars?)` | Returns `renderDiff(baseline, text)`, or an empty string if there is no baseline. |
| `stats(file)` | Returns `lastEditAt`, `editsSinceBeat` and the sorted touched lines. |
| `forget(file)` | Removes the record of the file. |

The constructor accepts a `now` function. The tests give a fake clock.

## 7.5 Workspace access and project context (`context.ts`)

### 7.5.1 `interface WorkspaceAccess`

The tools and the Assistant use this interface. They never call the VS Code API directly. The extension gives `VsWorkspace`. The tests give `MemoryWorkspace`.

| Member | Function |
|---|---|
| `root` | The absolute root folder. |
| `list(glob?, max?)` | Workspace-relative paths with forward slashes, sorted. Vendor and build folders are excluded. |
| `read(rel)` | The text of a file. The open editor buffer wins over the disk, so the text includes unsaved edits. |
| `search(query, {regex, glob, max})` | Lines that contain the query. |
| `diagnostics(rel?)` | The diagnostics of one file or of all files. |
| `languageOf(rel)` | The VS Code language ID for the file extension. |

### 7.5.2 Excluded folders

`EXCLUDED_DIRS` lists the folders that `list` and `search` ignore: `node_modules`, `.git`, `.hg`, `.venv`, `venv`, `env`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox`, `dist`, `build`, `out`, `.next`, `coverage`, `site-packages`, `.idea` and `.vscode-test`. `EXCLUDE_GLOB` is the glob `**/{…}/**` of these folders.

### 7.5.3 `isSecretPath(rel)`

This function returns `true` for a path that looks like a secret. The tools never read these files, and `list_files` and `search_code` hide them.

| Pattern | Examples |
|---|---|
| `.env` and `.env.*` | `.env`, `.env.local`, `config/.env.production` |
| Key and certificate files | `server.pem`, `private.key`, `cert.p12`, `store.pfx`, `app.keystore` |
| SSH keys | `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` |
| Package manager credentials | `.npmrc`, `.pypirc`, `.netrc` |
| Credential files | `credentials`, `credentials.json` |
| Secret files | `secret.json`, `secrets.yaml`, `secrets.yml`, `secrets.toml` |

The templates `.env.example`, `.env.sample` and `.env.template` are not secrets. The test is not case-sensitive. Backslashes change to slashes first.

### 7.5.4 `normalizeRel(root, p)`

This function changes a path from the model into a workspace-relative path:

1. It trims the path and changes backslashes to slashes.
2. It resolves a relative path against the root.
3. If an absolute path is outside the root, the function tries it as a relative path. For example, `/app/x.py` becomes `app/x.py`.
4. If the result is `..` or starts with `../`, or is still absolute, the function returns `undefined`. The path escapes the workspace.
5. It returns the path with forward slashes.

A file name such as `..notes.md` does not escape the workspace. The function examines only the full `..` segment.

### 7.5.5 `numberLines(text, start = 1, end?)`

This function adds 1-based line numbers, for example `  12| text`. The numbers have the width of the last number.

### 7.5.6 `fileTree(paths, max = 150)`

This function makes an indented tree of paths. A folder has a `/` at the end. If there are more than `max` paths, the last line is "… and N more files".

### 7.5.7 `resolveImport(spec, fromFile, language, files)`

This function finds the workspace file of an import, if the file is in the workspace.

**Python:**

1. It counts the dots at the start. It changes the other dots of the module name to `/`.
2. For a relative import, the base is the folder of `fromFile`, up one level for each dot after the first.
3. For an absolute import, it tries these bases: the root, `src/`, and each parent folder of `fromFile`.
4. For each base, it tries `<base>/<module>.py` and `<base>/<module>/__init__.py`.
5. For `from . import x`, the module name is empty. The function returns `<base>/__init__.py`.

**JavaScript and TypeScript:** The function accepts only relative imports (they start with `.`). It tries these candidates in this order:

1. the path as written;
2. the path with `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` added;
3. an `index` file with one of these extensions in the folder of that path;
4. the path with `.js` changed to `.ts`.

### 7.5.8 `projectSummary(ws, file, current, outlineOf)`

This function makes the project context for the draft prompt and for the `get_project_context` tool. It has these parts, in this order:

1. **File tree.** A maximum of 400 files are listed, and a maximum of 150 are shown.
2. **Manifests.** The first 50 lines of each of these root files: `pyproject.toml`, `requirements.txt`, `setup.cfg`, `setup.py`, `package.json`, `tsconfig.json` and `environment.yml`. For `package.json`, only `name`, `type`, `engines`, `dependencies` and `devDependencies` are kept.
3. **README.** The first 30 lines of `README`, `README.md`, `README.rst` or `README.txt` at the root (any case).
4. **Imported modules.** The function shows a maximum of 5 local modules that the file imports. For each one, it shows the first line of the docstring and the first 40 lines of the outline.
5. **Sibling modules.** The function shows a maximum of 8 other files in the same folder and language. For each one, it shows the first line of the docstring and up to 8 top-level names. It does not repeat the imported modules.

## 7.6 VS Code workspace (`workspace.ts`)

`class VsWorkspace` implements `WorkspaceAccess` with the VS Code API. The constructor receives the root folder and the diagnostic source to ignore (`"Assistive"`, the source of the interrupt squiggles).

| Method | Implementation |
|---|---|
| `list(glob = "**/*", max = 200)` | `vscode.workspace.findFiles` with `EXCLUDE_GLOB`. The result is sorted. |
| `read(rel)` | If a document with this path is open (and its scheme is not `git`), returns the buffer text. Else reads the disk. Returns `undefined` for a folder. Returns "(binary file)" if the first 2000 bytes contain a NUL byte. Cuts files at 1 MB and adds "…(file truncated at 1 MB)". |
| `search(query, opts)` | Lists a maximum of 4000 files and skips binary extensions (images, archives, compiled files, model weights, lock files and more). Reads each file and tests each line with the regular expression or with a plain text search. Stops at `max` hits. |
| `diagnostics(rel?)` | Reads the diagnostics of one file or of all files. Skips files outside the root and the diagnostics of Assistive itself. Errors come first. |
| `languageOf(rel)` | `.py` and `.pyi` → `python`; `.ts`, `.mts`, `.cts` → `typescript`; `.tsx` → `typescriptreact`; `.js`, `.mjs`, `.cjs` → `javascript`; `.jsx` → `javascriptreact`. |

## 7.7 Debouncer (`debounce.ts`)

A debouncer runs a function a fixed time after the last call. Each new call starts the time again.

- `interface Timers` has `setTimeout` and `clearTimeout`. `realTimers` uses the timers of Node.js. The tests give a fake clock.
- `class Debouncer(delayMs, timers)` has `trigger(fn)`, `cancel()` and the property `pending`.

The controller uses four debouncers: the panel refresh (60 ms), the live status sync (800 ms), the auto-draft (2.5 s) and the interrupt reconcile (400 ms).
