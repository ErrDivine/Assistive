// An in-memory WorkspaceAccess for tests.

import type { DiagnosticInfo, SearchHit, WorkspaceAccess } from "../../src/code/context";

const LANG: Record<string, string> = { py: "python", ts: "typescript", tsx: "typescriptreact", js: "javascript" };

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export class MemoryWorkspace implements WorkspaceAccess {
  diags: DiagnosticInfo[] = [];

  constructor(
    public files: Record<string, string>,
    readonly root = "/ws",
  ) {}

  async list(glob = "**/*", max = 200): Promise<string[]> {
    const re = globToRegExp(glob);
    return Object.keys(this.files)
      .filter((f) => re.test(f))
      .sort()
      .slice(0, max);
  }

  async read(rel: string): Promise<string | undefined> {
    return this.files[rel];
  }

  async search(query: string, opts: { regex: boolean; glob?: string; max: number }): Promise<SearchHit[]> {
    const re = opts.regex ? new RegExp(query) : undefined;
    const hits: SearchHit[] = [];
    for (const f of await this.list(opts.glob, 10_000)) {
      this.files[f].split("\n").forEach((text, line) => {
        if (hits.length < opts.max && (re ? re.test(text) : text.includes(query))) hits.push({ path: f, line, text });
      });
    }
    return hits;
  }

  diagnostics(rel?: string): DiagnosticInfo[] {
    return this.diags.filter((d) => !rel || d.path === rel);
  }

  languageOf(rel: string): string | undefined {
    return LANG[rel.split(".").pop() ?? ""];
  }
}
