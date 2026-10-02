// Loads the tree-sitter WASM runtime and grammars (from @vscode/tree-sitter-wasm,
// copied to dist/wasm by the build). Parsers are created once per grammar.

import * as path from "node:path";
import { Language, Parser, type Tree } from "@vscode/tree-sitter-wasm";

export type Grammar = "python" | "typescript" | "tsx" | "javascript";

/** VS Code language id → grammar. */
export function grammarFor(languageId: string): Grammar | undefined {
  switch (languageId) {
    case "python":
      return "python";
    case "typescript":
      return "typescript";
    case "typescriptreact":
      return "tsx";
    case "javascript":
    case "javascriptreact":
      return "javascript";
    default:
      return undefined;
  }
}

export class TreeSitter {
  private init?: Promise<void>;
  private readonly parsers = new Map<Grammar, Promise<Parser>>();

  /** `wasmDir` holds tree-sitter.wasm and tree-sitter-<grammar>.wasm. */
  constructor(private readonly wasmDir: string) {}

  private ready(): Promise<void> {
    this.init ??= Parser.init({ locateFile: (file: string) => path.join(this.wasmDir, file) });
    return this.init;
  }

  private parser(grammar: Grammar): Promise<Parser> {
    let p = this.parsers.get(grammar);
    if (!p) {
      p = (async () => {
        await this.ready();
        const lang = await Language.load(path.join(this.wasmDir, `tree-sitter-${grammar}.wasm`));
        const parser = new Parser();
        parser.setLanguage(lang);
        return parser;
      })();
      // A failed load is retried on the next call instead of being cached.
      p.catch(() => this.parsers.delete(grammar));
      this.parsers.set(grammar, p);
    }
    return p;
  }

  /** Parse `text`; the caller must `delete()` the tree. */
  async parse(grammar: Grammar, text: string): Promise<Tree | undefined> {
    const parser = await this.parser(grammar);
    return parser.parse(text) ?? undefined;
  }
}
