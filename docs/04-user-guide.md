# 4. User guide

This document tells how to use Assistive. Section 4.1 describes the panel. The other sections give step-by-step procedures.

Before you start, install and configure Assistive. Refer to [Installation](02-installation.md) and [Configuration](03-configuration.md).

## 4.1 The panel

To open the panel, push `Ctrl+Alt+G` or click the Assistive icon in the activity bar. The panel has four areas, from the top to the bottom.

| Heartbeat interrupt | Steps and node details |
|---|---|
| ![An interrupt card in the feed and a flagged node](images/panel-interrupt.png) | ![The Steps tab and the details of a node](images/panel-steps.png) |

### 4.1.1 Header

| Item | Function |
|---|---|
| File name | The workspace-relative path of the file that the panel shows. |
| **LLM** pill | Green: the LLM is configured. Yellow: the LLM is not configured. Red: the last LLM request failed. Click a yellow or red pill to open the `.env` file. |
| **Jev** pill | Green: Jev is configured. Yellow: the Jev key is not there. Red: the last Jev request failed. Grey: the triage is `llm` or `off`. |
| **♥ 45s** pill | The heartbeat is on, with its interval. The tooltip shows the time and the verdict of the last beat. "♥ paused" means that the heartbeat is off. |
| **Draft** / **Redraft** | Draft the graph from the module docstring. The label is **Redraft** when the file has a graph. |
| **Sync** | Ask the LLM to make the graph agree with the code. |
| **Undo** | Restore the graph before the last change. |
| **♥ Check now** | Run one beat now. |
| **Pause** / **Resume** | Turn the heartbeat off or on. |
| **⚙** | Open the `.env` file. |
| Docstring line | The module docstring. Click it to show all of the text. A "…" at the end means that the docstring is not complete. If the docstring changed after the draft, the line shows **redraft?**. |

### 4.1.2 Graph area

The graph area has two tabs:

- **Graph** shows the nodes and edges in a top-to-bottom layout. The number before a label is the position of the node in the typing order.
- **Steps** shows the nodes in typing order, with the status and the signature of each node.

The legend shows the colors of the statuses. The **⤢** button fits the graph into the area again. Drag the bottom edge of the area to change its height.

**Statuses:**

| Status | Look | Description |
|---|---|---|
| planned | Dashed border | The symbol is not in the code. |
| stubbed | Yellow | The symbol exists, but its body is a placeholder: `pass`, `...`, `raise NotImplementedError`, an empty `{}`, or `throw new Error("not implemented")`. |
| done | Green, thick border | The symbol has a real body. |
| attention | Red, thicker border | An interrupt flagged a problem in this node. |

**Node shapes:**

| Shape | Node kind |
|---|---|
| Rounded rectangle | `function`, `method`, `class` (bold), `module` (bold) |
| Cut rectangle, dotted, grey text | `external` |
| Barrel | `data` |
| Ellipse | `step` |
| Hexagon | `test` |
| Tag | `constant` |

**Edges:** A `contains` edge is dashed and has no arrow. A `depends` edge is dotted. All other edges are solid lines with an arrow.

**Mouse actions:**

- Click a node to select it. The panel dims the nodes that are not its neighbors, and shows its details.
- Click the empty background to clear the selection.
- Double-click a node to go to its code, if the code exists.
- Use the mouse wheel to zoom. Drag the background to move the graph.

### 4.1.3 Node details

When you select a node, the details box shows:

- the label, the kind, the status and the line number;
- the signature;
- the description;
- the technical notes;
- the reason for the flag, if the status is `attention`;
- the edges to and from the node.

The box has three buttons:

| Button | Function |
|---|---|
| **Go to code** | Open the code of the node. The button shows "Not typed yet" if the code does not exist. |
| **Copy signature** | Copy the signature to the clipboard. Assistive does not paste it into your file. |
| **Ask about this** | Put "About \`symbol\`: " into the input box. |

### 4.1.4 Feed and input box

The feed shows the conversation and the events for the current file. The newest item is at the bottom.

| Item | Look |
|---|---|
| Your message | Aligned on the right side |
| Assistant reply | Markdown text with a label: "Drafted", "Synced", "Heartbeat" or "Assistant". A line such as "Graph: +4 nodes, +3 edges" shows the graph changes. |
| Interrupt | A card with the issue kind, the line number, a title, a message and three buttons. The color shows the severity. |
| Resources | "📚 Learn: topic" with a list of links. Each link has a type and one sentence about its use. |
| Question | A question from the LLM, with buttons for the answers. |
| Code reference | A link to lines in a file, with a note. |
| System note | An information, warning or error message from Assistive. |

The input box is at the bottom. Push `Enter` to send. Push `Shift+Enter` to start a new line. A line with a spinner above the input box shows the current task, for example "Drafting the graph…".

### 4.1.5 Status bar item

The status bar shows an Assistive item on the right side.

| Text | Description |
|---|---|
| Graph icon | Assistive is ready. |
| Spinner and a task | The LLM works, for example "Drafting the graph". |
| Graph icon, warning icon and a number | The number of open interrupts. The background is the warning color. |

Click the item to open the panel.

## 4.2 Draft a graph automatically

Assistive drafts a graph automatically when all of these conditions are true:

- The setting `assistive.autoDraft` is `true`.
- The LLM is configured.
- The file has no graph.
- You typed in the module docstring, or in the line below it.
- The module docstring is complete (closed) and has 15 characters or more.
- Approximately 2.5 seconds passed after your last change.
- Assistive did not try a draft for the same docstring text before.

> **Note:** Assistive does not draft a file that you only open. Use the **Draft** button for a file that has a docstring already.

1. Create or open a Python, TypeScript or JavaScript file.
2. At the top of the file, type a module docstring. Describe what the file must do. Give enough detail, for example the inputs, the outputs and the important rules.

   Python:

   ```python
   """Fetch open issues for a GitHub repository
   and cache them on disk with ETags."""
   ```

   TypeScript or JavaScript:

   ```ts
   /**
    * Rate-limit outgoing HTTP requests with a
    * token bucket shared across callers.
    */
   ```

3. Close the docstring. Type `"""` or `*/` at its end.
4. Wait. The panel shows "Drafting the graph…".
5. Read the summary in the feed. It tells you which node to start with.
6. Examine the graph and the **Steps** tab.

For a group of `//` lines, the comment is complete when a line of code, or an empty line and more text, follows it.

## 4.3 Draft or redraft a graph manually

1. Make sure that the file has a module docstring.
2. Click **Draft** (or **Redraft**) in the panel. You can also run **Assistive: Draft Graph from Module Docstring**.
3. Wait for the summary in the feed.

For a redraft, the LLM keeps the IDs of the nodes that still fit. It changes or removes the other nodes and adds the nodes that are necessary. The previous graph goes on the undo stack.

## 4.4 Change the plan with an instruction

1. Click the input box, or push `Ctrl+Alt+/` in the editor.
2. Type an instruction. Examples:
   - "Split the parse into its own function."
   - "Add a cache with a time limit of 5 minutes."
   - "Remove the CLI part. This module is a library."
3. Push `Enter`.
4. Watch the graph. The changes show while the LLM works.
5. Read the reply in the feed.

> **Note:** A new message, draft or sync stops the LLM turn that is in progress for the same file. Your request has priority. A heartbeat never stops a turn. If a turn is in progress, the heartbeat does not escalate.

## 4.5 Ask a question

1. Type the question in the input box, for example "What is the best way to cache this?".
2. Push `Enter`.
3. Read the answer. If the answer points to lines in your code, click the code reference to go there.

If the question is only a question, the LLM does not change the graph.

To ask about one node, select the node and click **Ask about this**.

## 4.6 Answer a question from the LLM

Sometimes the LLM must know a design decision that only you can make. It then shows a question with two to four answers. It also makes a default choice in the graph and writes it in the notes of the node.

1. Read the question in the feed.
2. Do one of these:
   - Click one of the answer buttons.
   - Click **Answer…** and type your own answer.
3. Read the reply. The LLM changes the graph if your answer is different from its default.

## 4.7 Type the code

1. Open the **Steps** tab to see the typing order.
2. Select the first node to read its signature and notes.
3. Type the code yourself. Optional: click **Copy signature** and paste the signature.
4. Save the file.
5. Look at the status of the node. It changes to **stubbed** or **done**.

The statuses change when you save the file and at each beat. A Python `def` with only `pass` is stubbed. When you add a real body, the node changes to done.

## 4.8 Sync the graph with the code

Use this procedure if you renamed functions, added functions that the plan does not have, or abandoned parts of the plan.

1. Click **Sync**, or run **Assistive: Sync Graph with Code**.
2. Read the reply. The reply is "Graph already matches the code." if the LLM changed nothing.

The heartbeat also starts a sync automatically if it finds that the graph is out of date. It does this a maximum of one time in 3 minutes.

## 4.9 Undo a graph change

1. Click **Undo**, or run **Assistive: Undo Last Graph Change**.

Assistive keeps the last 20 revisions of each graph. Each graph change by the LLM adds one revision. A clear also adds one revision. Status changes from the code and interrupt flags do not add a revision. The first draft of a file has no previous revision, so **Undo** is not available after it.

## 4.10 Use the heartbeat

The heartbeat runs a beat when all of these conditions are true:

- You typed in the file after the last beat.
- The interval passed (45 seconds by default).
- You stopped typing for 2 seconds.
- The editor window has the focus.

A beat is quiet when there is no important problem. You see nothing in the feed.

### 4.10.1 Run a beat now

1. Click **♥ Check now**, or run **Assistive: Run a Heartbeat Now**.

### 4.10.2 Pause or resume the heartbeat

1. Click **Pause** (or **Resume**), or run **Assistive: Pause / Resume Heartbeat**.

This changes the user setting `assistive.heartbeat.enabled`.

### 4.10.3 Examine the last verdict

1. Put the mouse pointer on the **♥** pill.
2. Read the tooltip. It shows the time of the last beat and the verdict, for example `jev: interrupt 0.08 · no issue · severity 0.1 · graph 0.12 · stuck 0.05`.

## 4.11 Handle an interrupt

An interrupt shows in four places:

- a card in the feed;
- a squiggle on the line in the editor (blue for severity 1, yellow for 2, red for 3);
- a red node in the graph (the node that contains the line);
- a notification, if the panel is hidden and `assistive.notifications` is `toast`.

1. Read the title and the message on the card.
2. Do one of these:
   - Click **Show line** to go to the line.
   - Click **Explain more** to ask the LLM for a longer explanation and resources.
   - Click **Got it** to dismiss the interrupt.
3. Change the line to correct the problem.

When you change the text of the flagged line, the interrupt changes to *resolved* automatically. The squiggle and the red node go away. If you only add lines above the flagged line, the interrupt moves with its line.

> **Note:** Assistive does not show the same interrupt two times. An interrupt with the same issue kind and the same line text stays hidden until the first one is resolved.

## 4.12 Use the recommended resources

1. Read the topic and the sentence under each link.
2. Click a link. It opens in your web browser.

Assistive examines each link before it shows the link. It removes links that give HTTP 404 or 410. A link with "(link not checked)" did not answer the check, but it can still work.

## 4.13 Export the graph

1. Run **Assistive: Export Graph as Mermaid**.
2. Read the new untitled Markdown document. It contains the docstring and a Mermaid `flowchart TD`.
3. Save the document where you want it, or close it.

## 4.14 Clear the graph

1. Run **Assistive: Clear Graph for This File**.
2. Click **Clear** in the dialog.

> **Note:** **Undo** restores a cleared graph.

## 4.15 Commands

| Command | Function |
|---|---|
| Assistive: Focus the Graph Panel | Open the panel (`Ctrl+Alt+G`). |
| Assistive: Tell the Assistant… | Open the panel and put the focus in the input box (`Ctrl+Alt+/`). |
| Assistive: Draft Graph from Module Docstring | Draft or redraft the graph. |
| Assistive: Sync Graph with Code | Make the graph agree with the code. |
| Assistive: Undo Last Graph Change | Restore the previous revision. |
| Assistive: Clear Graph for This File | Remove the graph. |
| Assistive: Run a Heartbeat Now | Run one beat. |
| Assistive: Pause / Resume Heartbeat | Turn the heartbeat off or on. |
| Assistive: Export Graph as Mermaid | Open the graph as Mermaid text. |
| Assistive: Open API Configuration (.env) | Open the `.env` file. Create it from the template if necessary. |
| Assistive: Test LLM and Jev Connections | Send one test request to each service. |

## 4.16 What the panel shows for other files

- If you open a file in a language that Assistive does not support, the panel continues to show the last supported file. Thus you can read documentation or a configuration file and keep the plan in view.
- If no supported file was open before, the panel tells you to open a Python, TypeScript or JavaScript file.
