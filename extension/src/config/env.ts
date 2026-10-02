// API configuration from a .env file (placeholders are left for the user to fill).
// The parsing and validation here are pure; the extension supplies the paths.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseDotenv } from "dotenv";

export type TriageMode = "jev" | "llm" | "off";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxToolRounds: number;
  extraHeaders: Record<string, string>;
}

export interface JevConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface HeartbeatConfig {
  intervalMs: number;
  interruptThreshold: number;
  cooldownMs: number;
  graphSyncThreshold: number;
  explainThreshold: number;
}

export interface AssistiveConfig {
  llm: LlmConfig;
  jev: JevConfig;
  triage: TriageMode;
  heartbeat: HeartbeatConfig;
  verifyLinks: boolean;
  /** LLM settings are filled in (not placeholders). */
  llmReady: boolean;
  /** Jev settings are filled in. */
  jevReady: boolean;
  /** Human-readable problems (missing keys, bad numbers). */
  problems: string[];
  /** The file the values came from, if any. */
  source?: string;
}

export const MIN_HEARTBEAT_SECONDS = 15;
export const DEFAULT_HEARTBEAT_SECONDS = 45;

/** The template written to a new .env (kept in sync with /.env.example). */
export const ENV_TEMPLATE = `# Assistive configuration. Fill in the REPLACE_ME values, then save:
# the extension reloads this file automatically.

# --- LLM (any OpenAI-compatible Chat Completions API with tool calling) ---
ASSISTIVE_LLM_BASE_URL=https://api.openai.com/v1
ASSISTIVE_LLM_API_KEY=REPLACE_ME
ASSISTIVE_LLM_MODEL=REPLACE_ME
# Optional
ASSISTIVE_LLM_TEMPERATURE=0.2
ASSISTIVE_LLM_TIMEOUT_SECONDS=120
ASSISTIVE_LLM_MAX_TOOL_ROUNDS=8
# JSON object of extra HTTP headers, e.g. {"HTTP-Referer":"https://example.com"}
ASSISTIVE_LLM_EXTRA_HEADERS=

# --- Jev, TypeSafe AI's System One model (https://typesafe.ai) ---
ASSISTIVE_JEV_BASE_URL=https://api.typesafe.ai/v1
ASSISTIVE_JEV_API_KEY=REPLACE_ME
ASSISTIVE_JEV_MODEL=jev-latest
ASSISTIVE_JEV_TIMEOUT_SECONDS=10

# --- Heartbeat ---
# Who triages each heartbeat: jev (fast, cheap), llm (fallback), or off.
ASSISTIVE_TRIAGE=jev
# Seconds between heartbeats while you are editing (minimum 15).
ASSISTIVE_HEARTBEAT_SECONDS=45
# Probability Jev must give "interrupt now" before the LLM is asked to explain.
ASSISTIVE_INTERRUPT_THRESHOLD=0.65
# Quiet time after an interrupt (urgent problems still come through).
ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS=90
# Probability that the graph is out of date before it is re-synced with the code.
ASSISTIVE_GRAPH_SYNC_THRESHOLD=0.7
# Probability that you are stuck on a concept before resources are suggested.
ASSISTIVE_EXPLAIN_THRESHOLD=0.75

# Check recommended links before showing them (true/false).
ASSISTIVE_VERIFY_LINKS=true
`;

export function isPlaceholder(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const v = value.trim();
  return v === "" || /REPLACE[_-]?ME|YOUR[_-]|<.*>|^x+$/i.test(v);
}

function num(
  vars: Record<string, string>,
  key: string,
  fallback: number,
  problems: string[],
  min = -Infinity,
  max = Infinity,
): number {
  const raw = vars[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`${key}=${raw} is not a number; using ${fallback}.`);
    return fallback;
  }
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n));
    problems.push(`${key}=${raw} is out of range; using ${clamped}.`);
    return clamped;
  }
  return n;
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Build the configuration from parsed variables. Pure. */
export function parseConfig(vars: Record<string, string>, source?: string): AssistiveConfig {
  const problems: string[] = [];
  // Blank values count as unset, like the numeric settings.
  const get = (k: string, d = "") => vars[k]?.trim() || d;

  let extraHeaders: Record<string, string> = {};
  const rawHeaders = get("ASSISTIVE_LLM_EXTRA_HEADERS");
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extraHeaders = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      } else {
        problems.push("ASSISTIVE_LLM_EXTRA_HEADERS must be a JSON object.");
      }
    } catch {
      problems.push("ASSISTIVE_LLM_EXTRA_HEADERS is not valid JSON.");
    }
  }

  const llm: LlmConfig = {
    baseUrl: trimSlash(get("ASSISTIVE_LLM_BASE_URL", "https://api.openai.com/v1")),
    apiKey: get("ASSISTIVE_LLM_API_KEY"),
    model: get("ASSISTIVE_LLM_MODEL"),
    temperature: num(vars, "ASSISTIVE_LLM_TEMPERATURE", 0.2, problems, 0, 2),
    timeoutMs: num(vars, "ASSISTIVE_LLM_TIMEOUT_SECONDS", 120, problems, 5, 900) * 1000,
    maxToolRounds: Math.round(num(vars, "ASSISTIVE_LLM_MAX_TOOL_ROUNDS", 8, problems, 1, 30)),
    extraHeaders,
  };
  const jev: JevConfig = {
    baseUrl: trimSlash(get("ASSISTIVE_JEV_BASE_URL", "https://api.typesafe.ai/v1")),
    apiKey: get("ASSISTIVE_JEV_API_KEY"),
    model: get("ASSISTIVE_JEV_MODEL", "jev-latest") || "jev-latest",
    timeoutMs: num(vars, "ASSISTIVE_JEV_TIMEOUT_SECONDS", 10, problems, 1, 120) * 1000,
  };
  const triageRaw = get("ASSISTIVE_TRIAGE", "jev").toLowerCase();
  let triage: TriageMode = "jev";
  if (triageRaw === "jev" || triageRaw === "llm" || triageRaw === "off") {
    triage = triageRaw;
  } else {
    problems.push(`ASSISTIVE_TRIAGE=${triageRaw} is not one of jev, llm, off; using jev.`);
  }
  const heartbeat: HeartbeatConfig = {
    intervalMs:
      num(vars, "ASSISTIVE_HEARTBEAT_SECONDS", DEFAULT_HEARTBEAT_SECONDS, problems, MIN_HEARTBEAT_SECONDS, 3600) *
      1000,
    interruptThreshold: num(vars, "ASSISTIVE_INTERRUPT_THRESHOLD", 0.65, problems, 0, 1),
    cooldownMs: num(vars, "ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS", 90, problems, 0, 3600) * 1000,
    graphSyncThreshold: num(vars, "ASSISTIVE_GRAPH_SYNC_THRESHOLD", 0.7, problems, 0, 1),
    explainThreshold: num(vars, "ASSISTIVE_EXPLAIN_THRESHOLD", 0.75, problems, 0, 1),
  };
  const verifyLinks = !/^(false|0|no|off)$/i.test(get("ASSISTIVE_VERIFY_LINKS", "true"));

  const llmReady = !isPlaceholder(llm.apiKey) && !isPlaceholder(llm.model) && /^https?:\/\//.test(llm.baseUrl);
  const jevReady = !isPlaceholder(jev.apiKey) && /^https?:\/\//.test(jev.baseUrl);
  if (!llmReady) {
    problems.push("Set ASSISTIVE_LLM_API_KEY and ASSISTIVE_LLM_MODEL to use the assistant.");
  }
  if (triage === "jev" && !jevReady) {
    problems.push("Set ASSISTIVE_JEV_API_KEY for heartbeat triage (or set ASSISTIVE_TRIAGE=llm).");
  }
  return { llm, jev, triage, heartbeat, verifyLinks, llmReady, jevReady, problems, source };
}

/** Candidate .env locations, most specific first; the first is where a new one is created. */
export function envCandidates(setting: string | undefined, extensionPath: string, home = os.homedir()): string[] {
  const out: string[] = [];
  if (setting && setting.trim()) {
    out.push(path.resolve(setting.trim().replace(/^~(?=$|[\\/])/, home)));
  }
  let real = extensionPath;
  try {
    real = fs.realpathSync(extensionPath);
  } catch {
    // keep as is
  }
  // Installed from a source checkout (npm run install-local): <repo>/.env next to .env.example.
  const repo = path.join(real, "..");
  if (fs.existsSync(path.join(repo, ".env.example")) || fs.existsSync(path.join(repo, ".env"))) {
    out.push(path.join(repo, ".env"));
  }
  out.push(path.join(home, ".assistive", ".env"));
  return out;
}

export function loadConfig(candidates: string[], env: NodeJS.ProcessEnv = process.env): AssistiveConfig {
  for (const file of candidates) {
    try {
      const vars = parseDotenv(fs.readFileSync(file, "utf8"));
      return parseConfig(overlay(vars, env), file);
    } catch {
      continue;
    }
  }
  return parseConfig(overlay({}, env));
}

/** Process environment variables (ASSISTIVE_*) override the file. */
function overlay(vars: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const out = { ...vars };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("ASSISTIVE_") && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Create the .env from the template if it does not exist; returns its path. */
export function ensureEnvFile(file: string): string {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ENV_TEMPLATE, { mode: 0o600 });
  }
  return file;
}
