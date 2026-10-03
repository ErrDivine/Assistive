# 17. Extend Assistive

This document gives procedures for common changes to the code. Each procedure lists the files to change and the tests to add.

Before you start, read [Architecture](06-architecture.md). After each change, do the procedure in [Build, test and CI](16-build-and-test.md#169-procedure-examine-a-change-before-a-commit).

> **Caution:** Do not add code that edits the buffers of the programmer. The lint rule for invariant I1 stops the build. Do not remove or weaken this rule.

## 17.1 Add a tool for the LLM

1. Open `src/llm/tools.ts`.
2. Find the family of the tool: look, graph, talk or heartbeat. Add the tool to the function of that family (`lookTools`, `graphReadTools`, `graphEditTools`, `talkTools` or `heartbeatTools`).
3. Write the tool with the `tool<Args>({ name, description, parameters, run })` helper:
   - Use a `snake_case` name that starts with a verb.
   - Write the description for the model. Tell what the tool does, when to use it, and what it returns.
   - Write the parameters as a JSON Schema object with `additionalProperties: false`.
   - Use `enum` for each closed list. Use `minimum`, `maximum`, `minItems`, `maxItems` and `minLength` for limits.
   - Use 1-based line numbers in the parameters and the result.
4. In `run`, return plain text:
   - Start the text with `error:` for a failure, and tell the model what to do next.
   - For a batch, return one `ok:` or `error:` line for each item.
   - For a long result, tell the model how to read the next page, for example "call again with start_line=401".
5. If the tool reads a file, resolve the path with the `resolve` helper of `lookTools`. This applies the workspace and secret rules.
6. If the tool shows something to the programmer, call `env.emit(item)` with a `NewFeedItem`.
7. Add the tool to the correct modes in `toolsFor`. Give each mode only the tools that it needs.
8. Add a test to `test/unit/tools.test.ts` with a `MemoryWorkspace`.
9. Add the tool to the [Tool reference](10-tool-reference.md) and to the table in section 10.2.

## 17.2 Add a new kind of feed item

1. Open `src/types.ts`.
2. Add a new member to the `FeedItem` union, with a new `kind` value and its fields.
3. Open `src/panel/webview/panel.ts`.
4. Add a `case` for the new kind to `renderItem`. Encode all text with `esc`, or render Markdown with `md`.
5. Add the CSS for the item to `panel.css`. Use the theme tokens, not fixed colors.
6. If the item has buttons, add the messages (refer to [17.3](#173-add-a-panel-message)).
7. Run `npm run typecheck`. The compiler finds each `switch` that must handle the new kind.

## 17.3 Add a panel message

1. Open `src/types.ts`.
2. Add the message to `FromPanel` (webview to host) or `ToPanel` (host to webview).
3. For a `FromPanel` message:
   1. Send it in `panel.ts` with `post({ type: "…", … })`.
   2. Handle it in `Controller.panelMessage` in `src/controller.ts`.
   3. Validate each value from the webview. For example, open only `http` and `https` URLs.
4. For a `ToPanel` message:
   1. Send it with `PanelProvider.post` in the host.
   2. Handle it in the `message` listener at the end of `panel.ts`.
5. Add the message to the tables in [Panel](14-panel.md#143-message-protocol).

## 17.4 Add a Jev question

1. Open `src/heartbeat/policy.ts`.
2. Add the question to `JEV_QUESTIONS`. Use the type that fits the answer:
   - `noul` for a yes or no probability;
   - `choice` for one option of a closed list, with a description for each option;
   - `score` for a level on a scale, with a description for each level from 0 up.
3. Write instructions that name the fields of the state (for example `recent_change` and `current_scope_code`).
4. Add a field for the answer to `TriageVerdict`.
5. Read the answer in `verdictFromJev` with `noul`, `choice` or `score` from `llm/jev.ts`. Give a safe default.
6. Add the field to `TRIAGE_JSON_SYSTEM` in `src/llm/prompts.ts` and to `verdictFromLlmJson`, so that LLM triage gives the same field.
7. If the answer changes the decision, add the rule to `decide`. Add a threshold to `HeartbeatConfig` and to `src/config/env.ts` if the programmer must be able to change it.
8. Add tests to `test/unit/policy.test.ts`. The function `jevAnswers` in the fake server answers new questions automatically.

> **Note:** Each question adds work for Jev on each beat. Keep the number of questions small.

## 17.5 Add a configuration variable

1. Open `src/config/env.ts`.
2. Add the field to the correct config type.
3. Read the value in `parseConfig`. For a number, use `num(…)` with a range. A bad value then gives a problem message and a safe value.
4. Add the variable with a comment to `ENV_TEMPLATE`.
5. Copy the full text of `ENV_TEMPLATE` to `.env.example` at the repository root. The test `envExample.test.ts` fails if the two texts are different.
6. Add tests to `test/unit/env.test.ts`.
7. Add the variable to [Configuration](03-configuration.md) and to the table in `README.md`.

## 17.6 Add a language

The outline is the base of all features. A new language needs an outline.

1. Find a tree-sitter grammar for the language. The package `@vscode/tree-sitter-wasm` contains several grammars.
2. In `esbuild.mjs`, add the WASM file of the grammar to the list of files that the build copies.
3. In `src/code/treesitter.ts`:
   1. Add the grammar name to the `Grammar` type.
   2. Map the VS Code language ID to the grammar in `grammarFor`.
4. In `src/code/outline.ts`:
   1. Add a function for the module docstring of the language, and call it from `moduleStringOf`.
   2. Add functions for the symbols and the imports. Set `isStub` for placeholder bodies.
   3. Call these functions from `outline`.
5. In `src/code/workspace.ts`, add the file extensions to `LANG_BY_EXT`.
6. In `src/code/context.ts`, add the import rules of the language to `resolveImport`.
7. In `package.json`:
   1. Add an `onLanguage:<id>` activation event.
   2. Add the language ID to the default of `assistive.languages`.
8. In `src/controller.ts`, add the language ID to the default list in `supported`.
9. Add tests to `test/unit/outline.test.ts` with real code in the language.

## 17.7 Change the prompts

1. Open `src/llm/prompts.ts`.
2. Change `SYSTEM` for rules that apply to all modes. Change the text of one mode for rules of that mode.
3. Keep these rules of the product in `SYSTEM`:
   - The programmer types every line of code.
   - The graph changes only through the graph tools.
   - The model looks before it acts and never invents APIs.
   - Each turn ends with a short summary.
4. If you change the first line of a mode text (for example "Task: draft the implementation graph"), change `scriptedAssistant` in `test/support/fakeServers.ts` too. The fake LLM finds the mode from this line.
5. Run the unit tests and the integration tests.
