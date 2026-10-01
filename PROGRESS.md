# Progress log

Phase log against `reference-rail-design-plan.md` §12. Every acceptance check names the automated test or measurement that verifies it.

**Where the checks run**
- **CI** (`.github/workflows/ci.yml`):
  - server tests on Linux and macOS × Python 3.10 and 3.12, with networking disabled;
  - extension lint, typecheck and unit tests;
  - integration tests in real VS Code stable on Linux and macOS;
  - the invariant greps;
  - the evaluation regression gate.
- **Locally:** the same suites, with integration tests on VSCodium 1.105 (DECISIONS.md D-018).

---

## 2026-10-01 · Phase 0: scaffold, done

**Built**
- Monorepo per §5 (D-001).
- The `uv` project with `uv.lock`, `package.json` with esbuild and eslint, and CI.
- Server spawn over stdio with `initialize`/`shutdown`/`exit`, and restart with exponential backoff (1 s, 2 s, 4 s; at most 3 in 5 minutes).
- `scripts/check_invariants.sh` for I1, I4 and I7.

| Acceptance check | Result | Evidence |
|---|---|---|
| Command "Reference Rail: Ping" shows the server version | ✅ | `extension/test/integration/00_server.test.ts` |
| Killing the server process triggers an automatic restart | ✅ | same file: SIGKILL, then a new pid, then Ping succeeds |
| CI is green | ✅ | every job green except mypy on Python 3.10, failing on numpy-2.2 stub differences; that is fixed and verified locally against numpy 2.2.6 and re-checked on the next CI run |

`initialize` takes 0.3–0.4 s, measured with the real model loaded (budget < 1 s).

## 2026-10-01 · Phase 1: library index and API cards, done

**Built**
- `env_probe.py`: stdlib-only, Python 3.8+.
- The SQLite schema with migrations and the FTS5 startup check.
- The griffe library indexer:
  - docstring sections with line offsets (google, numpy, sphinx);
  - the raise scan;
  - private-name flags;
  - one transaction per dist, so an interrupted sync resumes.
- `runtime_doc` builtins.
- The Context Collector (`cursor_pause`).
- `resolve_api` steps 1–4, plus step 5 (D-007).
- The API card builder with `verify_fact`, and the basic rail.

| Acceptance check | Result | Evidence |
|---|---|---|
| In `fixture_app` with `requests` installed, the cursor on `requests.get` shows a card whose version matches `pip show requests`, and "Open source" lands on the `def get` line | ✅ | `10_api.test.ts`: version read via `importlib.metadata`, editor selection equals the `def get(` line |
| Cursor on `d.get` where `d: dict` shows a `runtime_doc` card for `dict.get` | ✅ | `10_api.test.ts`; also `server/tests/test_resolve.py`, both via the typeshed-style stub (step 2) and via the local annotation (step 5) |
| The I3 property test passes over the entire fixture index | ✅ | `server/tests/test_property_i3.py`: every fact produced for every chunk (requests, attrs, deps, stdlib, runtime builtins, workspace, history; about 20k chunks) verifies, with 0 failures |
| API-path p95 ≤ 150 ms over 500 replayed frames | ✅ | `eval/run_eval.py`: p95 is 2.4–3.7 ms over 500 replayed API frames |

Indexing throughput: 65 dists plus the standard library (36k chunks) take 23 s on this machine. The target is ≤ 3 min for about 80 dists.

## 2026-10-01 · Phase 2: workspace index and precedent cards, done

**Built**
- The code indexer: `git ls-files`, or a `.gitignore`-aware walk; exclusions; ast chunks; one `git log` pass for metadata.
- Incremental `index/fileChanged` that keeps chunk ids and embeddings for unchanged chunks.
- Embeddings, chosen by the model spike (D-006).
- The vector store (float16 on disk, int8 in memory; D-023), FTS fusion with RRF, `exclude_self`, threshold calibration (D-008), the `edit_pause` trigger and precedent cards.

| Acceptance check | Result | Evidence |
|---|---|---|
| On `eval/queries.jsonl` precedent queries: recall@3 ≥ 0.8 and precision ≥ 0.8 at the calibrated threshold | ✅ with the default hybrid embedder | recall@3 **0.917**, precision **0.829**, MRR 0.903 (45 queries, 9 of them negatives with 0 false positives). The hashing-only fallback, without the model download, reaches 0.639 / 0.828; see Known gaps. |
| Editing a function never shows that same function as a precedent | ✅ | `server/tests/test_query.py` re-queries every fixture function with its own text; `20_precedent.test.ts` covers the editor |
| Saving a file updates its chunks within 2 s | ✅ | `test_query.py::test_saving_a_file_updates_its_chunks_within_2s` and `test_code_index.py` (re-chunk and re-embed take milliseconds) |

## 2026-10-01 · Phase 3: flow quality, done

**Built**
- The `diagnostic` and `explicit` triggers.
- Cancellation, both client and server side.
- The flicker rules: diff by id, a 1.5 s minimum visible time, and a 3 s fade.
- The event logger (2 s batches), edit ticks, the blur proxy, and the metrics report and view with CSV export.

| Acceptance check | Result | Evidence |
|---|---|---|
| Typing stress test (§10) passes | ✅ | `30_flow.test.ts`: 600 keystrokes at 10 chars/s for 60 s in CI, all landed in order. The extension's longest synchronous handler was 0.3 ms (Linux) and 1.4 ms (macOS); the budget is 50 ms. |
| 20 frames in quick succession produce exactly one render, for the last frame | ✅ | `30_flow.test.ts`; also server side, `test_query.py::test_stale_requests_are_abandoned` |
| `referenceRail.showMetrics` displays all `MetricsReport` fields from a seeded event log, and the CSV export matches | ✅ | `30_flow.test.ts`; metrics math in `server/tests/test_memory_metrics.py`; CSV in `extension/test/unit/csv.test.ts` |

Diagnostic queries in the eval: recall@3 1.0, precision 0.83, p95 about 2 ms.

## 2026-10-01 · Phase 4: memory and history, done

**Built**
- Pins (Pinned section) and the Frequent section (≥ 3 opens or explicit queries in 14 days).
- `extraRepos`.
- Git-history recovery of deleted functions: one `cat-file --batch` process per repo, rename detection, and resumable progress through `indexed_history`.

| Acceptance check | Result | Evidence |
|---|---|---|
| Opening the same API card 3 times makes it appear under Frequent | ✅ | `40_memory.test.ts`; `test_memory_metrics.py` |
| A function deleted in the fixture repo's history is found as a precedent with a "deleted in `<sha>`" badge | ✅ | `20_precedent.test.ts` (the badge's sha equals `fixture_history.json`, and Open shows the pre-deletion source); `test_query.py`; the rename `truncate_words` → `shorten_text` is correctly *not* reported |

## Phase 5 (optional): not started
It needs human approval (§0, §12, D-017). `server/rail_server/extract/` is an empty package, and the server has no HTTP client (I4).

## 2026-10-01 · Phase 6: evaluation harness and dogfooding, done

**Built**
- `eval/run_eval.py`: recall@3, MRR, precision at threshold, negative false-positive rate, empty-result rate and latency p50/p95, plus `--calibrate`, `--spike`, `--replay` and `--check`.
- `eval/queries.jsonl`: 108 labeled frames (40 API, 45 precedent, 23 diagnostic; 21 with `expected: []`).
- Session recording (`referenceRail.recordSessions`) and replay.
- The README dogfooding guide.

| Acceptance check | Result | Evidence |
|---|---|---|
| `run_eval.py` runs in CI with networking disabled and fails the build on any regression greater than 5% | ✅ | CI `eval` job: hashing and hybrid configurations against `eval/baseline.json` (D-016), with `RAIL_NO_NETWORK=1` |

Recording and replay are covered by `30_flow.test.ts` (recording) and `server/tests/test_eval_replay.py` (replay).

---

## Invariants

| ID | Covered by |
|---|---|
| I1 (no buffer edits) | `scripts/check_invariants.sh` (grep), eslint `no-restricted-syntax` on `src/`, and `90_invariants.test.ts` (no document changes during a full session except the test's own typing) |
| I2 (every fact has a SourceRef) | pydantic validators on `SourceRef`/`Fact`/`Card` (a card needs ≥ 1 fact); integration tests assert spans |
| I3 (docstring facts verbatim) | `verify_fact` before every card; property test over the whole fixture index; `test_verify.py` |
| I4 (no network by default) | `check_invariants.sh` (no HTTP client imports or dependencies); server tests and eval run with `RAIL_NO_NETWORK=1`; the model download runs only through an explicit command |
| I5 (typing never blocked) | the typing stress test; async server with stale-request dropping; indexing in a separate process |
| I6 (precision over recall) | the confidence gate in `rank()`; cosine gate on precedents; eval negatives show 0 false positives across all three kinds |
| I7 (data stays local) | `check_invariants.sh` (no network calls in the extension); all data under `~/.reference-rail/` |

## Performance budgets (§10)

| Path | Budget | Measured |
|---|---|---|
| Frame build in the extension | ≤ 20 ms | longest synchronous handler 0.3–1.4 ms; lookups capped by a 150 ms deadline |
| Definition and hover resolution | 150 ms hard timeout | `LOOKUP_TIMEOUT_MS = 150`, raced in `symbols.ts` |
| `context/query`, API only | p95 ≤ 150 ms | 2.4–3.7 ms (500 frames) |
| `context/query` with precedent search | p95 ≤ 400 ms | 23–34 ms on the fixture (hybrid). At 200k chunks the vector pass is 93 ms p95 (`test_vectors.py`). |
| Server RSS | ≤ 600 MB | 235 MB with the hybrid model loaded (projected ~410 MB at 200k chunks) |
| `initialize` | < 1 s | 0.3–0.4 s |
| Typing stress | no dropped keys, no task > 50 ms | ✅ (see Phase 3) |

## Known gaps
1. **Precedent quality without the model.** The offline hashing fallback reaches recall@3 0.64, below the 0.8 bar, because hashing can't match paraphrased code. The bar is met only after the one-time **Download Embedding Model**, which `install-local` and the README prompt for.
2. **Calibration is in-sample.** The threshold was chosen on the same 45 precedent queries it is evaluated on (D-008). Dogfooding recordings should be labeled for an out-of-sample check.
3. **Third-party C extensions** (numpy, pandas internals) are not introspected. Their pure-Python wrappers and `.py` sources are indexed (D-004).
4. **Without a language server**, API resolution depends on imports and evident local types (steps 4–5). Pylance or another language server enables steps 1–3.
5. **Packaging.** There is no `.vsix`, because `@vscode/vsce` is not on the allow-list (D-019, needs approval); install with `npm run install-local`.
6. **§14 human-evaluation schedule.** The alternating-days schedule is not enforced by the extension. Users toggle with `Pause / Resume`, and the metrics already split lookups per active hour by rail on and off (D-014).
7. **VS Code itself was not run in the dev container** (download hosts blocked). It was exercised in CI on Linux and macOS, and VSCodium was used locally.
