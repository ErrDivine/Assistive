// Regressions for issues found while reviewing the unit tests.
import * as assert from "node:assert";
import { isSecretPath, resolveImport } from "../../src/code/context";
import { slugify } from "../../src/graph/model";
import { checkLinks } from "../../src/resources/links";
import { GraphStore, MAX_HISTORY } from "../../src/store/GraphStore";
import type { FileGraph } from "../../src/types";

describe("regressions", () => {
  it("slugify never ends with a separator after the length cut", () => {
    assert.strictEqual(slugify("a".repeat(47) + " b"), "a".repeat(47));
  });

  it("`from . import x` resolves to the package's __init__.py, not a sibling module", () => {
    const files = new Set(["app.py", "app/__init__.py", "app/main.py"]);
    assert.strictEqual(resolveImport(".", "app/main.py", "python", files), "app/__init__.py");
  });

  it(".env templates are readable; real .env files are not", () => {
    assert.strictEqual(isSecretPath(".env.example"), false);
    assert.strictEqual(isSecretPath("config/.env.sample"), false);
    assert.strictEqual(isSecretPath(".env"), true);
    assert.strictEqual(isSecretPath(".env.local"), true);
  });

  it("a refused HEAD followed by a failing GET costs exactly two requests", async () => {
    const calls: string[] = [];
    const { kept } = await checkLinks([{ title: "t", url: "https://x.test/a", type: "docs", why: "w" }], {
      verify: true,
      fetchImpl: async (_u, init) => {
        calls.push(String(init.method));
        if (init.method === "HEAD") return new Response(null, { status: 405 });
        throw new Error("network");
      },
    });
    assert.deepStrictEqual(calls, ["HEAD", "GET"]);
    assert.strictEqual(kept[0].verified, "unverified");
  });

  it("clearing a graph keeps the undo stack within MAX_HISTORY", () => {
    const store = new GraphStore(undefined);
    const g: FileGraph = { file: "a.py", language: "python", moduleString: "", nodes: [], edges: [], revision: 1, updatedAt: "" };
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      store.setGraph("/a.py", { ...g, revision: i }, false);
      store.clear("/a.py");
    }
    assert.strictEqual(store.get("/a.py").history.length, MAX_HISTORY);
  });
});
