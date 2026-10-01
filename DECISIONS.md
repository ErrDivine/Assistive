# Decision records

Deviations from and refinements of `reference-rail-design-plan.md`, with reasons and alternatives. Status is **accepted** unless marked otherwise. Entries are numbered as they were made and cited by those numbers in code comments.

---

## D-001 · Repository layout at the repository root
The plan's `reference-rail/` tree (§5) is the root of this repository: `extension/`, `server/`, `eval/`, `scripts/`, `PROGRESS.md`, `DECISIONS.md`.

Additions to the planned files:
- `extension/src/context/pyscope.ts`, `context/debounce.ts`, `rail/cardDiff.ts`, `metrics/` and `session/`. These are pure modules split out so they can be unit-tested without VS Code.
- `server/rail_server/server.py` (request handlers), `index/{pyast,docparse,chunks,worker}.py` and `retrieve/{store,resolve}.py`.

## D-002 · Pinned versions
All runtime dependencies are those allowed by §6, pinned exactly. API names were checked against the installed sources.

| Package | Pin | Notes |
|---|---|---|
| griffe | 2.3.0 | `griffe.visit`, `Docstring.parse(style)`, `Alias.target_path`, `ExprName.canonical_path` |
| fastembed | 0.8.1 | `TextEmbedding(..., specific_model_path=, local_files_only=)`, `ModelManagement.retrieve_model_gcs` |
| numpy | 2.2.6 (Python 3.10) / 2.3.5 (Python ≥ 3.11) | split by environment marker; fastembed needs ≥ 2.3 on 3.14, and 2.3 dropped 3.10 |
| pydantic | 2.13.5 | |
| pathspec | 1.1.1 | uses the `gitignore` pattern style; `gitwildmatch` is deprecated |
| vscode-jsonrpc | 9.0.3 | `vscode-jsonrpc/node`: `StreamMessageReader`/`Writer`, `createMessageConnection`. Its `ErrorCodes` has no `RequestCancelled`, so −32800 is defined locally. |
| @vscode/python-extension | 1.0.6 | `PythonExtension.api()`, `environments.getActiveEnvironmentPath` / `resolveEnvironment` |
| @types/vscode | 1.90.0 | matches `engines.vscode ^1.90.0`, so newer APIs cannot slip in |

Dev tools: pytest 9.1.1, pytest-asyncio 1.4.0, ruff 0.16.9, mypy 2.3.1, TypeScript 5.9.3, esbuild 0.28.2, eslint 9.39.1 with typescript-eslint 8.71.0, mocha 12.0.3 and @vscode/test-electron 3.1.0.

TypeScript 7 (the native port) was skipped because typescript-eslint supports TypeScript < 6.1.

## D-003 · Interpreter discovery order
§9.2 orders the sources as Python extension, then the `referenceRail.pythonPath` setting, then `python3`. We check an **explicitly set** `referenceRail.pythonPath` first. A user who sets it expects it to win; with the plan's order it would be silently ignored whenever the Python extension is installed. The rest of the order is unchanged.

## D-004 · Library extraction with `griffe.visit` per file
Each file a distribution lists is visited statically with `griffe.visit(module, path, source)`: no imports and no inspection, as I4 and §11 require. We do not load whole packages with `griffe.load`, because that resolves across packages and is slower. Module names come from the dist's `RECORD` paths.

How re-exports are handled:
- **Aliases table.** Re-exports (`requests.get` → `requests.api.get`) are recorded from griffe's import aliases, from module-level assignments (`s = attrs`), and from `from X import *` (stored as `module.*` → `X`). `Store.lookup` follows these chains.
- **Bodies.** Library API chunks store no body; §9.3 says library chunks are not embedded in v1.
- **Builtins and C modules** are introspected by `env_probe.py` for `builtins`, `sys.builtin_module_names` and an allowlist of standard C extensions. They are named by `__module__`, so `_collections.deque` becomes `collections.deque`, which is where users import it from.
- **Third-party C extensions** (numpy's `_multiarray_umath`, for example) are not imported. This is a known gap; see PROGRESS.md.

Measured on this machine: 65 dists plus the standard library, 36k chunks, indexed in 23 s. The target is ≤ 3 min for 80 dists.

## D-005 · Schema extensions
The §7.1 schema is kept, with these additions:

**`chunks` table**
- `name_line`: the line of the `def`/`class` keyword. "Open source" lands there, and step 1 of `resolve_api` checks it. griffe sometimes reports a decorator's line instead, so the AST value is used.
- `doc_line`, `rel_path`, `chunk_hash`: `chunk_hash` keeps ids and embeddings of unchanged chunks across re-indexing.
- `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`. Plain rowids reuse the largest id after a delete, which let a new chunk inherit a deleted chunk's card id.

**New tables**
- `aliases`, keyed by `(alias, dist, version)`.
- `indexed_history`, so git history scanning is resumable.
- `meta`, holding `last_sync`.

**Index changes**
- Migration v2 drops the planned two-valued index on `chunks.kind`. It made SQLite scan every API chunk instead of using `chunks_qualname` or FTS: a 670 ms suffix lookup became 1 ms.
- Lookups use `INDEXED BY` where the planner guessed wrong.
- `ANALYZE` runs after every sync.

**`files` table**
- A workspace file deleted from disk is re-labelled `source_kind = 'history'` when functions recovered from history still point at it. Its history chunks are not cascaded away.

## D-006 · Embeddings: hybrid default, chosen by the Phase 2 spike
Spike on `eval/queries.jsonl` (45 precedent queries; `run_eval.py --spike`). Recall@3 is measured at the threshold that keeps precision ≥ 0.8.

| Embedder | Recall@3 | Precision | Embed ms/query |
|---|---|---|---|
| hashing only (identifier sub-tokens) | 0.64 | 0.83 | 0.1 |
| all-MiniLM-L6-v2 | 0.47 | 0.85 | 11 |
| bge-small-en | 0.78 | 0.83 | 22 |
| bge-base-en-v1.5 | 0.81 | 0.81 | 71 |
| **hybrid 0.5: hashing ⊕ all-MiniLM-L6-v2** | **0.92** | **0.83** | 11 |
| hybrid 0.7: hashing ⊕ bge-small-en | 0.97 | 0.82 | 22–69 |
| hybrid 0.5: hashing ⊕ bge-base-en-v1.5 | 0.94 | 0.81 | 203 |

**The hybrid embedder.** It concatenates the semantic vector scaled by √w with a 512-dimension signed feature-hashing vector of identifier sub-tokens scaled by √(1−w). Both halves are unit vectors, so the dot product of two hybrid vectors is the weighted mean of the two cosines. It is still a cosine similarity, so the I6 gate still "always uses cosine similarity" (§9.5).

**The default** is `auto`: hybrid with all-MiniLM-L6-v2 when that model is on disk, otherwise hashing alone. MiniLM is the smallest model (90 MB) and the fastest. Paired with hashing it beats every larger model used alone. bge-small hybrid scored higher but is 2–6× slower and needs a 130 MB model.

**Getting the model.** The model is never downloaded implicitly. Doing so would break I4, which allows no network by default.
- The explicit command **Reference Rail: Download Embedding Model** (`rail-server download-model`) fetches it.
- At runtime fastembed loads with `local_files_only` and `HF_HUB_OFFLINE`.
- fastembed 0.8.1 does not fall back to its GCS mirror when a proxy refuses HuggingFace, so `download_model` calls `retrieve_model_gcs` itself.

**Vectors** are stored as float16 and searched by brute force (`BruteForceIndex` behind `VectorIndex`).

## D-007 · `resolve_api` step 5: evident local types
After the plan's four steps, step 5 resolves `var.attr` when `var`'s type is evident in the enclosing code:
- an annotation (`d: dict`);
- a literal (`d = {}`, `", ".join`);
- a constructor call (`window = deque(maxlen=3)`, `s = requests.Session()`), mapped through the file's imports.

Without a language server, a cursor on `d.get` or `session.get` is otherwise unresolvable. With one, step 1 or 2 answers first. Eval API recall@3 went from 0.85 to 1.0 together with the D-004 alias additions. Diagnostic messages also match quoted generic names like `"DictWriter[str]"`.

## D-008 · Precedent threshold calibration
`run_eval.py --calibrate` sweeps the cosine gate from 0.20 to 0.95 over fused, self-excluded hits. It picks the threshold with the best recall@3 among those with precision ≥ 0.8. Results:
- **0.51** for `hybrid0.5:fastembed:sentence-transformers/all-MiniLM-L6-v2`;
- **0.47** for `hashing-v1`.

The values are stored per embedder name in `config.CALIBRATED_THRESHOLDS`, because each embedding space has its own cosine scale. `referenceRail.precedentThreshold` overrides them.

Confidence is a linear map from cosine to confidence: the threshold maps to 0.5 and a cosine of 1.0 maps to 1.0.

*Limitation:* calibration and evaluation use the same 45 labeled precedent queries, so precision is an in-sample estimate. Dogfooding recordings (Phase 6) are the way to get an out-of-sample check.

## D-009 · Keybindings
`referenceRail.focus` is `Ctrl+Alt+R` and `referenceRail.askAboutSymbol` is `Ctrl+Alt+/` (only when a Python editor has focus). The same keys are used on every platform.

`Cmd+Alt+R` was rejected for macOS because VS Code binds it to *Reveal in Finder* outside the editor. No default VS Code binding uses `Ctrl+Alt+R` or `Ctrl+Alt+/`.

On keyboard layouts where `Ctrl+Alt` acts as AltGr (German, Polish), `AltGr+/` may type a character. Users can rebind it.

## D-010 · "Open source" opens beside the editor
`showTextDocument(uri, {viewColumn: Beside, preview: true, preserveFocus: true, selection})`. Opening in the active column with `preserveFocus` still replaced the user's editor in that group. Opening beside keeps the code being written visible, with the cursor where it was.

Runtime-doc and git-history sources open as read-only virtual documents (`reference-rail-source:` scheme, served by `source/read`).

## D-011 · Protocol additions (§8)
- `ping` returns `{serverVersion, pid, python}`. It is used by the Ping command.
- `memory/pinned` returns `Card[]` for the Pinned section; §8 had no request for it.
- `source/read` takes `{path, repo?, commit?, deleted?}` and returns `{text}`, for virtual documents.
- `index/sync` accepts `{reprobe?, full?}`. `full` forgets which dists were indexed, which `Reference Rail: Re-index` needs.
- `initialize` accepts `noAutoIndex`, used by tests and the evaluator.

The server also logs its own `query_served` events (latency, trigger, card count, whether the query was abandoned). Latency percentiles and empty-result rates are computed from these.

## D-012 · Card additions
`Card` gains four optional fields:
- `qualname`, used by pins, Frequent and evaluation;
- `stale`, which drives the "re-indexing" badge (§9.6);
- `pinned`;
- `authoredAt`, the precedent's commit date.

## D-013 · An explicit answer stays until the cursor moves
`Ask About Symbol` records the cursor position. A selection event at that same position does not start an automatic `cursor_pause` query. Without this, a debounced selection event delivered after the command could supersede the explicit answer.

## D-014 · Metrics definitions (§9.8)
- **Edit before a blur.** The extension sends `msSinceLastEdit` with `focus_lost`; per-minute `edit_tick` events are too coarse for the 2-minute rule. The server falls back to `edit_tick` when it is missing.
- **North-star division.** All qualifying external lookups are divided by the number of active hours.
- **Rail-on vs rail-off.** `focus_lost` and `edit_tick` carry `railEnabled`, so the report also gives lookups per active hour with the rail on and with it off. This serves the §14 alternating-days study.
- **Latency** is server-side processing time from `query_served` events. Superseded requests are excluded.

## D-015 · "Networking disabled" in tests and evaluation
`RAIL_NO_NETWORK=1`, or `run_eval.py --no-network`, makes every non-loopback `socket.connect` raise. It is set in the pytest `conftest.py` and in `run_eval.py`. This works identically on Linux and macOS runners.

The alternative, OS-level network namespaces, needs privileges and does not exist on macOS.

## D-016 · Evaluation regression gate
`run_eval.py --check eval/baseline.json` fails the build on any of these:
- recall@3, MRR or precision more than 5% (relative) below the baseline;
- the negative false-positive rate or empty rate more than 5 points above it;
- a p95 latency over its §10 budget (150 ms for the API path, 400 ms with precedent search).

Latency is gated on the absolute budgets because a relative 5% gate on CI timing would be noise. `baseline.json` holds one entry per embedder; CI checks both hashing and hybrid.

## D-017 · Open decisions (§15), answered with the plan's defaults
1. **Language:** Python.
2. **Copy button:** kept, clipboard only. It never touches a buffer, so I1 holds.
3. **Phase 5** (grounded LLM answers): **not implemented**. It is optional and needs human approval. `extract/` is an empty package.
4. **`historyDepth`** defaults to 500 and **`extraRepos`** to `[]`.
5. **Adaptation** (renaming identifiers in snippets): not done; snippets are verbatim.

## D-018 · Integration tests run on VSCodium in the development container
The dev container cannot reach the VS Code download hosts. `@vscode/test-electron` therefore ran there against VSCodium 1.105 (`VSCODE_EXECUTABLE=/path/to/codium`), which implements the same extension API. CI downloads VS Code stable.

These tests run without Pylance, which exercises the no-language-server path: the indentation fallback for enclosing scopes and `resolve_api` steps 3–5.

## D-019 · Packaging *(proposed, needs approval)*
`npm run install-local` builds the extension and links it into the editor's extensions folder; it also creates the server venv.

A `.vsix` would need `@vscode/vsce`, which is not on the §6 allow-list. It is proposed here and not added. With approval, packaging would copy `server/` into `extension/server/` (`serverDirs()` already looks there) and run `vsce package`.

## D-020 · Process model details (§4)
- **`index/fileChanged`** is handled on a thread in the server process, not in the indexing pool. That keeps a save from waiting behind a minutes-long library sync. One file re-chunks and re-embeds in milliseconds; the test bound is 2 s.
- **The indexing worker** runs in a one-process `ProcessPoolExecutor` (spawn). It reports progress over a `multiprocessing.Queue`, checks a stop event between dists, and exits if the server's pid disappears, so it never outlives a killed server.
- **stdio protection.** The server moves fd 1 to a private descriptor and points fd 1 at stderr, and points fd 0 at `/dev/null` (with the protocol stream moved first). A stray print or a child process therefore cannot corrupt the protocol.

## D-021 · Smaller UX choices
- **Dismiss** hides that card id for 10 minutes.
- **Frequent** leaves out qualnames that are already pinned.
- **Workspace functions as API cards.** A function from your own workspace gets an API card only when it is the cursor symbol, not a nearby definition, and never when it is the code being edited.
- **Enclosing scope without a language server.** When no document-symbol provider answers, the enclosing def is found by indentation, including Black-style multi-line headers. If that fails too, ±40 lines are used.

## D-022 · Shared library chunks across environments
A library version indexed once serves every project (§7.1), so its chunks point at the paths of the environment that indexed it first. When those files disappear, garbage collection drops them and the dist is re-indexed from the next environment that has it. A card whose file changed on disk is marked stale, and its dist is queued for re-indexing (§9.6).

## D-023 · int8 copy of the vectors in memory
Brute force over float16 at 200k × 896 dims (the hybrid vectors) took about 500 ms per query; the float16 → float32 conversion dominated. The in-memory index now works like this:

- **First pass.** An int8 copy with one scale per row ranks candidates: 3× over-fetch, about 65–90 ms, 171 MB.
- **Re-rank.** Candidates are re-ordered by exact cosine computed from the stored float16 vectors, so quantization never reorders near-ties.
- **The gate** uses the same exact cosines.

Storage in SQLite stays float16, as §7.1 specifies.

`tests/test_vectors.py` asserts a vector-pass p95 under 200 ms at 200k chunks. That leaves the §10 precedent budget (400 ms) room for query embedding (~11 ms) and FTS.

Measured server RSS with the hybrid model loaded is 235 MB (budget 600 MB). Projected at 200k chunks: about 410 MB.
