// The tool-calling loop over an OpenAI-compatible Chat Completions API.
// Each round: send the conversation and the tools, run every tool call the
// model makes, append the results as `tool` messages, repeat until the model
// answers in plain text (its brief summary) or the round budget is spent.

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LlmConfig } from "../config/env";
import { check, type JsonSchema } from "./schema";

export interface ToolContext {
  signal?: AbortSignal;
  /** Set by a tool to end the loop after this round (e.g. stand_down). */
  stop?: { reason: string };
}

export interface AgentTool<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object" };
  run(args: A, ctx: ToolContext): Promise<string> | string;
}

export interface AgentStep {
  tool: string;
  args: unknown;
  result: string;
  ok: boolean;
}

export interface AgentResult {
  /** The model's final plain-text message (the brief summary). */
  text: string;
  steps: AgentStep[];
  rounds: number;
  stopped?: string;
  usage: { prompt: number; completion: number };
}

export interface AgentOptions {
  messages: ChatCompletionMessageParam[];
  tools: AgentTool[];
  maxRounds?: number;
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void;
  /** The model's text so far in the current round, as it streams ("" when a round starts). */
  onText?: (text: string) => void;
  /** Max characters of a single tool result sent back to the model. */
  maxResultChars?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Remove reasoning blocks some open models put in the content. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Like stripThinking, for text still streaming: an unclosed <think> block is hidden too. */
export function stripThinkingPartial(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
}

export function toOpenAiTool(t: AgentTool): ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> } };
}

export class Llm {
  readonly client: OpenAI;
  private sendTemperature = true;
  private sendToolChoice = true;
  private streaming: boolean;

  constructor(
    readonly cfg: LlmConfig,
    fetchImpl?: FetchLike,
  ) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
      maxRetries: 2,
      defaultHeaders: cfg.extraHeaders,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    this.streaming = cfg.stream;
  }

  /**
   * One completion. Some compatible servers reject parts of the request; each
   * is dropped once and never sent again: `temperature`, `tool_choice`, and
   * streaming. With `onText`, the reply streams and `onText` receives the text so far.
   */
  async complete(
    body: Omit<ChatCompletionCreateParamsNonStreaming, "model" | "temperature">,
    signal?: AbortSignal,
    onText?: (text: string) => void,
  ): Promise<ChatCompletion> {
    for (let attempt = 0; ; attempt++) {
      const { tool_choice, ...rest } = body;
      const params: ChatCompletionCreateParamsNonStreaming = {
        ...rest,
        ...(tool_choice !== undefined && this.sendToolChoice ? { tool_choice } : {}),
        model: this.cfg.model,
        ...(this.sendTemperature ? { temperature: this.cfg.temperature } : {}),
      };
      try {
        if (onText && this.streaming) {
          const stream = this.client.chat.completions.stream({ ...params, stream: true as const }, { signal });
          stream.on("content", (_delta, snapshot) => onText(stripThinkingPartial(snapshot)));
          return (await stream.finalChatCompletion()) as ChatCompletion;
        }
        return await this.client.chat.completions.create(params, { signal });
      } catch (err) {
        if (attempt < 3 && err instanceof OpenAI.BadRequestError) {
          if (this.sendTemperature && /temperature/i.test(err.message)) {
            this.sendTemperature = false;
            continue;
          }
          if (this.sendToolChoice && tool_choice !== undefined && /tool_choice/i.test(err.message)) {
            this.sendToolChoice = false;
            continue;
          }
          if (this.streaming && onText && /stream/i.test(err.message)) {
            this.streaming = false;
            continue;
          }
        }
        throw toLlmError(err, this.cfg);
      }
    }
  }

  /** A single plain answer (no tools). */
  async text(messages: ChatCompletionMessageParam[], signal?: AbortSignal, json = false): Promise<string> {
    const res = await this.complete({ messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, signal).catch(
      async (err: unknown) => {
        // Not every compatible server supports response_format.
        if (json && err instanceof LlmError && err.status === 400) {
          return this.complete({ messages }, signal);
        }
        throw err;
      },
    );
    return stripThinking(res.choices[0]?.message?.content ?? "");
  }

  async run(opts: AgentOptions): Promise<AgentResult> {
    const messages = [...opts.messages];
    const tools = opts.tools.map(toOpenAiTool);
    const byName = new Map(opts.tools.map((t) => [t.name, t]));
    const maxRounds = opts.maxRounds ?? this.cfg.maxToolRounds;
    const maxChars = opts.maxResultChars ?? 12000;
    const steps: AgentStep[] = [];
    const usage = { prompt: 0, completion: 0 };
    const ctx: ToolContext = { signal: opts.signal };

    for (let round = 1; round <= maxRounds; round++) {
      opts.onText?.("");
      const res = await this.complete({ messages, tools, tool_choice: "auto" }, opts.signal, opts.onText);
      usage.prompt += res.usage?.prompt_tokens ?? 0;
      usage.completion += res.usage?.completion_tokens ?? 0;
      const msg = res.choices[0]?.message;
      if (!msg) {
        throw new LlmError("The LLM returned no message.");
      }
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (!calls.length) {
        return { text: stripThinking(msg.content ?? ""), steps, rounds: round, usage };
      }
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const step = await this.runTool(byName, call.function.name, call.function.arguments, ctx);
        steps.push(step);
        opts.onStep?.(step);
        const content = step.result.length > maxChars ? step.result.slice(0, maxChars) + "\n…(truncated)" : step.result;
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      if (ctx.stop) {
        return { text: "", steps, rounds: round, stopped: ctx.stop.reason, usage };
      }
      opts.signal?.throwIfAborted();
    }

    // Budget spent: ask for the summary without further tool use.
    messages.push({
      role: "user",
      content: "Tool budget reached. Stop calling tools and give your brief summary of what changed now.",
    });
    opts.onText?.("");
    let res: ChatCompletion;
    try {
      // Without tool_choice support, "none" cannot be expressed: send no tools at all.
      res = this.sendToolChoice
        ? await this.complete({ messages, tools, tool_choice: "none" }, opts.signal, opts.onText)
        : await this.complete({ messages }, opts.signal, opts.onText);
    } catch (err) {
      if (!(err instanceof LlmError) || err.status !== 400) {
        throw err;
      }
      res = await this.complete({ messages }, opts.signal, opts.onText);
    }
    usage.prompt += res.usage?.prompt_tokens ?? 0;
    usage.completion += res.usage?.completion_tokens ?? 0;
    return { text: stripThinking(res.choices[0]?.message?.content ?? ""), steps, rounds: maxRounds, usage };
  }

  private async runTool(
    byName: Map<string, AgentTool>,
    name: string,
    rawArgs: string,
    ctx: ToolContext,
  ): Promise<AgentStep> {
    const tool = byName.get(name);
    if (!tool) {
      return {
        tool: name,
        args: rawArgs,
        ok: false,
        result: `error: there is no tool named '${name}'. Available tools: ${[...byName.keys()].join(", ")}.`,
      };
    }
    let parsed: unknown;
    try {
      parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
    } catch (err) {
      return { tool: name, args: rawArgs, ok: false, result: `error: arguments are not valid JSON (${(err as Error).message}). Send a JSON object.` };
    }
    const checked = check(parsed, tool.parameters);
    if (checked.errors.length) {
      return { tool: name, args: parsed, ok: false, result: `error: ${checked.errors.join(" ")} Fix the arguments and call ${name} again.` };
    }
    try {
      let result = await tool.run(checked.value as Record<string, unknown>, ctx);
      if (checked.ignored.length) {
        result += `\n(note: ignored unknown field(s) ${checked.ignored.join(", ")})`;
      }
      return { tool: name, args: checked.value, ok: !/^error\b/.test(result), result };
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw err;
      }
      return { tool: name, args: checked.value, ok: false, result: `error: ${(err as Error).message}` };
    }
  }
}

export function toLlmError(err: unknown, cfg: LlmConfig): Error {
  if (err instanceof LlmError) {
    return err;
  }
  if (err instanceof OpenAI.APIUserAbortError || (err as Error)?.name === "AbortError") {
    return err as Error;
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError(`The LLM API rejected the key (HTTP ${err.status}). Check ASSISTIVE_LLM_API_KEY.`, err.status);
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new LlmError(
      `The LLM API answered 404 at ${cfg.baseUrl}: check ASSISTIVE_LLM_BASE_URL (it usually ends in /v1) and ASSISTIVE_LLM_MODEL='${cfg.model}'.`,
      404,
    );
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LlmError("The LLM API rate limit was reached (HTTP 429). Try again shortly.", 429);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError(`The LLM did not answer within ${cfg.timeoutMs / 1000}s.`);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError(`Could not reach the LLM at ${cfg.baseUrl}: ${err.message}`);
  }
  if (err instanceof OpenAI.BadRequestError && /\b(tools?|function[_ ]?call\w*)\b[^.]{0,60}\b(not supported|unsupported|does not support)|does not support (tools|function)/i.test(err.message)) {
    return new LlmError(
      `The model '${cfg.model}' does not support tool calls (HTTP 400). Set ASSISTIVE_LLM_MODEL to a model with tool calling.`,
      400,
    );
  }
  if (err instanceof OpenAI.APIError) {
    return new LlmError(`LLM error (HTTP ${err.status ?? "?"}): ${err.message}`, err.status);
  }
  return err instanceof Error ? err : new Error(String(err));
}
