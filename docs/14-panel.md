# 14. Panel (`src/panel/`)

This document describes the side panel. The panel has two parts. The **host part** (`PanelProvider.ts`) runs in the extension host. The **webview part** (`webview/index.html`, `panel.ts`, `panel.css`) runs in a separate browser context. The two parts talk only with messages.

| File | Runs in | Function |
|---|---|---|
| `panel/PanelProvider.ts` | Extension host | Makes the webview, loads the HTML, sends the state, receives the actions. |
| `panel/webview/index.html` | Webview | The page template with the Content Security Policy. |
| `panel/webview/panel.ts` | Webview | Draws the graph, the steps, the details, the feed and the input box. |
| `panel/webview/panel.css` | Webview | The layout and the colors, from the VS Code theme. |

The webview is stateless with respect to data. All data comes from the host in a `state` message. The webview keeps only view state: the selected tab and the selected node.

## 14.1 Contribution in `package.json`

- An activity bar container with the ID `assistive`, the title "Assistive" and the icon `media/graph.svg`.
- A webview view with the ID `assistive.panel` and the name "Implementation Graph".
- The controller registers the view with `retainContextWhenHidden: true`. The webview keeps its graph and its scroll position when the panel is hidden.

## 14.2 The host part (`PanelProvider.ts`)

### 14.2.1 `resolveWebviewView(view)`

VS Code calls this method when the panel opens the first time. The method does these steps:

1. It sets the webview options: scripts are enabled, and the webview can load files only from `dist/webview/`.
2. It makes a nonce: 16 random bytes in base64.
3. It reads `dist/webview/index.html` and replaces the placeholders:
   - `{{cspSource}}` with the CSP source of the webview;
   - `{{nonce}}` with the nonce;
   - `{{scriptUri}}` with the webview URI of `panel.js`;
   - `{{styleUri}}` with the webview URI of `panel.css`.
4. It listens for messages. When the webview sends `ready`, the method marks the webview as ready and sends the last state again. It gives each message to the controller.
5. It forwards the visibility changes as the event `onDidChangeVisibility`.
6. When the view closes, it clears the view and the ready flag.

### 14.2.2 Other members

| Member | Function |
|---|---|
| `viewId` | `"assistive.panel"`. |
| `visible` | `true` if the view exists and is visible. |
| `setState(state)` | Keeps the state as the last state and sends it. |
| `post(message)` | Sends a message only if the view exists and is ready. A message before `ready` is not sent. `setState` sends the last state again on `ready`. |
| `reveal(focusInput?)` | Runs the command `assistive.panel.focus`. With `focusInput`, it waits up to 2 seconds (20 × 100 ms) for the webview to become ready, and then sends `focusInput`. |
| `dispose()` | Removes the listeners. |

## 14.3 Message protocol

### 14.3.1 Host to webview (`ToPanel`)

| Message | Effect |
|---|---|
| `{type: "state", state}` | Draws the full `PanelState`. |
| `{type: "focusInput", text?}` | Puts the focus in the input box. With `text`, replaces the content of the box. |
| `{type: "stream", text?}` | Shows the reply that the LLM writes now, as a temporary item at the end of the feed. Without `text`, removes the item. |
| `{type: "selectNode", id}` | Selects a node. The protocol has this message, but the current host code does not send it. |

### 14.3.2 Webview to host (`FromPanel`)

| Message | Sent by | Controller action |
|---|---|---|
| `ready` | The script, at start | Sends the state. |
| `send` (`text`) | **Send** button, `Enter` | `Assistant.chat` |
| `draft` | **Draft**, **redraft?**, **Draft the graph** | `Assistant.draft` |
| `sync` | **Sync** | `Assistant.sync` |
| `undo` | **Undo** | `GraphStore.undo` |
| `beatNow` | **♥ Check now** | `Heartbeat.beat` |
| `toggleHeartbeat` | **Pause** / **Resume** | Changes `assistive.heartbeat.enabled`. |
| `cancel` | **Stop** on the busy line | `Assistant.cancel` for the active file. |
| `pickFile` | A click on the file name in the header | `Controller.openPlannedFile` |
| `openConfig` | **⚙**, a yellow pill, **Open .env** | Opens the `.env` file. |
| `goto` (`line`, `endLine?`, `path?`) | **Go to code**, double-click, **Show line**, code references | Opens the file and selects the line. |
| `openLink` (`url`) | Resource links, links in Markdown | Opens `http` and `https` URLs in the browser. |
| `dismiss` (`id`) | **Got it** | Closes the interrupt as dismissed. |
| `explain` (`id`) | **Explain more** | `Assistant.explain` |
| `answer` (`id`, `option`) | An answer button | Records the answer and sends a chat message. |
| `copy` (`text`) | **Copy signature** | Writes the text to the clipboard. |

The lines in messages are 0-based.

## 14.4 The page (`index.html`)

The page has four areas:

1. `header#top`: the file name, the pills, the toolbar and the docstring line.
2. `section#graph-section`: the tabs, the legend and the fit button. It also has the graph container `#cy`, the steps list `#steps`, the empty message `#graph-empty` and the details box `#details`.
3. `section#feed`: the feed. It has `aria-live="polite"`, so a screen reader announces new items.
4. `footer#compose`: the busy line with a spinner and a **Stop** button, and the input box with the **Send** button.

The Content Security Policy of the page is:

```text
default-src 'none';
img-src {{cspSource}} data:;
style-src {{cspSource}} 'unsafe-inline';
font-src {{cspSource}};
script-src 'nonce-{{nonce}}';
```

Only the script with the nonce can run. The page cannot load content from the network.

## 14.5 The script (`panel.ts`)

The build bundles the script with cytoscape, cytoscape-dagre, marked and DOMPurify into one IIFE file (`dist/webview/panel.js`). The script imports only types from `types.ts` and the function `orderedNodes` from `graph/order.ts`.

### 14.5.1 View state

- `state`: the last `PanelState`.
- `tab`: `graph` or `steps`.
- `selected`: the ID of the selected node.
- `structureKey`: a key of the graph structure (refer to [14.5.4](#1454-graph-drawing)).

`vscode.setState` keeps `tab` and `selected`. They survive a reload of the webview.

### 14.5.2 Utilities

| Function | Function |
|---|---|
| `esc(s)` | Replaces `&`, `<`, `>`, `"` and `'` with HTML entities. The script uses it for each text that goes into HTML. |
| `md(text)` | Changes Markdown into HTML with `marked` (GitHub style, line breaks kept), then removes unsafe HTML with `DOMPurify`. |
| `time(ts)` | Shows the time as hours and minutes. |
| `el(tag, class, html)` | Makes an element. |
| `button(label, class, onClick, title)` | Makes a button. The click does not go to the parent element. |

### 14.5.3 Theme colors

`palette()` reads the colors from the CSS variables of VS Code, with a fallback value for each:

| Use | Variable |
|---|---|
| Text | `--vscode-foreground` |
| Muted text, `planned` border | `--vscode-descriptionForeground` |
| Background | `--vscode-sideBar-background` |
| Node fill | `--vscode-editor-background` |
| Edges | `--vscode-editorLineNumber-foreground` |
| Selection | `--vscode-focusBorder` |
| `stubbed` | `--vscode-charts-yellow` |
| `done` | `--vscode-charts-green` |
| `attention` | `--vscode-charts-red` |
| Font | `--vscode-font-family` |

`graphStyle()` makes the Cytoscape style sheet from the palette. A `MutationObserver` on the class of `body` applies the style again when the theme changes.

### 14.5.4 Graph drawing

**Node size.** `nodeSize(text)` measures the label with a canvas at 11 px. It wraps the words at 150 px. The width is from 56 px to 172 px. The height is $14 \times \text{lines} + 14$ px.

**Label.** `nodeText` puts the step number before the label, for example `2. count_words`. The step number comes from `orderedNodes`.

**Next node.** The next node from `progress` has the class `next`. The style gives it an underlay (a halo) in the accent color.

**Structure key.** The key is the file, the sorted node IDs and the sorted edges. `renderGraph(graph)` compares the new key with the old key:

- **Same key:** the script changes only the data and the classes of the elements. The layout does not run again, so the nodes do not jump when a status changes.
- **New key:** the script removes all elements, adds the new elements, and runs the layout.

**Layout.** `layout()` runs `dagre` with these options: top to bottom, node separation 24, rank separation 46, edge separation 8, no animation. Then `fit()` fits the graph into the view with a padding of 12 px. If the zoom is more than 1.3, it sets the zoom to 1.3 and centers the graph. The layout runs only on the **Graph** tab.

**Resize.** When the graph area changes size (the panel, or the details box), the script fits the graph again. It does not do this after the programmer zoomed with the mouse wheel or panned the background, until the next layout.

**Cytoscape options.** Minimum zoom 0.3, maximum zoom 2.5, wheel sensitivity 0.25, no box selection.

**Events.**

- A tap on a node selects it.
- A tap on the background clears the selection.
- A double tap on a node sends `goto` if the node has a line.

**Selection.** `select(id)` selects the node and dims all elements outside its closed neighborhood (the node, its edges and its neighbors). Then it draws the details.

### 14.5.5 Steps, details, header and empty message

- `renderSteps(graph)` lists the nodes in typing order. Each item shows the label, the status and the signature. The next node (from `progress`) has the class `next` and a **next** badge. A click selects. A double-click sends `goto`.
- `render(state)` sets the label of the Steps tab to **Steps done/total**, with the next node in the tooltip.
- `renderDetails()` shows the selected node (refer to [User guide](04-user-guide.md#413-node-details)). The buttons are directly under the title, so they stay visible when the details box scrolls. It shows **Review** for a node whose code is done or flagged, and **Hint** for the other nodes. Both buttons send a `send` message with a fixed request (`hintRequest`, `reviewRequest`). An edge from the node shows as "calls **x**". An edge to the node shows as "**y** calls it".
- `renderHeader(state)` draws the file name and the three pills. It sets the button states:

  | Button | Not available if |
  |---|---|
  | **Draft** / **Redraft** | The file is not supported, there is no docstring, or a task runs. |
  | **Sync** | There is no graph, or a task runs. |
  | **Undo** | The undo history is empty, or a task runs. |
  | **♥ Check now** | The file is not supported, or the heartbeat is `off`. |

  The docstring line shows the docstring with "…" if it is not closed. If the docstring is closed and different from the docstring of the graph, the line adds "docstring changed since the draft, **redraft?**".
- `renderEmpty(state)` shows a message in the graph area when there is no graph. The message depends on the state:
  - no file;
  - a language that is not supported;
  - a task in progress;
  - no docstring (the message shows an example);
  - a docstring that is not closed;
  - an LLM that is not configured (the message has an **Open .env** button);
  - all other cases (the message has a **Draft the graph** button).

### 14.5.6 Feed drawing

`renderFeed(feed, fileChanged)` updates the feed without a full redraw:

1. If the file changed, it clears the feed.
2. If the feed is empty, it shows the welcome text with the four steps of the workflow.
3. It removes the elements of items that are not in the feed.
4. For each item, it compares the JSON text of the item with the JSON text of the last draw. It draws only new and changed items, at the correct position.
5. It scrolls to the bottom in two cases: the file changed, or it added an item while the view was less than 60 px from the bottom.

`renderItem(item)` draws one item by its `kind`. An assistant reply with graph changes has a line such as "Graph: +2 nodes, −1 removed". If nodes were removed with a reason, the tooltip of that line shows the reasons. An interrupt has a CSS class for its severity (`sev-1` to `sev-3`) and its status. It has an icon for its issue kind, for example ✎ for `typo` and 🔒 for `security`. Its buttons show only while it is open.

### 14.5.7 Streamed reply

`renderStream(text)` shows the reply that the LLM writes now. The element has the classes `item assistant streaming` and stays after the last feed item. The text is Markdown, cleaned by `DOMPurify`. A CSS rule adds a cursor that blinks. Without text, the element goes away. When the turn ends, the real reply arrives in the next `state` message.

### 14.5.8 Input box

- `Enter` sends the text. `Shift+Enter` adds a line. During IME composition, `Enter` does not send.
- The box grows with the text, up to 140 px.
- `send()` sends nothing if the box is empty or the file is not supported.
- The box is disabled if the file is not supported.

### 14.5.9 Other listeners

- A click on a link inside Markdown text sends `openLink` for `http` and `https` URLs. The webview never opens a link itself.
- A `ResizeObserver` on the graph area calls `cy.resize()`.
- At start, the script selects the saved tab and sends `ready`.

## 14.6 The style sheet (`panel.css`)

- **Tokens.** `:root` defines `--planned`, `--stubbed`, `--done`, `--attention`, `--accent`, `--muted`, `--border`, `--card` and `--hover` from the VS Code variables. Thus the panel follows the light, dark and high-contrast themes.
- **Layout.** The body is a vertical flex box with the height of the view. The graph section can shrink (`flex: 0 1 auto; min-height: 0`), so the input box always stays visible. The graph area starts at 42% of the view height, has a minimum of 140 px, and the programmer can resize it vertically. The feed fills the rest of the height and scrolls.
- **Details box.** The details box has a maximum height of 28% of the view. It can shrink to 64 px and then scrolls, so the graph section never cuts it.
- **Tabs.** The tab labels do not wrap. In a narrow panel, the legend moves to its own line.
- **`[hidden]`.** The rule `[hidden] { display: none !important; }` makes sure that a hidden element stays hidden, also if a different rule sets `display`.

## 14.7 Security

- The Content Security Policy permits only the script with the nonce.
- `esc` encodes each text that goes into HTML.
- `DOMPurify` cleans the HTML that `marked` makes from model text.
- Links open only through the host, and only for `http` and `https`.
- The webview can read files only from `dist/webview/`.
