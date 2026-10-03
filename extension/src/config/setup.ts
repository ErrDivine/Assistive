// The setup wizard: pick a provider, enter the key, pick a model from the
// endpoint's list, decide the heartbeat triage. The flow is pure: the UI and
// the model listing are injected, and the result is the .env values to write.

import { isPlaceholder, type TriageMode } from "./env";

export interface Provider {
  label: string;
  baseUrl: string;
  detail: string;
  /** Local servers ignore the key, but the client needs one. */
  localKey?: string;
}

export const PROVIDERS: Provider[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", detail: "Needs an API key from platform.openai.com." },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", detail: "One key for models from many vendors (openrouter.ai)." },
  { label: "Ollama (this computer)", baseUrl: "http://localhost:11434/v1", detail: "No key. Pull a model with tool calling first.", localKey: "ollama" },
  { label: "LM Studio (this computer)", baseUrl: "http://localhost:1234/v1", detail: "No key. Load a model and start the local server.", localKey: "lm-studio" },
];

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  /** Shown even when the filter text matches nothing. */
  alwaysShow?: boolean;
}

export interface SetupUi {
  pick<T extends PickItem>(items: T[], opts: { title: string; placeholder: string }): Promise<T | undefined>;
  input(opts: {
    title: string;
    prompt: string;
    value?: string;
    placeholder?: string;
    password?: boolean;
    validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
}

export interface SetupDeps {
  current: { baseUrl: string; apiKey: string; model: string; triage: TriageMode; jevReady: boolean };
  /** The model IDs of an endpoint; throws when the endpoint cannot list them. */
  listModels(baseUrl: string, apiKey: string): Promise<string[]>;
}

const TITLE = "Assistive: set up the LLM";

/** Model IDs that are clearly not chat models (embeddings, speech, images). */
const NOT_CHAT = /embed|whisper|tts|dall-e|davinci|babbage|moderation|transcri|realtime|audio|image|sora|search-preview|computer-use/i;

/** The chat models of a model list, sorted; the whole list when the filter would leave nothing. */
export function chatModels(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  const chat = unique.filter((id) => !NOT_CHAT.test(id));
  return (chat.length ? chat : unique).sort((a, b) => a.localeCompare(b));
}

function oneLine(v: string): string | undefined {
  return /[\r\n]/.test(v) ? "Use one line." : undefined;
}

/**
 * Ask for the endpoint, the key, the model and (when Jev is not set up) the
 * heartbeat triage. Returns the .env values to write, or undefined when the
 * programmer cancels before the model is chosen.
 */
export async function runSetup(ui: SetupUi, deps: SetupDeps): Promise<Record<string, string> | undefined> {
  const cur = deps.current;
  const other = { label: "Other OpenAI-compatible endpoint…", baseUrl: "", detail: "Azure OpenAI, vLLM, a company gateway, and others." } as Provider;
  const items = [...PROVIDERS, other].map((p) => ({ ...p, description: p.baseUrl && p.baseUrl === cur.baseUrl ? "current" : undefined }));
  const provider = await ui.pick(items, { title: `${TITLE} (1/3)`, placeholder: "Which LLM endpoint?" });
  if (!provider) return undefined;

  let baseUrl = provider.baseUrl;
  if (!baseUrl) {
    const typed = await ui.input({
      title: `${TITLE} (1/3)`,
      prompt: "The base URL of the Chat Completions API. It usually ends in /v1.",
      value: PROVIDERS.some((p) => p.baseUrl === cur.baseUrl) ? "" : cur.baseUrl,
      placeholder: "https://example.com/v1",
      validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : "Enter a URL that starts with http:// or https://."),
    });
    if (typed === undefined) return undefined;
    baseUrl = typed.trim().replace(/\/+$/, "");
  }

  const sameEndpoint = baseUrl === cur.baseUrl;
  const canKeepKey = sameEndpoint && !isPlaceholder(cur.apiKey);
  let apiKey: string;
  if (provider.localKey) {
    apiKey = canKeepKey ? cur.apiKey : provider.localKey;
  } else {
    const typed = await ui.input({
      title: `${TITLE} (2/3)`,
      prompt: `The API key for ${provider.baseUrl ? provider.label : baseUrl}. It is kept in your .env file.`,
      placeholder: canKeepKey ? "Press Enter to keep the current key" : "sk-…",
      password: true,
      validate: (v) => (!v.trim() && !canKeepKey ? "Enter the key." : oneLine(v)),
    });
    if (typed === undefined) return undefined;
    apiKey = typed.trim() || cur.apiKey;
  }

  let models: string[] = [];
  let listError = "";
  try {
    models = chatModels(await deps.listModels(baseUrl, apiKey));
  } catch (err) {
    listError = (err as Error).message;
  }
  const keepModel = sameEndpoint && !isPlaceholder(cur.model) ? cur.model : "";
  let model: string | undefined;
  if (models.length) {
    // Enter keeps the current model; the typed entry stays visible when the filter matches no model.
    const ordered = models.includes(keepModel) ? [keepModel, ...models.filter((m) => m !== keepModel)] : models;
    const typeIt = { label: "$(edit) Type a model name…", typed: true, alwaysShow: true };
    const choice = await ui.pick<PickItem & { typed?: boolean }>(
      [...ordered.map((id) => ({ label: id, description: id === keepModel ? "current" : undefined })), typeIt],
      { title: `${TITLE} (3/3)`, placeholder: "Which model? It must support tool calls." },
    );
    if (!choice) return undefined;
    model = choice.typed ? undefined : choice.label;
  }
  if (!model) {
    const typed = await ui.input({
      title: `${TITLE} (3/3)`,
      prompt: `The model name. It must support tool calls.${listError ? ` (The endpoint did not list its models: ${listError})` : ""}`,
      value: keepModel,
      placeholder: "gpt-4.1-mini, qwen2.5-coder:14b, …",
      validate: (v) => (v.trim() ? oneLine(v) : "Enter the model name."),
    });
    if (typed === undefined) return undefined;
    model = typed.trim();
  }

  const out: Record<string, string> = { ASSISTIVE_LLM_BASE_URL: baseUrl, ASSISTIVE_LLM_API_KEY: apiKey, ASSISTIVE_LLM_MODEL: model };
  if (cur.triage === "jev" && !cur.jevReady) {
    // Without a Jev key the heartbeat cannot triage; Escape keeps the setting.
    const triage = await ui.pick(
      [
        { label: "Triage with the LLM", detail: "No Jev key. Each heartbeat asks the LLM: slower, and it uses tokens.", value: "llm" as const },
        { label: "Enter a Jev API key", detail: "Jev (typesafe.ai) triages each heartbeat quickly and cheaply.", value: "jev" as const },
        { label: "Turn the heartbeat triage off", detail: "No interrupts. Draft, chat and sync still work.", value: "off" as const },
      ],
      { title: `${TITLE}: heartbeat`, placeholder: "Jev is not set up. How should the heartbeat triage your edits?" },
    );
    if (triage?.value === "jev") {
      const key = await ui.input({
        title: `${TITLE}: heartbeat`,
        prompt: "The Jev API key. It is kept in your .env file.",
        password: true,
        validate: (v) => (v.trim() ? oneLine(v) : "Enter the key."),
      });
      if (key) out.ASSISTIVE_JEV_API_KEY = key.trim();
    } else if (triage) {
      out.ASSISTIVE_TRIAGE = triage.value;
    }
  }
  return out;
}

/** The model IDs from `GET <baseUrl>/models` (OpenAI, OpenRouter, Ollama, LM Studio and vLLM answer it). */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  opts: { headers?: Record<string, string>; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
  const res = await (opts.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { ...opts.headers, Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) {
    throw new Error("the answer has no model list");
  }
  return body.data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && !!id);
}

/** Quote a .env value when dotenv would change it; values with every quote character are refused. */
export function quoteEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("A .env value must be one line.");
  }
  if (!/[\s#"'`\\$]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new Error("This value cannot be written to a .env file.");
}

/**
 * Set values in the text of a .env file: replace each key's first line
 * (`KEY=…` or `export KEY=…`), or add the key at the end. Comments, other
 * keys and the line endings stay.
 */
export function setEnvValues(text: string, updates: Record<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${quoteEnvValue(value)}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  return lines.join(eol) + (endsWithNewline || !text.length ? eol : "");
}
