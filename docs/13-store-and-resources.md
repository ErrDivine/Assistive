# 13. Store and resources (`src/store/`, `src/resources/`)

This document describes two modules. The `GraphStore` keeps the graph, the feed and the undo history of each file. The link check examines the links that the LLM recommends before the panel shows them.

## 13.1 Graph store (`store/GraphStore.ts`)

### 13.1.1 Records

The store keeps one `FileRecord` for each file. The key is the absolute path of the file.

| Field | Description |
|---|---|
| `file` | The key. |
| `graph` | The current `FileGraph`, or `undefined`. |
| `feed` | The feed items, oldest first. Maximum 200 (`MAX_FEED`). |
| `history` | Earlier graph revisions, most recent last. Maximum 20 (`MAX_HISTORY`). |

When a list becomes too long, the store removes the oldest items.

### 13.1.2 Persistence

The constructor receives a folder and a save delay (default 400 ms). The controller gives the workspace storage folder of the extension (`context.storageUri`), or the global storage folder if there is no workspace.

- **Path.** Each record goes to `<folder>/graphs/<hash>.json`. The hash is the first 16 hexadecimal characters of the SHA-1 of the key. Thus the file name does not show the path of the source file.
- **Load.** `get(file)` reads the JSON file the first time that it needs the record. It accepts the data only if the `file` field is the same key. If the file does not exist or is not valid, the record starts empty.
- **Save.** Each change schedules a save after the delay. A new change before the save starts the delay again. Thus fast changes cause one write.
- **Atomic write.** The store writes to `<path>.<pid>.tmp` and then renames the file to the final path. A crash during the write cannot leave a half-written file.
- **Best effort.** If a write fails, the store ignores the error. The data stays in memory.
- **Flush.** `flush()` writes all scheduled saves at once. The controller calls it when the extension stops.
- **No folder.** If the folder is `undefined`, the store keeps the data only in memory. The unit tests use this mode.

### 13.1.3 Methods

| Method | Function |
|---|---|
| `onChange(fn)` | Adds a listener. It returns an object with `dispose()`. An error in a listener does not stop the store or the other listeners. |
| `get(file)` | Returns the record. Loads it from disk the first time. |
| `graph(file)` | Returns the graph of the file. |
| `setGraph(file, graph, snapshot)` | Replaces the graph. If `snapshot` is a graph, the store pushes a copy of it onto the undo history. With `false` or `undefined`, no snapshot is made. |
| `canUndo(file)` | `true` if the history is not empty. |
| `undo(file)` | Removes the last revision from the history and makes it the current graph with a new `updatedAt`. Returns the graph, or `undefined` if the history is empty. |
| `addFeed(file, item)` | Adds an item. Gives it an `id` (the first 8 characters of a random UUID) and a `ts` (the current ISO time). Returns the full item. |
| `findFeed(id)` | Finds an item by its ID in all loaded records. Returns the file and the item. |
| `updateFeed(file, id, patch)` | Changes the fields of an item. |
| `clear(file)` | Sets the graph to `undefined`, with the old graph as the snapshot. Thus **Undo** restores a cleared graph. |
| `files()` | The keys of the records in memory. |
| `changed(file)` | Calls the listeners and schedules a save. |
| `flush()` | Writes all scheduled saves now. |

### 13.1.4 When the store makes a snapshot

| Change | Snapshot |
|---|---|
| The final graph of an LLM turn that changed the graph | Yes: the graph before the turn, or an empty graph if there was none |
| A live preview during a turn | No |
| A rollback after a failed turn | No |
| A status change from the code (`localSync`) | No |
| A flag or an unflag from an interrupt | No |
| A clear | Yes: the cleared graph |
| An undo | No (the undo removes a snapshot) |

## 13.2 Link check (`resources/links.ts`)

The LLM can invent a URL that does not exist. The link check removes dead links before the programmer sees them (decision D8).

### 13.2.1 `isWebUrl(url)`

This function returns `true` if the URL parses, the protocol is `http:` or `https:`, and there is a host name.

### 13.2.2 `checkLinks(items, {verify, fetchImpl?, timeoutMs?})`

This function returns `{kept, dropped}`. It does these steps:

1. It trims each URL.
2. It drops each URL that is not a web URL, with the reason "not an http(s) URL".
3. It removes duplicate URLs.
4. If `verify` is `false` (`ASSISTIVE_VERIFY_LINKS=false`), it keeps all links and marks them `unverified`.
5. If not, it probes all links in parallel (refer to [13.2.3](#1323-the-probe)).
6. It drops each link that answers HTTP 404 or HTTP 410, with the reason "HTTP 404" or "HTTP 410".
7. It marks a link that answers 2xx or 3xx as `ok`.
8. It marks all other links as `unverified`. These links answered a different status, or did not answer. They can still work.

### 13.2.3 The probe

The private function `probe(url, fetchImpl, timeoutMs)` returns the HTTP status, or `undefined`.

1. It sends a `HEAD` request. It follows redirects. The `User-Agent` is `Assistive-link-check`. The timeout is 4 seconds by default.
2. Some servers refuse `HEAD`. If the `HEAD` request fails, or answers 400, 403, 405 or 501, the probe sends a `GET` request with `Range: bytes=0-0`. This asks for one byte only.
3. The probe cancels each response body, so that no download continues.
4. If the `GET` request also fails, the probe returns `undefined`.

A refused `HEAD` and a failed `GET` cost exactly two requests. A regression test makes sure of this.

### 13.2.4 Where the result goes

The tool `recommend_resources` calls `checkLinks` through the Assistant. The controller gives the setting `verifyLinks`. The tool shows only the links in `kept`. It tells the model which links it dropped and why. Refer to [Tool reference](10-tool-reference.md#1061-recommend_resources).

In the panel, a link with `verified: "unverified"` shows "(link not checked)". A click on a link sends `openLink` to the host. The host opens only `http` and `https` URLs, with `vscode.env.openExternal`.
