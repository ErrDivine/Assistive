// A local HTTP server that speaks the OpenAI Chat Completions format, Jev's
// /systemone format, and serves two documentation pages for link checks.
// Used by the unit tests and by the integration tests inside VS Code.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[];
  tool_choice?: unknown;
  temperature?: number;
  response_format?: unknown;
  [k: string]: unknown;
}

export type ChatReply =
  | { content: string }
  | { calls: { name: string; args: unknown }[]; content?: string }
  | { status: number; error: string };

export interface JevRequest {
  model: string;
  state: unknown;
  questions: Record<string, { type: string; instructions: string; criteria?: unknown }>;
}

export type Responder = (req: ChatRequest, index: number) => ChatReply;

export class FakeServers {
  readonly chatRequests: ChatRequest[] = [];
  readonly jevRequests: { body: JevRequest; auth?: string }[] = [];
  readonly linkRequests: { method: string; url: string }[] = [];
  chat: Responder = () => ({ content: "OK" });
  /** Delay before each chat reply, to test turns that overlap. */
  chatDelayMs = 0;
  /** Answer streaming requests with HTTP 400, like a server without streaming. */
  rejectStreaming = false;
  jev: (req: JevRequest) => { status?: number; body: unknown } = (req) => ({ body: jevAnswers(req, {}) });
  private server?: http.Server;
  private callId = 0;

  get base(): string {
    const addr = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  reset(): void {
    this.chatDelayMs = 0;
    this.rejectStreaming = false;
    this.chatRequests.length = 0;
    this.jevRequests.length = 0;
    this.linkRequests.length = 0;
  }

  /** Answer a streaming request with server-sent events in the Chat Completions chunk format. */
  private streamReply(res: http.ServerResponse, body: ChatRequest, reply: Exclude<ChatReply, { status: number }>): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const base = { id: `chatcmpl-${this.chatRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
    const send = (delta: unknown, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: "assistant", content: "" });
    const content = reply.content ?? "";
    for (let i = 0; i < content.length; i += 8) {
      send({ content: content.slice(i, i + 8) });
    }
    if ("calls" in reply) {
      reply.calls.forEach((c, index) =>
        send({
          tool_calls: [
            {
              index,
              id: `call_${++this.callId}`,
              type: "function",
              function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
            },
          ],
        }),
      );
    }
    send({}, "calls" in reply ? "tool_calls" : "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "POST" && url.endsWith("/chat/completions")) {
        const body = JSON.parse(raw) as ChatRequest;
        this.chatRequests.push(body);
        if (this.chatDelayMs) {
          await new Promise((r) => setTimeout(r, this.chatDelayMs));
          if (res.destroyed || !res.socket || res.socket.destroyed) {
            return; // the client aborted
          }
        }
        const reply = this.chat(body, this.chatRequests.length - 1);
        if ("status" in reply) {
          json(reply.status, { error: { message: reply.error, type: "invalid_request_error" } });
          return;
        }
        if (body.stream === true) {
          if (this.rejectStreaming) {
            json(400, { error: { message: "stream is not supported by this server", type: "invalid_request_error" } });
            return;
          }
          this.streamReply(res, body, reply);
          return;
        }
        const message =
          "calls" in reply
            ? {
                role: "assistant",
                content: reply.content ?? null,
                tool_calls: reply.calls.map((c) => ({
                  id: `call_${++this.callId}`,
                  type: "function",
                  function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
                })),
              }
            : { role: "assistant", content: reply.content };
        json(200, {
          id: `chatcmpl-${this.chatRequests.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, finish_reason: "calls" in reply ? "tool_calls" : "stop", message }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        });
        return;
      }
      if (req.method === "POST" && url.endsWith("/systemone")) {
        const body = JSON.parse(raw) as JevRequest;
        this.jevRequests.push({ body, auth: req.headers.authorization });
        const out = this.jev(body);
        json(out.status ?? 200, out.body);
        return;
      }
      if (url.startsWith("/docs/")) {
        this.linkRequests.push({ method: req.method ?? "GET", url });
        res.writeHead(url.startsWith("/docs/missing") ? 404 : 200, { "Content-Type": "text/html" });
        res.end(req.method === "HEAD" ? undefined : "<html><title>Docs</title></html>");
        return;
      }
      json(404, { error: { message: `no route ${req.method} ${url}` } });
    } catch (err) {
      json(500, { error: { message: (err as Error).message } });
    }
  }
}

/** Jev-format answers for every question asked, from simple values. */
export function jevAnswers(
  req: JevRequest,
  values: { interrupt?: number; issue?: string; severity?: number; graph_outdated?: number; struggling?: number; [k: string]: unknown },
): unknown {
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    if (q.type === "noul") {
      answers[name] = { type: "noul", noul: typeof values[name] === "number" ? values[name] : 0.05 };
    } else if (q.type === "choice") {
      const options = Object.keys((q.criteria as Record<string, string>) ?? {});
      const pick = typeof values[name] === "string" ? (values[name] as string) : options[0];
      const probabilities = Object.fromEntries(options.map((o) => [o, o === pick ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
      answers[name] = { type: "choice", choice: pick, probabilities, confidence: 0.85 };
    } else if (q.type === "score") {
      const levels = (q.criteria as string[]) ?? [];
      const s = typeof values[name] === "number" ? (values[name] as number) : 0;
      const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), Math.abs(i - s) < 0.5 ? 1 : 0]));
      answers[name] = { type: "score", score: s, probabilities, confidence: 0.8 };
    }
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 420, output_tokens: 12 } };
}

/** The last message of a chat request. */
export function lastMessage(req: ChatRequest): ChatRequest["messages"][number] {
  return req.messages[req.messages.length - 1];
}

export function systemPrompt(req: ChatRequest): string {
  return req.messages.find((m) => m.role === "system")?.content ?? "";
}

export function toolNames(req: ChatRequest): string[] {
  return (req.tools ?? []).map((t) => t.function.name);
}

/**
 * A scripted assistant: answers each kind of turn (recognized by its system
 * prompt) with plausible tool calls, then a short summary once tool results come back.
 */
export function scriptedAssistant(base: string, opts: { interruptLine?: number } = {}): Responder {
  return (req) => {
    const sys = systemPrompt(req);
    const last = lastMessage(req);
    const afterTools = last.role === "tool";
    if (/Task: draft the implementation graph/.test(sys)) {
      if (afterTools) {
        return { content: "Drafted 3 pieces: start with `parse_line`, then `count_words`, then `main`." };
      }
      return {
        calls: [
          {
            name: "add_nodes",
            args: {
              nodes: [
                {
                  id: "parse_line",
                  kind: "function",
                  symbol: "parse_line",
                  signature: "def parse_line(line: str) -> list[str]",
                  description: "Split one line into lowercase words.",
                  notes: ["Strip punctuation with str.translate", "Empty lines give []"],
                  order: 1,
                },
                {
                  id: "count_words",
                  kind: "function",
                  symbol: "count_words",
                  signature: "def count_words(lines: Iterable[str]) -> Counter[str]",
                  description: "Count words over all lines.",
                  notes: ["Use collections.Counter"],
                  order: 2,
                },
                {
                  id: "main",
                  kind: "function",
                  symbol: "main",
                  signature: "def main(argv: list[str] | None = None) -> int",
                  description: "CLI entry point: read the file and print the top words.",
                  order: 3,
                },
                { id: "counter", kind: "external", description: "collections.Counter" },
              ],
            },
          },
          {
            name: "connect",
            args: {
              edges: [
                { from: "count_words", to: "parse_line", kind: "calls" },
                { from: "main", to: "count_words", kind: "calls" },
                { from: "count_words", to: "counter", kind: "uses" },
              ],
            },
          },
          {
            name: "recommend_resources",
            args: {
              topic: "Counting with collections.Counter",
              resources: [
                { title: "collections.Counter", url: `${base}/docs/ok/counter`, type: "docs", why: "The counting API used here." },
                { title: "Dead link", url: `${base}/docs/missing`, type: "article", why: "Should be dropped." },
              ],
            },
          },
        ],
      };
    }
    if (/Task: the programmer wrote to you/.test(sys)) {
      if (afterTools) {
        return { content: "Added a `top_n` helper after `count_words`." };
      }
      return {
        calls: [
          {
            name: "add_nodes",
            args: {
              nodes: [
                {
                  id: "top_n",
                  kind: "function",
                  symbol: "top_n",
                  signature: "def top_n(counts: Counter[str], n: int = 10) -> list[tuple[str, int]]",
                  description: "The n most common words.",
                  order: 3,
                },
              ],
            },
          },
          { name: "connect", args: { edges: [{ from: "main", to: "top_n", kind: "calls" }] } },
        ],
      };
    }
    if (/Task: bring the graph in line/.test(sys)) {
      return { content: "Graph already matches the code." };
    }
    if (/Task: heartbeat check/.test(sys)) {
      if (afterTools) {
        return { content: "" };
      }
      return {
        calls: [
          {
            name: "interrupt_programmer",
            args: {
              title: "Typo in a method name",
              message: "`str.lowr()` does not exist; you meant `str.lower()`. This line will raise AttributeError.",
              line: opts.interruptLine ?? 1,
              issue: "typo",
              severity: 3,
            },
          },
        ],
      };
    }
    if (/fast code monitor/.test(sys)) {
      return { content: '{"interrupt": 0.9, "issue": "typo", "severity": 3, "graph_outdated": 0.1, "struggling": 0.1}' };
    }
    return { content: "OK" };
  };
}
