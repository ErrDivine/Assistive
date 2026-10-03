# 5. Troubleshooting

This document helps you find and correct problems. Section 5.1 tells where to find information. Section 5.2 lists symptoms. Section 5.3 lists the error messages.

## 5.1 Find information

### 5.1.1 The Assistive output channel

1. Open **View → Output**.
2. In the list at the right side of the Output panel, select **Assistive**.

The channel shows these lines:

| Line | Example |
|---|---|
| The configuration that Assistive loaded | `config /home/me/Assistive/.env: llm gpt-4.1-mini @ https://api.openai.com/v1, jev jev-latest, triage jev, heartbeat 45s` |
| Problems in the `.env` file | `ASSISTIVE_HEARTBEAT_SECONDS=5 is out of range; using 15.` |
| The verdict of each beat | `heartbeat wc.py: jev: interrupt 0.93 · typo · severity 3.0 · graph 0.05 · stuck 0.05 → possible typo (p=0.93, severity 3.0)` |
| The result of each LLM turn | `draft: 3 round(s), 4 tool call(s), 5120+640 tokens` |
| Tool calls that failed | `chat: update_nodes → error: unknown node id 'fetch_isues'. Did you mean 'fetch_issues'? …` |
| Failures | `heartbeat failed: Jev rejected the API key (HTTP 401). Check ASSISTIVE_JEV_API_KEY.` |

### 5.1.2 The pills in the panel

The **LLM** and **Jev** pills show the state of each service. A red pill means that the last request failed. Put the mouse pointer on the **♥** pill to see the last verdict or the last error.

### 5.1.3 The connection test

Run **Assistive: Test LLM and Jev Connections**. The result tells you if each service answers.

## 5.2 Symptoms

### 5.2.1 The graph is not drafted automatically

| Possible cause | Corrective action |
|---|---|
| The setting `assistive.autoDraft` is `false`. | Set it to `true`, or click **Draft**. |
| The LLM is not configured. The **LLM** pill is yellow. | Fill in the LLM variables in the `.env` file. |
| The docstring is not closed. The docstring line in the panel ends with "…". | Type `"""` or `*/` at the end of the docstring. |
| The docstring has fewer than 15 characters. | Write a longer description. |
| You did not type in the docstring. You only opened the file. | Click **Draft**. Assistive does not draft files that you only open. |
| Assistive tried this docstring before and the draft failed. | Click **Draft** to try again. |
| The file has a graph already. | Click **Redraft**. |

### 5.2.2 The Draft button is not available

| Possible cause | Corrective action |
|---|---|
| The file has no module docstring. | Write a docstring at the top of the file. |
| The language is not supported. | Use Python, TypeScript or JavaScript, or add the language ID to `assistive.languages`. Only these three languages have an outline. |
| The LLM works on a different task. The spinner line is visible. | Wait for the task to end. |

### 5.2.3 A node stays "planned" after I typed its code

| Possible cause | Corrective action |
|---|---|
| You did not save the file, and no beat ran after the change. | Save the file. |
| The name in the code is different from the `symbol` of the node. | Run **Sync**. The LLM changes the node to the name in the code. Or rename the symbol in the code. |
| Two symbols in the file have the same short name, and the node has no full dotted name. | Run **Sync**, or ask the LLM to set the full symbol, for example `Cache.get`. |
| The file has a syntax error that stops the parser. | Correct the syntax error. |

### 5.2.4 The heartbeat does not run

| Possible cause | Corrective action |
|---|---|
| The heartbeat is paused. The pill shows "♥ paused". | Click **Resume**. |
| `ASSISTIVE_TRIAGE=off`. | Set `ASSISTIVE_TRIAGE=jev` or `llm`. |
| The editor window does not have the focus. | Click in the editor. |
| You did not type after the last beat. | Type, then stop for 2 seconds. |
| The interval did not pass. | Wait, or click **♥ Check now**. |
| Jev is not configured. The **Jev** pill is yellow. | Fill in `ASSISTIVE_JEV_API_KEY`, or set `ASSISTIVE_TRIAGE=llm`. |

### 5.2.5 There are too many interrupts

1. Open the `.env` file.
2. Increase `ASSISTIVE_INTERRUPT_THRESHOLD`, for example to `0.8`.
3. Increase `ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS`, for example to `180`.
4. Increase `ASSISTIVE_HEARTBEAT_SECONDS`, for example to `90`.
5. Save the file.

### 5.2.6 There are no interrupts, also for clear errors

1. Examine the verdict in the **♥** tooltip or in the output channel.
2. If $P(\text{interrupt})$ is high but nothing shows, examine the severity. Escalation needs a severity of 1.5 or more.
3. If an interrupt came less than 90 seconds before, wait for the cooldown to end.
4. To make the heartbeat more sensitive, decrease `ASSISTIVE_INTERRUPT_THRESHOLD`, for example to `0.5`.

> **Note:** The LLM can decide not to interrupt after it examines the code. Then the output channel shows the verdict, but the feed shows nothing.

### 5.2.7 Links show "(link not checked)"

| Possible cause | Corrective action |
|---|---|
| `ASSISTIVE_VERIFY_LINKS=false`. | Set it to `true` if you want the check. |
| The web site did not answer in 4 seconds, or refused the check. | No action is necessary. The link can still work. |
| A proxy or firewall blocks the requests from the editor. | Configure the proxy of the editor. |

### 5.2.8 The panel shows the wrong file

The panel shows the active editor if its language is supported. If the active file is not supported, the panel keeps the last supported file. Click in the editor of the file that you want.

## 5.3 Error messages

### 5.3.1 LLM messages

| Message | Cause | Corrective action |
|---|---|---|
| The LLM is not configured yet. Run **Assistive: Open API Configuration** and fill in the `.env` file. | The key or the model is a placeholder, or the base URL is not an HTTP URL. | Fill in `ASSISTIVE_LLM_API_KEY`, `ASSISTIVE_LLM_MODEL` and `ASSISTIVE_LLM_BASE_URL`. |
| The LLM API rejected the key (HTTP 401). Check ASSISTIVE_LLM_API_KEY. | The key is not correct or has no permission (HTTP 401 or 403). | Write the correct key. |
| The LLM API answered 404 at … | The base URL or the model name is not correct. | Make sure that the base URL ends in `/v1` (for most providers) and that the model name is correct. |
| The LLM API rate limit was reached (HTTP 429). Try again shortly. | Your provider limits the requests. | Wait. Use a higher plan or a different model. |
| The LLM did not answer within 120s. | The model is slow or the network is slow. | Increase `ASSISTIVE_LLM_TIMEOUT_SECONDS`. |
| Could not reach the LLM at … | There is no network connection to the base URL. | Examine the URL, the network and the proxy. |
| LLM error (HTTP 400): … | The server rejected the request for a different reason. | Read the detail. Make sure that the model supports tool calls. |
| The LLM returned no message. | The server sent a reply without a message. | Try a different model or provider. |

> **Note:** If the model rejects the `temperature` parameter, Assistive sends the request again without it. If the server rejects `response_format`, Assistive sends the request again without it. You do not see these errors.

### 5.3.2 Jev messages

| Message | Cause | Corrective action |
|---|---|---|
| Jev is not configured (set ASSISTIVE_JEV_API_KEY, or ASSISTIVE_TRIAGE=llm). | The triage is `jev` but the key is a placeholder. | Fill in the key, or use LLM triage. |
| Jev rejected the API key (HTTP 401). Check ASSISTIVE_JEV_API_KEY. | The key is not correct (HTTP 401 or 403 with a JSON body). | Write the correct key. |
| Jev's edge firewall rejected the request (HTTP 403); code that looks like shell commands can trigger this. | The firewall in front of Jev sent an HTML page. Some code text looks like an attack to the firewall. | No action is necessary. The next beat sends different text. |
| Jev rate limit reached (HTTP 429); the heartbeat will retry later. | Too many requests. | Increase `ASSISTIVE_HEARTBEAT_SECONDS`. |
| Jev did not answer within 10s. | Jev or the network is slow. | Increase `ASSISTIVE_JEV_TIMEOUT_SECONDS`. |
| Could not reach Jev at … | There is no network connection to the Jev endpoint. | Examine `ASSISTIVE_JEV_BASE_URL` and the network. |
| Jev returned a response that is not JSON: … | The endpoint is not a Jev endpoint, or a proxy changed the reply. | Examine `ASSISTIVE_JEV_BASE_URL`. |
| Jev's response had no answers for the questions asked. | The reply had no `answers` (or `results`) for the questions. | Examine the base URL and the model name. |
| Jev error HTTP 500: … | An error on the Jev server. | Wait and try again. |

### 5.3.3 Other messages

| Message | Cause | Corrective action |
|---|---|---|
| LLM triage was not JSON: … | With `ASSISTIVE_TRIAGE=llm`, the LLM did not reply with a JSON object. | Use a model that follows instructions better, or use Jev. |
| Write a module docstring at the top of the file first … | You clicked **Draft** but the file has no docstring. | Write the docstring. |
| There is no graph to sync yet. Draft one first. | You clicked **Sync** but the file has no graph. | Draft a graph. |
| Assistive: open a Python, TypeScript or JavaScript file first. | The command needs a supported file. | Open a supported file. |
| Assistive: nothing to undo. | The undo stack is empty. | No action is necessary. |
| Assistive: this file has no graph yet. | You tried to export a file without a graph. | Draft a graph. |
