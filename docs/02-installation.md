# 2. Installation

This document tells how to build Assistive from the source, install it in your editor, and make sure that it works. It also tells how to update and remove it.

## 2.1 Requirements

| Item | Requirement |
|---|---|
| Editor | VS Code 1.101 or newer, VS Code Insiders, VSCodium or Cursor |
| Build tools | Node.js 22 or newer and npm |
| Source control | Git |
| LLM | An endpoint with an OpenAI-compatible Chat Completions API and tool calls, an API key and a model name |
| Jev (optional) | A Jev API key from TypeSafe AI |
| Operating system | Linux, macOS or Windows |

## 2.2 Install from the source

> **Note:** The script links the `extension/` folder into the editor. If you move or delete the source folder, the editor cannot find the extension. Use `--copy` to install an independent copy.

1. Clone the repository:

   ```sh
   git clone https://github.com/ErrDivine/Assistive
   ```

2. Go to the extension folder:

   ```sh
   cd Assistive/extension
   ```

3. Install the dependencies:

   ```sh
   npm ci
   ```

4. Build and install the extension:

   ```sh
   npm run install-local
   ```

5. Open the `.env` file that the script created. The script prints the path. For a linked install, the path is `Assistive/.env`.
6. Replace each `REPLACE_ME` value with your data. Refer to [Configuration](03-configuration.md).
7. Save the `.env` file.
8. Restart the editor.

### 2.2.1 Options of the install script

| Option | Effect |
|---|---|
| `--editor code` | Install into VS Code (the default). The folder is `~/.vscode/extensions`. |
| `--editor insiders` | Install into VS Code Insiders. The folder is `~/.vscode-insiders/extensions`. |
| `--editor codium` | Install into VSCodium. The folder is `~/.vscode-oss/extensions`. |
| `--editor cursor` | Install into Cursor. The folder is `~/.cursor/extensions`. |
| `--copy` | Copy `package.json`, `dist/` and `media/` instead of a link. The script then creates the `.env` file in `~/.assistive/.env`. |

Give the options after `--`, for example:

```sh
npm run install-local -- --editor codium --copy
```

### 2.2.2 What the install script does

The script is `extension/scripts/install-local.mjs`. It does these steps:

1. If `node_modules/` does not exist, it runs `npm ci`.
2. It runs `node esbuild.mjs --production`. This makes a minified bundle without source maps.
3. It removes the old install folder, if one exists. The folder name is `<publisher>.<name>-<version>`, for example `errdivine.assistive-0.2.0`.
4. It links the `extension/` folder into the editor extensions folder. On Windows, it makes a directory junction. With `--copy`, it copies the built files instead.
5. If the `.env` file does not exist, it copies `.env.example` to the `.env` file. It sets the file mode to `600`, so only your user can read it.
6. It prints the next steps.

### 2.2.3 Set up the LLM

1. Open the Command Palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS).
2. Run **Assistive: Set Up the LLM…**. You can also click the yellow **LLM** pill in the panel.
3. Select the endpoint: OpenAI, OpenRouter, Ollama, LM Studio, or a different OpenAI-compatible endpoint.
4. For a different endpoint, type its base URL. The URL usually ends in `/v1`.
5. Type the API key. Ollama and LM Studio do not need a key, so the wizard does not ask for one.
6. Select a model from the list that the endpoint returns. If the endpoint cannot list its models, type the model name.
7. If Jev is not set up, select how the heartbeat triages your edits: with the LLM, with a Jev key, or off.

The wizard writes the values to the `.env` file and tests the connection. To edit the file yourself, refer to [Configuration](03-configuration.md).

> **Note:** The model must support tool calls. The wizard does not show embedding, speech and image models.

## 2.3 Make sure that the installation works

1. Open the Command Palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS).
2. Run **Assistive: Test LLM and Jev Connections**.
3. Read the result in the notification.

A good result looks like this:

```text
LLM gpt-4.1-mini: OK in 812 ms  ·  Jev jev-latest: answered in 143 ms (p=0.71)
```

If a line shows an error, the notification shows the buttons **Set Up…** and **Open .env**. Refer to [Troubleshooting](05-troubleshooting.md).

### 2.3.1 What the test does

- **LLM test:** The extension sends one message, "Reply with the single word OK.", without tools. It shows the first 40 characters of the reply and the time.
- **Jev test:** The extension sends one `noul` question about the line `total = sum(prices) / len(prices)`. It shows the model name, the time and the probability.

## 2.4 First use

1. Open a folder in the editor.
2. Create a new Python file, for example `wc.py`.
3. Open the panel with `Ctrl+Alt+G`, or click the Assistive icon in the activity bar.
4. Type a module docstring at the top of the file, for example:

   ```python
   """Count the most common words in a text file and print them."""
   ```

5. Wait approximately three seconds. The panel shows "Drafting the graph…" and then the graph.

For the full procedures, refer to the [User guide](04-user-guide.md).

## 2.5 Update Assistive

1. Go to the repository folder.
2. Pull the latest code:

   ```sh
   git pull
   ```

3. Go to the `extension/` folder.
4. Run `npm ci`.
5. Run `npm run install-local`. The script keeps the `.env` file that exists.
6. Restart the editor.

## 2.6 Remove Assistive

1. Close the editor.
2. Delete the install folder, for example `~/.vscode/extensions/errdivine.assistive-0.2.0`.
3. If you do not need the keys again, delete the `.env` file (`Assistive/.env` or `~/.assistive/.env`).
4. Optional: delete the saved graphs. They are in the workspace storage folder of the editor, in `<workspaceStorage>/<id>/errdivine.assistive/graphs/`.

> **Note:** Assistive never writes graphs or conversations into your repository. They stay in the storage folder of the editor.
