# 3. Configuration

This document tells how to configure Assistive. Part A is for programmers. It gives the `.env` file, each variable and the VS Code settings. Part B is for developers. It tells how `src/config/env.ts` reads and validates the values.

## Part A: Configure Assistive

## 3.1 The `.env` file

Assistive keeps the API settings in a `.env` file. The file has one `NAME=value` pair on each line. A line that starts with `#` is a comment.

> **Caution:** The `.env` file contains your API keys. Do not commit it. The repository `.gitignore` excludes `.env` and `.env.*`, but it keeps `.env.example`.

> **Note:** The command **Assistive: Set Up the LLM…** writes the LLM values for you. Refer to [2.2.3](02-installation.md#223-set-up-the-llm). Use this chapter to change the other values.

### 3.1.1 Where Assistive looks for the file

Assistive examines these locations in this order. It uses the first file that it can read.

1. The path in the VS Code setting `assistive.envFile`. A `~` at the start changes to your home folder. Only your user settings can set this path. VS Code ignores it in the settings of a workspace (the setting has the scope `machine`).

> **Caution:** This rule protects your API key. Without it, a repository can point `assistive.envFile` to its own `.env` file, with its own `ASSISTIVE_LLM_BASE_URL`. Then a key from your process environment goes to that server.
2. `<repository>/.env`, if the extension is linked from a source checkout. Assistive uses this location only if `.env.example` or `.env` exists in the parent folder of the extension.
3. `~/.assistive/.env`.

If no file exists, Assistive uses the default values and the process environment. The command **Assistive: Open API Configuration** then creates a new file from the template in the first location of the list.

### 3.1.2 Placeholders

Assistive ignores a value that is a placeholder. These values are placeholders:

- an empty value;
- a value that contains `REPLACE_ME`, `REPLACE-ME` or `REPLACEME` (any case);
- a value that contains `YOUR_` or `YOUR-` (any case);
- a value between angle brackets, for example `<api key>`;
- a value with only the letter `x`, for example `xxxx`.

### 3.1.3 When Assistive reads the file again

Assistive reads the file again automatically in these conditions:

- You save the file in the editor.
- A program outside the editor changes, creates or deletes the file. A file system watcher finds the change.
- You change a setting that starts with `assistive.`.

You do not have to restart the editor after a change to the `.env` file.

## 3.2 Variables

### 3.2.1 LLM variables

| Variable | Default | Range | Description |
|---|---|---|---|
| `ASSISTIVE_LLM_BASE_URL` | `https://api.openai.com/v1` | `http://` or `https://` URL | The base URL of an OpenAI-compatible Chat Completions API. Assistive removes slashes at the end. |
| `ASSISTIVE_LLM_API_KEY` | (none) | | The API key. Assistive sends it as `Authorization: Bearer <key>`. |
| `ASSISTIVE_LLM_MODEL` | (none) | | The model name. The model must support tool calls. |
| `ASSISTIVE_LLM_TEMPERATURE` | `0.2` | 0 to 2 | The sample temperature. If the model rejects it, Assistive stops the use of it automatically. |
| `ASSISTIVE_LLM_TIMEOUT_SECONDS` | `120` | 5 to 900 | The maximum time for one request. |
| `ASSISTIVE_LLM_MAX_TOOL_ROUNDS` | `8` | 1 to 30 | The maximum number of tool rounds in one turn. After this number, the LLM must write its summary. |
| `ASSISTIVE_LLM_EXTRA_HEADERS` | (none) | JSON object | Extra HTTP headers, for example `{"HTTP-Referer":"https://example.com"}`. |
| `ASSISTIVE_LLM_EXTRA_BODY` | (none) | JSON object | Extra fields for each request body, for example `{"reasoning_effort":"low"}` or provider options. Assistive ignores the fields that it controls: `model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options` and `response_format`. |
| `ASSISTIVE_LLM_STREAM` | `true` | `false`, `0`, `no` or `off` disable it | Show the replies of the LLM in the panel while it writes them. If the server rejects streaming, Assistive stops the use of it automatically. |

### 3.2.2 Jev variables

| Variable | Default | Range | Description |
|---|---|---|---|
| `ASSISTIVE_JEV_BASE_URL` | `https://api.typesafe.ai/v1` | `http://` or `https://` URL | The Jev base URL. Requests go to `{base}/systemone`. |
| `ASSISTIVE_JEV_API_KEY` | (none) | | The Jev API key. |
| `ASSISTIVE_JEV_MODEL` | `jev-latest` | | The Jev model name. |
| `ASSISTIVE_JEV_TIMEOUT_SECONDS` | `10` | 1 to 120 | The maximum time for one Jev request. |

### 3.2.3 Heartbeat variables

| Variable | Default | Range | Description |
|---|---|---|---|
| `ASSISTIVE_TRIAGE` | `jev` | `jev`, `llm`, `off` | The model that does the triage of each beat. With `llm`, the LLM gives a JSON verdict. With `off`, the heartbeat does no triage. |
| `ASSISTIVE_HEARTBEAT_SECONDS` | `45` | 15 to 3600 | The minimum time between two beats. |
| `ASSISTIVE_INTERRUPT_THRESHOLD` | `0.65` | 0 to 1 | The minimum $P(\text{interrupt})$ from the triage before the LLM examines the change. |
| `ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS` | `90` | 0 to 3600 | The quiet time after an interrupt. A problem with severity $\ge 2.5$ ignores this quiet time. |
| `ASSISTIVE_GRAPH_SYNC_THRESHOLD` | `0.7` | 0 to 1 | The minimum $P(\text{graph out of date})$ that starts a sync. |
| `ASSISTIVE_EXPLAIN_THRESHOLD` | `0.75` | 0 to 1 | The minimum $P(\text{programmer is stuck})$ that starts a recommendation of resources. |

### 3.2.4 Other variables

| Variable | Default | Values | Description |
|---|---|---|---|
| `ASSISTIVE_VERIFY_LINKS` | `true` | `false`, `0`, `no` or `off` disable the check. All other values enable it. | Assistive examines each recommended link before the panel shows it. |

### 3.2.5 Values that are not correct

Assistive does not stop when a value is not correct. It uses a safe value and writes a problem message to the **Assistive** output channel.

| Problem | Result |
|---|---|
| A blank value | Assistive uses the default value. |
| A number that is not a number, for example `abc` | Assistive uses the default value. |
| A number out of range | Assistive uses the nearest limit of the range. For example, `ASSISTIVE_HEARTBEAT_SECONDS=5` becomes 15. |
| `ASSISTIVE_LLM_MAX_TOOL_ROUNDS` with decimals | Assistive rounds the value to the nearest integer. |
| `ASSISTIVE_LLM_EXTRA_HEADERS` or `ASSISTIVE_LLM_EXTRA_BODY` that is not valid JSON, or not a JSON object | Assistive sends no extra headers or fields. |
| `ASSISTIVE_LLM_EXTRA_BODY` with a field that Assistive controls | Assistive ignores that field. |
| `ASSISTIVE_TRIAGE` with an unknown value | Assistive uses `jev`. |

To see the messages, open **View → Output** and select **Assistive**.

### 3.2.6 Process environment

A process environment variable that starts with `ASSISTIVE_` replaces the value from the file. This is useful in CI and in containers. For example, start the editor with `ASSISTIVE_TRIAGE=llm` to use LLM triage for one session.

## 3.3 Example configurations

### 3.3.1 OpenAI and Jev

```dotenv
ASSISTIVE_LLM_BASE_URL=https://api.openai.com/v1
ASSISTIVE_LLM_API_KEY=sk-...
ASSISTIVE_LLM_MODEL=gpt-4.1-mini
ASSISTIVE_JEV_API_KEY=jev-...
```

### 3.3.2 OpenRouter

```dotenv
ASSISTIVE_LLM_BASE_URL=https://openrouter.ai/api/v1
ASSISTIVE_LLM_API_KEY=sk-or-...
ASSISTIVE_LLM_MODEL=qwen/qwen3-coder
ASSISTIVE_LLM_EXTRA_HEADERS={"HTTP-Referer":"https://example.com","X-Title":"Assistive"}
ASSISTIVE_JEV_API_KEY=jev-...
```

### 3.3.3 A local model without Jev

```dotenv
ASSISTIVE_LLM_BASE_URL=http://localhost:11434/v1
ASSISTIVE_LLM_API_KEY=ollama
ASSISTIVE_LLM_MODEL=qwen2.5-coder:14b
ASSISTIVE_TRIAGE=llm
```

> **Note:** The API key must not be a placeholder, also for a local server that does not examine keys. Any short word, for example `ollama`, is sufficient.

## 3.4 VS Code settings

Open the settings with **File → Preferences → Settings** and search for `assistive`.

| Setting | Default | Description |
|---|---|---|
| `assistive.envFile` | (empty) | The path to the `.env` file. Empty means `<repository>/.env`, then `~/.assistive/.env`. Only user settings can set it. |
| `assistive.autoDraft` | `true` | Draft the graph automatically when you complete the module docstring of a file that has no graph. |
| `assistive.codeLens` | `true` | Show your progress and the next piece to type above the module docstring. |
| `assistive.heartbeat.enabled` | `true` | Turn the heartbeat on or off. The **Pause** button changes this setting. |
| `assistive.notifications` | `toast` | `panel`: interrupts show only in the panel and as a squiggle. `toast`: a notification also shows when the panel is hidden. |
| `assistive.languages` | `python`, `typescript`, `typescriptreact`, `javascript`, `javascriptreact`, `go`, `rust`, `java` | The VS Code language IDs where Assistive works. |

### 3.4.1 Key bindings

| Key | Command | Condition |
|---|---|---|
| `Ctrl+Alt+G` | **Assistive: Focus the Graph Panel** | Always |
| `Ctrl+Alt+/` | **Assistive: Tell the Assistant…** | The editor has the focus |

## Part B: How the code reads the configuration

The module is `src/config/env.ts`. It has no `vscode` import, so the unit tests can call it directly. The controller gives it the paths (refer to [Controller](15-controller.md#152-configuration-and-clients)).

## 3.5 Data types

| Type | Fields |
|---|---|
| `LlmConfig` | `baseUrl`, `apiKey`, `model`, `temperature`, `timeoutMs`, `maxToolRounds`, `extraHeaders`, `extraBody`, `stream` |
| `JevConfig` | `baseUrl`, `apiKey`, `model`, `timeoutMs` |
| `HeartbeatConfig` | `intervalMs`, `interruptThreshold`, `cooldownMs`, `graphSyncThreshold`, `explainThreshold` |
| `AssistiveConfig` | `llm`, `jev`, `triage`, `heartbeat`, `verifyLinks`, `llmReady`, `jevReady`, `problems`, `source` |

The code keeps all times in milliseconds. The `.env` file gives them in seconds.

## 3.6 Functions

### 3.6.1 `isPlaceholder(value)`

This function returns `true` for an absent or empty value. It also returns `true` if the value matches the regular expression `/REPLACE[_-]?ME|YOUR[_-]|<.*>|^x+$/i`.

### 3.6.2 `parseConfig(vars, source?)`

This function is pure. It changes a map of variable names to values into an `AssistiveConfig`. It does these steps:

1. It reads each string with `get(key, default)`. A value that is absent or blank after trim gives the default.
2. It parses `ASSISTIVE_LLM_EXTRA_HEADERS` and `ASSISTIVE_LLM_EXTRA_BODY` as JSON (function `jsonObject`). It accepts only objects. It changes each header value to a string. It removes the reserved fields from the body (`RESERVED_BODY_FIELDS`) and adds a problem for each one.
3. It reads each number with `num(vars, key, fallback, problems, min, max)`. The function `num` returns the fallback for a blank value. It returns the fallback and adds a problem for a value that is not finite. It clamps a value out of range and adds a problem.
4. It removes slashes at the end of the two base URLs.
5. It changes the triage value to lower case and accepts `jev`, `llm` or `off`.
6. It sets `verifyLinks` and `llm.stream` to `false` only for `false`, `0`, `no` or `off` (function `isFalse`).
7. It sets `llmReady` if the key and the model are not placeholders. The base URL must also start with `http://` or `https://`.
8. It sets `jevReady` if the key is not a placeholder and the base URL starts with `http://` or `https://`.
9. It adds a problem if the LLM is not ready. It adds a problem if the triage is `jev` and Jev is not ready.

### 3.6.3 `envCandidates(setting, extensionPath, home?)`

This function returns the list of locations in [3.1.1](#311-where-assistive-looks-for-the-file). It resolves the real path of the extension folder with `fs.realpathSync`. Thus a linked install finds the repository folder, not the editor extensions folder.

### 3.6.4 `loadConfig(candidates, env?)`

This function reads each candidate in order with the `dotenv` parser. The first file that it can read wins. It then puts the `ASSISTIVE_*` variables of the process environment over the file values (function `overlay`). If no file is readable, it uses the process environment only.

### 3.6.5 `ensureEnvFile(file)`

This function creates the folder and writes `ENV_TEMPLATE` to the file if the file does not exist. It sets the mode to `0o600`. It returns the path.

### 3.6.6 `ENV_TEMPLATE`

This constant is the text of a new `.env` file. The file `.env.example` at the repository root must be the same text. The unit test `test/unit/envExample.test.ts` makes sure of this. If you change one, change the other.

### 3.6.7 The setup wizard (`setup.ts`)

The file `config/setup.ts` holds the wizard. It does not import `vscode`: the controller gives it a `SetupUi` with `pick` and `input`. Thus the unit tests run the wizard with a script.

| Function | Function |
|---|---|
| `runSetup(ui, deps)` | Asks for the endpoint, the key and the model. If the triage is `jev` and Jev is not set up, it also asks for the triage. It returns the `.env` values to write, or `undefined` if the programmer cancels before the model is set. |
| `listModels(baseUrl, apiKey, opts?)` | Sends `GET <baseUrl>/models` with the key. The controller adds the extra headers only if the endpoint did not change. Returns the model IDs. The time limit is 8 seconds. |
| `chatModels(ids)` | Removes duplicates and the models whose names show embeddings, speech or images. Sorts the rest. If nothing stays, it returns all IDs. |
| `quoteEnvValue(value)` | Returns the value without quotes if `dotenv` reads it without change. If not, it puts single quotes, backticks or double quotes around it. It refuses a value with a line break. |
| `setEnvValues(text, updates)` | Replaces the first `KEY=` or `export KEY=` line of each key. It adds the keys that are not in the text. Comments, other keys and the line endings stay. |

These rules apply in `runSetup`:

- **Key.** If the endpoint does not change and the current key is not a placeholder, an empty answer keeps the current key. Ollama and LM Studio receive a fixed key (`ollama`, `lm-studio`), because the client needs a key.
- **Model.** The list marks the current model. The first item, **Type a model name…**, opens an input box. If the list fails, the input box shows the reason.
- **Triage.** If the programmer cancels the triage question, the LLM values are still written. The triage setting does not change.

The controller writes the values with `setEnvValues` to the current `.env` file. If there is no file, it first creates one from the template. The file watcher then reloads the configuration.

## 3.7 Constants

| Constant | Value | Use |
|---|---|---|
| `MIN_HEARTBEAT_SECONDS` | 15 | The lower limit of `ASSISTIVE_HEARTBEAT_SECONDS` |
| `DEFAULT_HEARTBEAT_SECONDS` | 45 | The default interval |
