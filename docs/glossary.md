# Glossary

This glossary gives the terms of these documents. A **technical name** is a name that the product or the code uses. It stays as written, also if it contains a word form that ASD-STE100 does not approve in general text (for example "typing order").

| Term | Definition |
|---|---|
| Activity bar | The vertical bar with icons at the side of the VS Code window. The Assistive icon opens the panel. |
| Agent loop | The loop in `Llm.run` that sends the conversation to the LLM, runs the tool calls, and repeats until the LLM writes a summary. |
| Attention | A node status. An interrupt flagged a problem in the code of the node. |
| Auto-draft | The automatic draft that starts when the programmer completes the module docstring of a file without a graph. |
| Baseline | A copy of the text of a file at an earlier time. The `EditTracker` keeps two baselines: `last_heartbeat` and `graph_created`. |
| Beat | One run of the heartbeat. |
| Busy label | The short text that tells what the LLM does now, for example "Drafting the graph…". |
| Calibrated probability | A probability that agrees with the real frequency. Of all answers with $p = 0.8$, about 80% are true. |
| Chat turn | A turn that acts on a message from the programmer. |
| Context block | The user message of a turn. It has sections that start with `## Title`. |
| Cooldown | A quiet time after an event, for example 90 s after an interrupt. |
| CSP | Content Security Policy. A browser rule that tells which scripts and styles a page can load. |
| Diagnostic | An error, warning or information that VS Code shows in the editor, often as a squiggle. |
| Docstring | A string at the start of a Python module, class or function that tells what it does. |
| Draft | The first graph of a file, made by the LLM from the module docstring. |
| Edge | A relation between two nodes of the graph. |
| Escalation | The step where the LLM examines a beat because the triage answers passed the thresholds. |
| Explain | A heartbeat action that recommends resources when the programmer seems stuck. Also the **Explain more** button of an interrupt. |
| Extension host | The VS Code process that runs extensions. |
| External node | A node for a library, a service or a module that the file uses but does not define. |
| Feed | The list of items in the panel: messages, replies, interrupts, resources, questions, code references and system notes. |
| Flag | The `attention` state that an interrupt sets on the node that contains its line. |
| Graph | Short for implementation graph. |
| Heartbeat | The periodic check of the latest change of the programmer. |
| Host | Short for extension host. |
| Implementation graph | The plan for one source file: nodes for the pieces to type and edges for their relations. |
| Interrupt | A short message about one concrete problem. It shows in the feed, as a squiggle, on the graph and as an optional notification. |
| Invariant | A rule that the code must always obey. Assistive has five invariants, I1 to I5. |
| Jev | The System One model of TypeSafe AI. It answers typed questions with calibrated probabilities. |
| Link check | The examination of a recommended URL with a `HEAD` request (or a one-byte `GET` request) before the panel shows it. |
| Live preview | A graph that the Assistant publishes during a turn, after each graph tool call. |
| LLM | Large language model. Here, a model with an OpenAI-compatible Chat Completions API and tool calls. |
| Local sync | The update of node statuses from the outline, without the LLM. |
| Mode | The kind of turn: `draft`, `chat`, `sync`, `heartbeat` (and `struggling`, which uses the heartbeat tools). |
| Module docstring | The text at the top of a file that tells what the file does. In the code, the "module string". |
| Node | One piece of the plan: a function, class, method, data type, constant, test, external dependency or step. |
| noul | A Jev question type with a yes or no answer. The answer is the probability of yes. |
| Outline | The module docstring, the symbols and the imports of a file. |
| Panel | The Assistive side panel: a webview view in the activity bar container. |
| Placeholder | A value in the `.env` file that Assistive ignores, for example `REPLACE_ME`. |
| Programmer | The person who uses Assistive and types the code. |
| Qualname | The dotted name of a symbol in its file, for example `Cache.get`. |
| Reconcile | The comparison of open interrupts with the current text, to find out if their lines moved or changed. |
| Redraft | A new draft of a file that has a graph. The LLM keeps the nodes that still fit. |
| Revision | The version number of a graph. Each change by the LLM increases it by 1. |
| Score | A Jev question type with a level on a scale. The answer is the probability-weighted mean of the 0-based levels. |
| Severity | How serious a problem is. For the triage: 0 to 3. For an interrupt: 1 to 3. |
| Slug | An ID made from text with only lower-case letters, digits and `_`, for example `cache_get`. |
| Snapshot | A copy of the graph that the store puts on the undo history. |
| Squiggle | The wavy line under code that VS Code draws for a diagnostic. |
| Stand down | The decision of the LLM not to interrupt. Also the tool `stand_down`. |
| Status | The state of a node from the code: `planned`, `stubbed`, `done` or `attention`. |
| Step node | A node for a unit of work that is not a named symbol. |
| Streaming | A mode of the LLM API in which the reply arrives in small parts while the model writes it. The panel shows these parts at once. |
| Struggle turn | A silent turn that recommends resources when the triage thinks that the programmer is stuck. |
| Stub | A symbol whose body is only a placeholder, for example `pass` or `throw new Error("not implemented")`. |
| Symbol | A named piece of code: a class, function, method, constant, variable or type. |
| Sync | A turn in which the LLM makes the graph agree with the code. |
| System One | Fast, low-cost thought. Here, Jev. |
| System Two | Slow, careful thought. Here, the LLM. |
| Tool | A function that the LLM can call. There are 19 tools. |
| Tool round | One request to the LLM and the tool calls in its reply. |
| Tree-sitter | A parser library. Assistive uses its WASM build to read Python, TypeScript, JavaScript, Go, Rust and Java. |
| Triage | The first, fast part of a beat. Jev (or the LLM) answers five questions about the latest change. |
| Turn | One run of the agent loop for one file. |
| Typing order | The suggested order in which the programmer types the nodes. |
| Verdict | The result of the triage in one common form (`TriageVerdict`). |
| Webview | A web page inside VS Code. The panel is a webview. |
| Workspace | The folder (or folders) that VS Code has open. |
