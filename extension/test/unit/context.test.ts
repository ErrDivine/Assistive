import * as assert from "node:assert";
import {
  riskyRegex,
  fileTree,
  isSecretPath,
  normalizeRel,
  numberLines,
  projectSummary,
  resolveImport,
  type DiagnosticInfo,
  type SearchHit,
  type WorkspaceAccess,
} from "../../src/code/context";
import type { FileOutline, OutlineSymbol } from "../../src/code/outline";

// The paths below are POSIX, like the CI machines (ubuntu, macos).

// ---------------------------------------------------------------- isSecretPath

describe("isSecretPath", () => {
  it("flags .env files and their variants", () => {
    for (const p of [".env", ".env.local", ".env.production", ".env.development.local", "app/.env", "a/b/c/.env.staging", "config\\.env"]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("flags key and certificate files", () => {
    for (const p of ["foo.pem", "certs/server.pem", "tls.key", "keys/private.key", "cert.p12", "cert.pfx", "release.keystore", "deep/dir/x.PEM"]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("flags ssh private keys", () => {
    for (const p of ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".ssh/id_rsa", "home/me/.ssh/id_ed25519"]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("flags credentials and secrets files", () => {
    for (const p of [
      "credentials.json",
      "credentials",
      "credentials.yaml",
      ".aws/credentials",
      "secrets.yaml",
      "secrets.yml",
      "secret.json",
      "secrets.json",
      "config/secrets.toml",
      "deploy/secret.yaml",
    ]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("flags package-manager auth files", () => {
    for (const p of [".npmrc", ".pypirc", ".netrc", "frontend/.npmrc"]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("is case-insensitive", () => {
    for (const p of [".ENV", "ID_RSA", "Credentials.JSON", "SECRETS.YAML", "Server.Pem"]) {
      assert.strictEqual(isSecretPath(p), true, p);
    }
  });

  it("normalizes Windows separators", () => {
    assert.strictEqual(isSecretPath("config\\prod\\secrets.yaml"), true);
    assert.strictEqual(isSecretPath("src\\app\\main.py"), false);
  });

  it("does not flag ordinary files", () => {
    for (const p of [
      "README.md",
      "src/app.py",
      "src/main.ts",
      "package.json",
      "tsconfig.json",
      "environment.py",
      "env.py",
      "src/envs/settings.py",
      "keyboard.py",
      "monkey.py",
      "keys.py",
      "foo.pem.md",
      "config/settings.json",
      "id_rsa.pub",
      "secrets.md",
      "docs/secret-santa.txt",
      ".envrc",
      "",
    ]) {
      assert.strictEqual(isSecretPath(p), false, JSON.stringify(p));
    }
  });

  it("only matches whole file names, not suffixes of longer ones", () => {
    assert.strictEqual(isSecretPath("src/my.env"), false);
    assert.strictEqual(isSecretPath("src/dotenv"), false);
    assert.strictEqual(isSecretPath("src/not_id_rsa"), false);
    assert.strictEqual(isSecretPath("src/old_secrets.json"), false);
  });
});

// ---------------------------------------------------------------- normalizeRel

describe("normalizeRel", () => {
  const root = "/ws/proj";

  it("keeps a relative path", () => {
    assert.strictEqual(normalizeRel(root, "src/app.py"), "src/app.py");
    assert.strictEqual(normalizeRel(root, "app.py"), "app.py");
  });

  it("strips ./ and normalizes inner segments", () => {
    assert.strictEqual(normalizeRel(root, "./src/app.py"), "src/app.py");
    assert.strictEqual(normalizeRel(root, "src//app.py"), "src/app.py");
    assert.strictEqual(normalizeRel(root, "src/./app.py"), "src/app.py");
    assert.strictEqual(normalizeRel(root, "src/lib/../app.py"), "src/app.py");
  });

  it("makes an absolute path inside the root relative", () => {
    assert.strictEqual(normalizeRel(root, "/ws/proj/src/app.py"), "src/app.py");
    assert.strictEqual(normalizeRel(root, "/ws/proj/app.py"), "app.py");
  });

  it("treats an absolute path outside the root as root-relative ('/app/x.py' meant <root>/app/x.py)", () => {
    assert.strictEqual(normalizeRel(root, "/app/x.py"), "app/x.py");
    assert.strictEqual(normalizeRel(root, "/etc/passwd"), "etc/passwd");
    assert.strictEqual(normalizeRel(root, "/ws/project/x.py"), "ws/project/x.py", "a sibling folder that merely shares a prefix is not the root");
    assert.strictEqual(normalizeRel(root, "///app/x.py"), "app/x.py");
  });

  it("rejects paths that escape the root", () => {
    assert.strictEqual(normalizeRel(root, "../escape"), undefined);
    assert.strictEqual(normalizeRel(root, "../../etc/passwd"), undefined);
    assert.strictEqual(normalizeRel(root, "src/../../escape.py"), undefined);
    assert.strictEqual(normalizeRel(root, "./../x"), undefined);
    assert.strictEqual(normalizeRel(root, ".."), undefined);
  });

  it("rejects absolute paths that climb out of the root", () => {
    assert.strictEqual(normalizeRel(root, "/app/../../etc/passwd"), undefined);
    assert.strictEqual(normalizeRel(root, "/app/../../../../etc/passwd"), undefined);
  });

  it("allows .. that stays inside the root", () => {
    assert.strictEqual(normalizeRel(root, "a/b/../../c.py"), "c.py");
    assert.strictEqual(normalizeRel(root, "src/../README.md"), "README.md");
  });

  it("converts Windows separators", () => {
    assert.strictEqual(normalizeRel(root, "src\\app\\main.py"), "src/app/main.py");
    assert.strictEqual(normalizeRel(root, "..\\escape"), undefined);
  });

  it("trims surrounding whitespace", () => {
    assert.strictEqual(normalizeRel(root, "  src/app.py \n"), "src/app.py");
  });

  it("the root itself is the empty path", () => {
    assert.strictEqual(normalizeRel(root, ""), "");
    assert.strictEqual(normalizeRel(root, "."), "");
    assert.strictEqual(normalizeRel(root, root), "");
    assert.strictEqual(normalizeRel(root, `${root}/`), "");
  });

  it("never returns an absolute path or one that climbs out with ../", () => {
    for (const p of ["/x", "//x", "x/..", "../x", "/../x", "a/../../b", "/ws/proj/../x", "\\x", "~/x"]) {
      const r = normalizeRel(root, p);
      if (r !== undefined) {
        assert.ok(!r.startsWith("/") && r !== ".." && !r.startsWith("../"), `${p} -> ${r}`);
      }
    }
  });

  it("accepts a file or folder whose name merely starts with '..'", () => {
    assert.strictEqual(normalizeRel(root, "..hidden/x.py"), "..hidden/x.py");
    assert.strictEqual(normalizeRel(root, "src/..data"), "src/..data");
  });
});

// ---------------------------------------------------------------- numberLines

describe("numberLines", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");

  it("numbers every line from 1 by default", () => {
    assert.strictEqual(numberLines("a\nb\nc"), "1| a\n2| b\n3| c");
  });

  it("right-aligns the numbers to the widest one", () => {
    assert.strictEqual(
      numberLines(ten),
      [" 1| l1", " 2| l2", " 3| l3", " 4| l4", " 5| l5", " 6| l6", " 7| l7", " 8| l8", " 9| l9", "10| l10"].join("\n"),
    );
    const hundred = Array.from({ length: 100 }, (_, i) => `x${i + 1}`).join("\n");
    const lines = numberLines(hundred).split("\n");
    assert.strictEqual(lines[0], "  1| x1");
    assert.strictEqual(lines[9], " 10| x10");
    assert.strictEqual(lines[99], "100| x100");
  });

  it("numbers a range with the original line numbers", () => {
    assert.strictEqual(numberLines(ten, 3, 5), "3| l3\n4| l4\n5| l5");
  });

  it("sizes the gutter from the last line shown, not from the file length", () => {
    assert.strictEqual(numberLines(ten, 2, 4), "2| l2\n3| l3\n4| l4");
    assert.strictEqual(numberLines(ten, 8, 10), " 8| l8\n 9| l9\n10| l10");
  });

  it("includes both ends of the range", () => {
    assert.strictEqual(numberLines(ten, 4, 4), "4| l4");
    assert.strictEqual(numberLines(ten, 1, 1), "1| l1");
    assert.strictEqual(numberLines(ten, 10, 10), "10| l10");
  });

  it("without an end, runs to the last line", () => {
    assert.strictEqual(numberLines(ten, 9), " 9| l9\n10| l10");
  });

  it("clamps an end past the end of the file", () => {
    assert.strictEqual(numberLines("a\nb", 1, 99), "1| a\n2| b");
    assert.strictEqual(numberLines("a\nb", 2, 1000), "2| b");
  });

  it("clamps a start below 1", () => {
    assert.strictEqual(numberLines("a\nb", 0), "1| a\n2| b");
    assert.strictEqual(numberLines("a\nb", -5, 1), "1| a");
  });

  it("is empty when the range is empty or lies past the end", () => {
    assert.strictEqual(numberLines("a\nb", 5), "");
    assert.strictEqual(numberLines("a\nb", 5, 9), "");
    assert.strictEqual(numberLines("a\nb\nc", 3, 2), "");
  });

  it("handles CRLF line endings without leaving carriage returns", () => {
    const out = numberLines("a\r\nb\r\nc");
    assert.strictEqual(out, "1| a\n2| b\n3| c");
    assert.ok(!out.includes("\r"));
  });

  it("keeps indentation and inner spacing", () => {
    assert.strictEqual(numberLines("def f():\n    return  1"), "1| def f():\n2|     return  1");
  });

  it("numbers blank lines too", () => {
    assert.strictEqual(numberLines("a\n\nb"), "1| a\n2| \n3| b");
  });

  it("a single empty line is line 1", () => {
    assert.strictEqual(numberLines(""), "1| ");
  });

  it("the empty line after a trailing newline counts as a line (as in the editor)", () => {
    assert.strictEqual(numberLines("a\n"), "1| a\n2| ");
  });
});

// ---------------------------------------------------------------- fileTree

describe("fileTree", () => {
  it("is empty for no files", () => {
    assert.strictEqual(fileTree([]), "");
  });

  it("lists root files without indentation", () => {
    assert.strictEqual(fileTree(["README.md", "setup.py"]), "README.md\nsetup.py");
  });

  it("indents by folder depth and prints each folder once", () => {
    const tree = fileTree(["README.md", "src/app.py", "src/util/a.py", "src/util/b.py", "tests/t.py"]);
    assert.strictEqual(tree, ["README.md", "src/", "  app.py", "  util/", "    a.py", "    b.py", "tests/", "  t.py"].join("\n"));
  });

  it("handles deep nesting", () => {
    assert.strictEqual(fileTree(["a/b/c/d.py"]), ["a/", "  b/", "    c/", "      d.py"].join("\n"));
  });

  it("returns to a shallower folder correctly", () => {
    assert.strictEqual(fileTree(["a/b/c.py", "a/d.py", "e.py"]), ["a/", "  b/", "    c.py", "  d.py", "e.py"].join("\n"));
  });

  it("only prints the folders that changed between neighbours", () => {
    const tree = fileTree(["pkg/a/x.py", "pkg/a/y.py", "pkg/b/z.py"]).split("\n");
    assert.deepStrictEqual(tree, ["pkg/", "  a/", "    x.py", "    y.py", "  b/", "    z.py"]);
  });

  it("caps the listing and counts the rest", () => {
    const paths = Array.from({ length: 5 }, (_, i) => `f${i}.py`);
    assert.strictEqual(fileTree(paths, 3), "f0.py\nf1.py\nf2.py\n… and 2 more files");
  });

  it("has no marker when exactly max files are given", () => {
    const paths = ["a.py", "b.py", "c.py"];
    assert.strictEqual(fileTree(paths, 3), "a.py\nb.py\nc.py");
    assert.ok(!fileTree(paths, 4).includes("more files"));
  });

  it("defaults to 150 files", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, "0")}.py`);
    const lines = fileTree(paths).split("\n");
    assert.strictEqual(lines.length, 151);
    assert.strictEqual(lines[150], "… and 50 more files");
    assert.strictEqual(lines[149], "f149.py");
  });

  it("the marker comes after folder lines of the shown files only", () => {
    const tree = fileTree(["a/1.py", "a/2.py", "b/3.py"], 2);
    assert.strictEqual(tree, "a/\n  1.py\n  2.py\n… and 1 more files");
  });
});

// ---------------------------------------------------------------- resolveImport

describe("resolveImport (python)", () => {
  const files = new Set([
    "main.py",
    "root_mod.py",
    "util.py",
    "app/__init__.py",
    "app/main.py",
    "app/cache.py",
    "app/util/__init__.py",
    "app/util/http.py",
    "app/pkg/mod.py",
    "app/sub/__init__.py",
    "app/sub/deep.py",
    "src/util.py",
    "src/lib/__init__.py",
    "src/lib/core.py",
    "src/lib/helpers.py",
    "src/srcpkg/cache.py",
    "dual/m.py",
    "dual/m/__init__.py",
  ]);
  const resolve = (spec: string, from: string) => resolveImport(spec, from, "python", files);

  describe("relative imports", () => {
    it("'.cache' is a sibling module", () => {
      assert.strictEqual(resolve(".cache", "app/main.py"), "app/cache.py");
    });

    it("'.util' is a package (its __init__.py)", () => {
      assert.strictEqual(resolve(".util", "app/main.py"), "app/util/__init__.py");
    });

    it("dotted names descend into packages", () => {
      assert.strictEqual(resolve(".util.http", "app/main.py"), "app/util/http.py");
      assert.strictEqual(resolve(".pkg.mod", "app/main.py"), "app/pkg/mod.py");
    });

    it("'..' goes up one package", () => {
      assert.strictEqual(resolve("..cache", "app/sub/deep.py"), "app/cache.py");
      assert.strictEqual(resolve("..util.http", "app/sub/deep.py"), "app/util/http.py");
      assert.strictEqual(resolve("..pkg.mod", "app/sub/deep.py"), "app/pkg/mod.py");
    });

    it("'...' goes up two packages, to the repo root here", () => {
      assert.strictEqual(resolve("...root_mod", "app/sub/deep.py"), "root_mod.py");
    });

    it("a bare '.' or '..' is the package's __init__.py", () => {
      assert.strictEqual(resolve(".", "app/main.py"), "app/__init__.py");
      assert.strictEqual(resolve("..", "app/sub/deep.py"), "app/__init__.py");
    });

    it("works for a file at the repo root", () => {
      assert.strictEqual(resolve(".util", "main.py"), "util.py");
      assert.strictEqual(resolve(".root_mod", "main.py"), "root_mod.py");
    });

    it("returns undefined when the module is not in the workspace", () => {
      assert.strictEqual(resolve(".nothing", "app/main.py"), undefined);
      assert.strictEqual(resolve("..nothing.at.all", "app/sub/deep.py"), undefined);
    });

    it("prefers module.py over a package of the same name", () => {
      assert.strictEqual(resolve(".m", "dual/x.py"), "dual/m.py");
    });

    it("does not look at the root for a relative import", () => {
      assert.strictEqual(resolve(".util", "app/pkg/mod.py"), undefined, "app/pkg has no util");
    });
  });

  describe("absolute imports", () => {
    it("resolves from the repo root", () => {
      assert.strictEqual(resolve("app.cache", "main.py"), "app/cache.py");
      assert.strictEqual(resolve("app.util.http", "main.py"), "app/util/http.py");
      assert.strictEqual(resolve("root_mod", "app/main.py"), "root_mod.py");
    });

    it("resolves from the repo root when imported from a nested file", () => {
      assert.strictEqual(resolve("app.cache", "app/sub/deep.py"), "app/cache.py");
    });

    it("resolves a package name to its __init__.py", () => {
      assert.strictEqual(resolve("app", "main.py"), "app/__init__.py");
      assert.strictEqual(resolve("app.util", "main.py"), "app/util/__init__.py");
      assert.strictEqual(resolve("app.sub", "root_mod.py"), "app/sub/__init__.py");
    });

    it("resolves a module in src/ (src layout)", () => {
      assert.strictEqual(resolve("lib.core", "main.py"), "src/lib/core.py");
      assert.strictEqual(resolve("srcpkg.cache", "main.py"), "src/srcpkg/cache.py");
      assert.strictEqual(resolve("srcpkg.cache", "app/main.py"), "src/srcpkg/cache.py");
    });

    it("resolves from src/ when importing from a file inside src/", () => {
      assert.strictEqual(resolve("lib.helpers", "src/lib/core.py"), "src/lib/helpers.py");
      assert.strictEqual(resolve("lib", "src/lib/core.py"), "src/lib/__init__.py");
    });

    it("prefers the repo root over src/ when both have the module", () => {
      assert.strictEqual(resolve("util", "main.py"), "util.py");
    });

    it("tries ancestor folders of the importing file (a source root further down)", () => {
      const nested = new Set(["proj/code/pkg/__init__.py", "proj/code/pkg/a.py", "proj/code/pkg/sub/b.py"]);
      assert.strictEqual(resolveImport("pkg.a", "proj/code/pkg/sub/b.py", "python", nested), "proj/code/pkg/a.py");
      assert.strictEqual(resolveImport("pkg", "proj/code/pkg/sub/b.py", "python", nested), "proj/code/pkg/__init__.py");
    });

    it("finds the source root of a deeply nested fixture project", () => {
      const nested = new Set([
        "eval/fixtures/src/fixture_app/app/cache.py",
        "eval/fixtures/src/fixture_app/app/client.py",
        "eval/fixtures/src/fixture_app/app/__init__.py",
      ]);
      assert.strictEqual(resolveImport("app.cache", "eval/fixtures/src/fixture_app/app/client.py", "python", nested), "eval/fixtures/src/fixture_app/app/cache.py");
    });

    it("returns undefined for the standard library and third-party packages", () => {
      for (const spec of ["os", "os.path", "json", "requests", "numpy.linalg", "__future__", "typing"]) {
        assert.strictEqual(resolve(spec, "app/main.py"), undefined, spec);
      }
    });

    it("returns undefined for a missing module under a real package", () => {
      assert.strictEqual(resolve("app.missing", "main.py"), undefined);
    });
  });
});

describe("resolveImport (typescript / javascript)", () => {
  const files = new Set([
    "src/a.ts",
    "src/util.ts",
    "src/dir/index.ts",
    "src/x.ts",
    "src/lib/y.tsx",
    "src/sub/z.js",
    "src/comp/index.tsx",
    "src/data.json",
    "src/esm.mjs",
    "src/both.ts",
    "src/both.js",
    "src/dirfile.ts",
    "src/dirfile/index.ts",
    "src/index.ts",
    "lib/shared.ts",
    "top.ts",
  ]);
  const resolve = (spec: string, from = "src/a.ts", language = "typescript") => resolveImport(spec, from, language, files);

  it("'./util' resolves to util.ts", () => {
    assert.strictEqual(resolve("./util"), "src/util.ts");
  });

  it("'./dir' resolves to dir/index.ts", () => {
    assert.strictEqual(resolve("./dir"), "src/dir/index.ts");
    assert.strictEqual(resolve("./comp"), "src/comp/index.tsx");
  });

  it("'./x.js' resolves to x.ts (ESM-style specifiers for TypeScript sources)", () => {
    assert.strictEqual(resolve("./x.js"), "src/x.ts");
  });

  it("a specifier that is already a real file resolves to it", () => {
    assert.strictEqual(resolve("./sub/z.js"), "src/sub/z.js");
    assert.strictEqual(resolve("./data.json"), "src/data.json");
    assert.strictEqual(resolve("./util.ts"), "src/util.ts");
  });

  it("tries the usual extensions", () => {
    assert.strictEqual(resolve("./lib/y"), "src/lib/y.tsx");
    assert.strictEqual(resolve("./sub/z"), "src/sub/z.js");
    assert.strictEqual(resolve("./esm"), "src/esm.mjs");
  });

  it("prefers .ts over .js", () => {
    assert.strictEqual(resolve("./both"), "src/both.ts");
  });

  it("prefers a file over a directory index of the same name", () => {
    assert.strictEqual(resolve("./dirfile"), "src/dirfile.ts");
  });

  it("goes up with ..", () => {
    assert.strictEqual(resolve("../lib/shared"), "lib/shared.ts");
    assert.strictEqual(resolve("../top", "src/sub/q.ts"), undefined, "../top from src/sub is src/top, which does not exist");
    assert.strictEqual(resolve("../../top", "src/sub/q.ts"), "top.ts");
  });

  it("resolves '.' to the folder's index file", () => {
    assert.strictEqual(resolve("."), "src/index.ts");
  });

  it("works for a file at the repo root", () => {
    assert.strictEqual(resolve("./top", "main.ts"), "top.ts");
    assert.strictEqual(resolve("./src/util", "main.ts"), "src/util.ts");
  });

  it("returns undefined for bare packages", () => {
    for (const spec of ["react", "lodash/get", "@scope/pkg", "node:fs", "fs", "vscode"]) {
      assert.strictEqual(resolve(spec), undefined, spec);
    }
  });

  it("returns undefined for a relative path that does not exist", () => {
    assert.strictEqual(resolve("./missing"), undefined);
    assert.strictEqual(resolve("./dir/missing"), undefined);
  });

  it("behaves the same for every non-python language id", () => {
    for (const language of ["typescript", "typescriptreact", "javascript", "javascriptreact"]) {
      assert.strictEqual(resolve("./util", "src/a.ts", language), "src/util.ts", language);
    }
  });

  it("does not treat a python-style dotted name as a TypeScript import", () => {
    assert.strictEqual(resolve("app.cache"), undefined);
  });
});

// ---------------------------------------------------------------- projectSummary

/** An in-memory workspace over a path -> text record. */
class FakeWorkspace implements WorkspaceAccess {
  readonly root = "/ws/proj";
  readonly reads: string[] = [];
  unreadable = new Set<string>();

  constructor(readonly files: Record<string, string>) {}

  async list(_glob?: string, max = 200): Promise<string[]> {
    return Object.keys(this.files).sort().slice(0, max);
  }

  async read(rel: string): Promise<string | undefined> {
    this.reads.push(rel);
    return this.unreadable.has(rel) ? undefined : this.files[rel];
  }

  async search(query: string, opts: { regex: boolean; glob?: string; max: number }): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const re = opts.regex ? new RegExp(query) : undefined;
    for (const [path, text] of Object.entries(this.files)) {
      text.split("\n").forEach((line, i) => {
        if (hits.length < opts.max && (re ? re.test(line) : line.includes(query))) {
          hits.push({ path, line: i, text: line });
        }
      });
    }
    return hits;
  }

  diagnostics(_rel?: string): DiagnosticInfo[] {
    return [];
  }

  languageOf(rel: string): string | undefined {
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".") + 1) : "";
    return { py: "python", ts: "typescript", tsx: "typescriptreact", js: "javascript", json: "json", md: "markdown" }[ext];
  }
}

function symbol(name: string, line: number, over: Partial<OutlineSymbol> = {}): OutlineSymbol {
  return { name, qualname: over.parent ? `${over.parent}.${name}` : name, kind: "function", line, endLine: line + 2, signature: `def ${name}()`, isStub: false, ...over };
}

function outline(opts: { doc?: string; symbols?: OutlineSymbol[]; imports?: string[]; language?: string } = {}): FileOutline {
  return {
    language: opts.language ?? "python",
    moduleString: opts.doc === undefined ? undefined : { text: opts.doc, closed: true, startLine: 0, endLine: opts.doc.split("\n").length },
    symbols: opts.symbols ?? [],
    imports: opts.imports ?? [],
    parser: "regex",
    hasErrors: false,
  };
}

/** An outlineOf stub backed by a table, recording what it was asked for. */
function outlineStub(table: Record<string, FileOutline>) {
  const calls: { rel: string; text: string }[] = [];
  const fn = async (rel: string, text: string): Promise<FileOutline> => {
    calls.push({ rel, text });
    return table[rel] ?? outline();
  };
  return { fn, calls };
}

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("projectSummary", () => {
  const baseFiles = (): Record<string, string> => ({
    "README.md": lines(40, "readme"),
    "package.json": JSON.stringify({
      name: "demo-app",
      version: "9.9.9",
      type: "module",
      scripts: { build: "tsc", secretscript: "do-not-include" },
      engines: { node: ">=22" },
      dependencies: { dotenv: "^18" },
      devDependencies: { mocha: "^12" },
    }),
    "pyproject.toml": lines(70, "toml"),
    "src/app/__init__.py": "",
    "src/app/main.py": "from .cache import Cache\nimport os\n",
    "src/app/cache.py": '"""Cache layer.\n\nDetails."""\nclass Cache: ...\n',
    "src/app/util.py": "def helper(): ...\n",
    "src/app/data.json": "{}",
    "src/other/thing.py": "x = 1\n",
    "tests/test_main.py": "def test_it(): ...\n",
  });

  const mainOutline = (imports: string[]): FileOutline => outline({ imports, doc: "Main entry." });

  it("starts with the file tree", async () => {
    const ws = new FakeWorkspace(baseFiles());
    const stub = outlineStub({});
    const out = await projectSummary(ws, "src/app/main.py", mainOutline([]), stub.fn);
    const files = Object.keys(baseFiles()).sort();
    assert.ok(out.startsWith(`Workspace files (${files.length}):\n`), out.slice(0, 80));
    assert.ok(out.includes(fileTree(files)), "the indented tree is included");
    assert.ok(out.includes("src/\n  app/\n    __init__.py\n    cache.py"), out);
    assert.ok(out.includes("tests/\n  test_main.py"), out);
  });

  it("marks a truncated file list and caps the tree", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 450; i++) files[`pkg/m${String(i).padStart(3, "0")}.py`] = "";
    const out = await projectSummary(new FakeWorkspace(files), "pkg/m000.py", outline(), outlineStub({}).fn);
    assert.ok(out.startsWith("Workspace files (400+):\n"), out.slice(0, 60));
    assert.ok(out.includes("… and 250 more files"), "the tree shows 150 files and counts the rest");
  });

  it("includes the manifests, truncated to 50 lines", async () => {
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([]), outlineStub({}).fn);
    assert.ok(out.includes("pyproject.toml:\ntoml 1\n"), out);
    assert.ok(out.includes("toml 50"), out);
    assert.ok(!out.includes("toml 51"), "only the first 50 lines");
  });

  it("reduces package.json to name, type, engines and dependencies", async () => {
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([]), outlineStub({}).fn);
    const section = out.split("\n\n").find((s) => s.startsWith("package.json:"));
    assert.ok(section, "package.json section present");
    assert.ok(section.includes('"name": "demo-app"'), section);
    assert.ok(section.includes('"type": "module"'), section);
    assert.ok(section.includes('"node": ">=22"'), section);
    assert.ok(section.includes('"dotenv": "^18"'), section);
    assert.ok(section.includes('"mocha": "^12"'), section);
    assert.ok(!section.includes("scripts"), "scripts are dropped");
    assert.ok(!section.includes("secretscript"), section);
    assert.ok(!section.includes("9.9.9"), "the version is dropped");
    assert.doesNotThrow(() => JSON.parse(section.slice("package.json:\n".length)));
  });

  it("keeps an unparseable package.json as raw text", async () => {
    const files = baseFiles();
    files["package.json"] = "{ this is: not json,\nsecond line";
    const out = await projectSummary(new FakeWorkspace(files), "src/app/main.py", mainOutline([]), outlineStub({}).fn);
    assert.ok(out.includes("package.json:\n{ this is: not json,\nsecond line"), out);
  });

  it("lists the manifests in a fixed order and skips absent ones", async () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{}}',
      "requirements.txt": "requests\n",
      "package.json": '{"name":"n"}',
      "setup.py": "setup()\n",
      "app.py": "",
    };
    const out = await projectSummary(new FakeWorkspace(files), "app.py", outline(), outlineStub({}).fn);
    const order = ["requirements.txt:", "setup.py:", "package.json:", "tsconfig.json:"].map((h) => out.indexOf(`\n\n${h}`));
    assert.ok(order.every((i) => i > 0), `all present: ${order}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "in MANIFESTS order");
    assert.ok(!out.includes("pyproject.toml:"));
    assert.ok(!out.includes("setup.cfg:"));
  });

  it("only looks for manifests at the workspace root", async () => {
    const files = { "sub/package.json": '{"name":"nested"}', "app.py": "" };
    const out = await projectSummary(new FakeWorkspace(files), "app.py", outline(), outlineStub({}).fn);
    assert.ok(!out.includes("package.json:"), out);
  });

  it("includes the README head (30 lines)", async () => {
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([]), outlineStub({}).fn);
    assert.ok(out.includes("README.md (head):\nreadme 1\n"), out);
    assert.ok(out.includes("readme 30"), out);
    assert.ok(!out.includes("readme 31"), "only the first 30 lines");
  });

  it("finds the README in its common spellings, only at the root", async () => {
    for (const name of ["README", "readme.md", "Readme.rst", "README.txt"]) {
      const out = await projectSummary(new FakeWorkspace({ [name]: "hello readme", "a.py": "" }), "a.py", outline(), outlineStub({}).fn);
      assert.ok(out.includes(`${name} (head):\nhello readme`), name);
    }
    const nested = await projectSummary(new FakeWorkspace({ "docs/README.md": "hidden", "a.py": "" }), "a.py", outline(), outlineStub({}).fn);
    assert.ok(!nested.includes("(head)"), nested);
  });

  it("includes the outline of the local modules the file imports, with the first docstring line", async () => {
    const ws = new FakeWorkspace(baseFiles());
    const stub = outlineStub({
      "src/app/cache.py": outline({ doc: "Cache layer.\n\nDetails.", symbols: [symbol("get", 2), symbol("put", 6), symbol("Cache", 0, { kind: "class" })] }),
    });
    const out = await projectSummary(ws, "src/app/main.py", mainOutline([".cache", "os", "json"]), stub.fn);
    assert.ok(out.includes("Imported module src/app/cache.py — Cache layer.:\nL3-5 def get()\nL7-9 def put()\nL1-3 def Cache()"), out);
    assert.ok(!out.includes("Imported module os"), "the standard library is skipped");
    const asked = stub.calls.filter((c) => c.rel === "src/app/cache.py");
    assert.ok(asked.length >= 1);
    assert.ok(asked.every((c) => c.text === baseFiles()["src/app/cache.py"]), "the outline is built from the file's text");
  });

  it("omits the docstring part when the imported module has none", async () => {
    const stub = outlineStub({ "src/app/util.py": outline({ symbols: [symbol("helper", 0)] }) });
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([".util"]), stub.fn);
    assert.ok(out.includes("Imported module src/app/util.py:\nL1-3 def helper()"), out);
  });

  it("includes a '[stub]' marker and the imports line from the outline text", async () => {
    const stub = outlineStub({ "src/app/util.py": outline({ imports: ["os", "json"], symbols: [symbol("todo", 0, { isStub: true })] }) });
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([".util"]), stub.fn);
    assert.ok(out.includes("Imported module src/app/util.py:\nimports: os, json\nL1-3 def todo()  [stub]"), out);
  });

  it("does not list the file itself, an unresolved import, or the same module twice", async () => {
    const stub = outlineStub({});
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([".main", ".cache", ".cache", "app.cache", ".nope"]), stub.fn);
    assert.strictEqual(out.split("Imported module src/app/cache.py").length - 1, 1);
    assert.ok(!out.includes("Imported module src/app/main.py"));
    assert.ok(!out.includes(".nope"));
  });

  it("includes at most five imported modules", async () => {
    const files: Record<string, string> = { "pkg/main.py": "" };
    for (let i = 0; i < 8; i++) files[`pkg/m${i}.py`] = "";
    const imports = Array.from({ length: 8 }, (_, i) => `.m${i}`);
    const out = await projectSummary(new FakeWorkspace(files), "pkg/main.py", outline({ imports }), outlineStub({}).fn);
    const shown = [...out.matchAll(/^Imported module ([^\s:]+)/gm)].map((m) => m[1]);
    assert.deepStrictEqual(shown, ["pkg/m0.py", "pkg/m1.py", "pkg/m2.py", "pkg/m3.py", "pkg/m4.py"]);
  });

  it("truncates each imported module's outline to 40 lines", async () => {
    const symbols = Array.from({ length: 60 }, (_, i) => symbol(`fn${i}`, i * 3));
    const stub = outlineStub({ "src/app/util.py": outline({ symbols }) });
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([".util"]), stub.fn);
    const section = out.split("\n\n").find((s) => s.startsWith("Imported module src/app/util.py"))!;
    assert.strictEqual(section.split("\n").length, 1 + 40);
    assert.ok(section.includes("def fn39()"));
    assert.ok(!section.includes("def fn40()"));
  });

  it("skips an imported module whose text cannot be read", async () => {
    const ws = new FakeWorkspace(baseFiles());
    ws.unreadable.add("src/app/cache.py");
    const stub = outlineStub({});
    const out = await projectSummary(ws, "src/app/main.py", mainOutline([".cache"]), stub.fn);
    assert.ok(!out.includes("Imported module"), out);
    assert.ok(!stub.calls.some((c) => c.rel === "src/app/cache.py"));
  });

  it("lists sibling modules with the first docstring line and their top-level names", async () => {
    const stub = outlineStub({
      "src/app/cache.py": outline({
        doc: "Cache layer.\n\nDetails.",
        symbols: [symbol("Cache", 0, { kind: "class" }), symbol("get", 1, { kind: "method", parent: "Cache" }), symbol("put", 4, { kind: "method", parent: "Cache" }), symbol("TTL", 9, { kind: "constant" }), symbol("_registry", 10, { kind: "variable" })],
      }),
      "src/app/util.py": outline({ symbols: [symbol("helper", 0)] }),
    });
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([]), stub.fn);
    assert.ok(out.includes("Other modules in src/app/:\n"), out);
    assert.ok(out.includes("- src/app/cache.py: Cache layer. [Cache, TTL]"), out);
    assert.ok(out.includes("- src/app/util.py: (no docstring) [helper]"), out);
  });

  it("siblings exclude the file itself, other folders, and other languages", async () => {
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([]), outlineStub({}).fn);
    const section = out.split("\n\n").find((s) => s.startsWith("Other modules in"))!;
    assert.ok(!section.includes("src/app/main.py"), section);
    assert.ok(!section.includes("src/other/thing.py"), section);
    assert.ok(!section.includes("tests/test_main.py"), section);
    assert.ok(!section.includes("data.json"), section);
    assert.ok(section.includes("src/app/__init__.py"), section);
    assert.ok(section.includes("src/app/cache.py"), section);
    assert.ok(section.includes("src/app/util.py"), section);
  });

  it("a sibling without symbols has no name list", async () => {
    const out = await projectSummary(new FakeWorkspace({ "a/main.py": "", "a/other.py": "" }), "a/main.py", outline(), outlineStub({}).fn);
    assert.ok(out.endsWith("\n- a/other.py: (no docstring)"), out);
  });

  it("lists at most eight siblings and eight names each", async () => {
    const files: Record<string, string> = { "pkg/main.py": "" };
    for (let i = 0; i < 12; i++) files[`pkg/s${String(i).padStart(2, "0")}.py`] = "";
    const symbols = Array.from({ length: 12 }, (_, i) => symbol(`n${i}`, i));
    const table: Record<string, FileOutline> = {};
    for (const f of Object.keys(files)) table[f] = outline({ symbols });
    const out = await projectSummary(new FakeWorkspace(files), "pkg/main.py", outline(), outlineStub(table).fn);
    const section = out.split("\n\n").find((s) => s.startsWith("Other modules in"))!;
    const rows = section.split("\n").slice(1);
    assert.strictEqual(rows.length, 8);
    assert.ok(rows[0].endsWith("[n0, n1, n2, n3, n4, n5, n6, n7]"), rows[0]);
  });

  it("calls the heading 'the root folder' for a file at the workspace root", async () => {
    const out = await projectSummary(new FakeWorkspace({ "main.py": "", "helpers.py": "" }), "main.py", outline(), outlineStub({}).fn);
    assert.ok(out.includes("Other modules in the root folder:\n- helpers.py: (no docstring)"), out);
  });

  it("has no sibling section when the file is alone in its folder", async () => {
    const out = await projectSummary(new FakeWorkspace({ "pkg/main.py": "", "other/x.py": "" }), "pkg/main.py", outline(), outlineStub({}).fn);
    assert.ok(!out.includes("Other modules in"), out);
  });

  it("matches siblings by language", async () => {
    const files = { "web/app.ts": "", "web/util.ts": "", "web/legacy.js": "", "web/readme.md": "" };
    const out = await projectSummary(new FakeWorkspace(files), "web/app.ts", outline({ language: "typescript" }), outlineStub({}).fn);
    assert.ok(out.includes("- web/util.ts:"), out);
    assert.ok(!out.includes("web/legacy.js:"), out);
    assert.ok(!out.includes("web/readme.md:"), out);
  });

  it("resolves TypeScript imports", async () => {
    const files = { "src/a.ts": "", "src/util.ts": "export const x = 1;", "src/dir/index.ts": "" };
    const stub = outlineStub({ "src/util.ts": outline({ language: "typescript", doc: "Utilities.", symbols: [symbol("x", 0, { kind: "constant", signature: "export const x = 1" })] }) });
    const out = await projectSummary(new FakeWorkspace(files), "src/a.ts", outline({ language: "typescript", imports: ["./util", "react", "./dir"] }), stub.fn);
    assert.ok(out.includes("Imported module src/util.ts — Utilities.:\nL1-3 export const x = 1"), out);
    assert.ok(out.includes("Imported module src/dir/index.ts:"), out);
    assert.ok(!out.includes("Imported module react"), out);
  });

  it("orders the sections: tree, manifests, README, imports, siblings", async () => {
    const out = await projectSummary(new FakeWorkspace(baseFiles()), "src/app/main.py", mainOutline([".cache"]), outlineStub({}).fn);
    const marks = ["Workspace files (", "\n\npyproject.toml:", "\n\npackage.json:", "\n\nREADME.md (head):", "\n\nImported module src/app/cache.py", "\n\nOther modules in src/app/:"];
    const at = marks.map((m) => out.indexOf(m));
    assert.ok(at.every((i) => i >= 0), `all sections present: ${at}`);
    // MANIFESTS order puts pyproject.toml before package.json.
    assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
  });

  it("separates sections with a blank line", async () => {
    const out = await projectSummary(new FakeWorkspace({ "README.md": "hi", "a.py": "" }), "a.py", outline(), outlineStub({}).fn);
    assert.strictEqual(out, "Workspace files (2):\nREADME.md\na.py\n\nREADME.md (head):\nhi");
  });

  it("works for an empty workspace", async () => {
    const out = await projectSummary(new FakeWorkspace({}), "new.py", outline(), outlineStub({}).fn);
    assert.strictEqual(out, "Workspace files (0):\n");
  });

  it("asks for the workspace listing with a 400 file cap", async () => {
    let asked: { glob?: string; max?: number } | undefined;
    const ws = new FakeWorkspace({ "a.py": "" });
    const original = ws.list.bind(ws);
    ws.list = async (glob?: string, max?: number) => {
      asked = { glob, max };
      return original(glob, max);
    };
    await projectSummary(ws, "a.py", outline(), outlineStub({}).fn);
    assert.deepStrictEqual(asked, { glob: undefined, max: 400 });
  });
});

describe("riskyRegex", () => {
  it("flags quantified groups that contain a quantifier", () => {
    for (const p of ["(a+)+", "(\\w*)*", "([a-z]+)*", "(x+){2,}", "(?:\\s*foo)+"]) assert.strictEqual(riskyRegex(p), true, p);
  });

  it("accepts ordinary patterns", () => {
    for (const p of ["def \\w+\\(text", "fetch_(issues|pulls)", "(foo|bar)+", "\\bclass\\s+\\w+", "a+b*", "(x+)?"]) assert.strictEqual(riskyRegex(p), false, p);
  });
});

