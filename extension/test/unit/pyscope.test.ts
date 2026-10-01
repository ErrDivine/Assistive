import * as assert from "node:assert";
import { isKeyword, lineIdentifiers, pythonEnclosingRange } from "../../src/context/pyscope";

/** Split a flush-left source literal into lines (drops the leading newline). */
function py(text: string): string[] {
  return text.replace(/^\n/, "").split("\n");
}

describe("pythonEnclosingRange", () => {
  const lines = py(`
import os
X = 1

@decorator
@other(arg=1)
def top(a, b):
    """Doc."""
    y = a + b

    # comment at body indent
# comment at column 0 inside the body
    return y


class Greeter:
    """A class."""

    registry = {}

    @staticmethod
    @cache
    def build(name):
        return Greeter(name)

    def __init__(self, name):
        self.name = name

    async def greet(self, other):
        def inner(x):
            def innermost(z):
                return z
            return innermost(x)

        value = inner(other)
        return value

    def last(self):
        pass


def after():
    return 1


print("top-level code")
`);
  /** Index of the first line containing ``needle``. */
  const at = (needle: string): number => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `fixture line not found: ${needle}`);
    return i;
  };
  const range = (line: number): [number, number] | undefined => pythonEnclosingRange(lines, line);

  describe("top-level code", () => {
    it("returns undefined for statements outside any def/class", () => {
      assert.strictEqual(range(at("import os")), undefined);
      assert.strictEqual(range(at("X = 1")), undefined);
      assert.strictEqual(range(at('print("top-level code")')), undefined);
    });

    it("returns undefined for blank lines between top-level blocks", () => {
      const beforeClass = at("class Greeter:") - 1;
      assert.strictEqual(lines[beforeClass], "");
      assert.strictEqual(range(beforeClass), undefined);
      assert.strictEqual(range(beforeClass - 1), undefined);
      assert.strictEqual(range(at("def after():") - 1), undefined);
    });

    it("returns undefined for empty input and a lone blank line", () => {
      assert.strictEqual(pythonEnclosingRange([], 0), undefined);
      assert.strictEqual(pythonEnclosingRange([""], 0), undefined);
    });

    it("returns undefined for lines outside the array", () => {
      assert.strictEqual(range(-1), undefined);
      assert.strictEqual(range(lines.length), undefined, "past the end behaves like a trailing blank line");
      assert.strictEqual(range(lines.length + 50), undefined);
    });
  });

  describe("top-level function with decorators", () => {
    const expected = (): [number, number] => [at("@decorator"), at("return y")];

    it("includes the decorators in the range", () => {
      assert.deepStrictEqual(range(at("y = a + b")), expected());
      assert.strictEqual(lines[expected()[0]], "@decorator");
    });

    it("covers the whole body for every line of the function", () => {
      for (let i = at("def top"); i <= at("return y"); i++) {
        assert.deepStrictEqual(range(i), expected(), `line ${i}: ${lines[i]}`);
      }
    });

    it("cursor on the def line itself selects that def (decorators included)", () => {
      assert.deepStrictEqual(range(at("def top(a, b):")), expected());
    });

    it("blank and comment lines inside the body stay inside the function", () => {
      const blankInBody = at("y = a + b") + 1;
      assert.strictEqual(lines[blankInBody], "");
      assert.deepStrictEqual(range(blankInBody), expected());
      assert.deepStrictEqual(range(at("# comment at body indent")), expected());
      assert.deepStrictEqual(range(at("# comment at column 0")), expected());
    });

    it("ends at the last real statement, not at trailing blank lines", () => {
      const [, end] = range(at("y = a + b"))!;
      assert.strictEqual(lines[end], "    return y");
    });
  });

  describe("class and methods", () => {
    const classRange = (): [number, number] => [at("class Greeter:"), at("        pass")];

    it("class-level statements belong to the class", () => {
      assert.deepStrictEqual(range(at("registry = {}")), classRange());
      assert.deepStrictEqual(range(at('"""A class."""')), classRange());
    });

    it("cursor on the class line selects the whole class", () => {
      assert.deepStrictEqual(range(at("class Greeter:")), classRange());
    });

    it("a blank line between two methods belongs to the class", () => {
      const between = at("def __init__") - 1;
      assert.strictEqual(lines[between], "");
      assert.deepStrictEqual(range(between), classRange());
    });

    it("the class range ends at its last method, before following top-level code", () => {
      assert.strictEqual(lines[classRange()[1]], "        pass");
      assert.ok(classRange()[1] < at("def after():"));
    });

    it("a decorated method includes all its decorators", () => {
      const expected: [number, number] = [at("@staticmethod"), at("return Greeter(name)")];
      assert.deepStrictEqual(range(at("return Greeter(name)")), expected);
      assert.deepStrictEqual(range(at("def build(name):")), expected);
      assert.strictEqual(lines[expected[0] + 1], "    @cache");
    });

    it("an undecorated method does not swallow the blank line or decorators above it", () => {
      const expected: [number, number] = [at("def __init__"), at("self.name = name")];
      assert.deepStrictEqual(range(at("self.name = name")), expected);
      assert.deepStrictEqual(range(at("def __init__")), expected);
    });

    it("async methods are recognised", () => {
      const expected: [number, number] = [at("async def greet"), at("return value")];
      assert.deepStrictEqual(range(at("value = inner(other)")), expected);
      assert.deepStrictEqual(range(at("async def greet")), expected);
    });

    it("the last method's range stops at its own body", () => {
      assert.deepStrictEqual(range(at("        pass")), [at("def last"), at("        pass")]);
    });
  });

  describe("nested functions", () => {
    it("picks the innermost function containing the cursor", () => {
      assert.deepStrictEqual(range(at("return z")), [at("def innermost"), at("return z")]);
    });

    it("after the innermost def ends, the next enclosing function is selected", () => {
      assert.deepStrictEqual(range(at("return innermost(x)")), [at("def inner(x)"), at("return innermost(x)")]);
    });

    it("cursor on a nested def line selects that nested def", () => {
      assert.deepStrictEqual(range(at("def innermost(z):")), [at("def innermost"), at("return z")]);
      assert.deepStrictEqual(range(at("def inner(x):")), [at("def inner(x)"), at("return innermost(x)")]);
    });

    it("a blank line after a nested def falls back to the enclosing method", () => {
      const blank = at("return innermost(x)") + 1;
      assert.strictEqual(lines[blank], "");
      assert.deepStrictEqual(range(blank), [at("async def greet"), at("return value")]);
    });

    it("does not pick a sibling def that ended before the cursor", () => {
      const src = py(`
def a():
    return 1

def b():
    x = 2
    return x
`);
      assert.deepStrictEqual(pythonEnclosingRange(src, 5), [3, 5]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 1), [0, 1]);
    });
  });

  describe("other shapes", () => {
    it("decorated class", () => {
      const src = py(`
@dataclass
class P:
    x: int
    y: int = 0
`);
      assert.deepStrictEqual(pythonEnclosingRange(src, 3), [0, 3]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 1), [0, 3]);
    });

    it("one-line class", () => {
      const src = py(`
class Empty: pass
x = 1
`);
      assert.deepStrictEqual(pythonEnclosingRange(src, 0), [0, 0]);
      assert.strictEqual(pythonEnclosingRange(src, 1), undefined);
    });

    it("tab indentation", () => {
      const src = ["class A:", "\tdef m(self):", "\t\treturn 1"];
      assert.deepStrictEqual(pythonEnclosingRange(src, 2), [1, 2]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 1), [1, 2]);
    });

    it("identifiers that merely start with def/class are not headers", () => {
      const src = ["classify = 1", "define = 2", "default = 3", "    x = 4"];
      assert.strictEqual(pythonEnclosingRange(src, 3), undefined);
      assert.strictEqual(pythonEnclosingRange(src, 0), undefined);
    });

    it("a def below the cursor is not considered", () => {
      const src = py(`
x = 1
def later():
    return 2
`);
      assert.strictEqual(pythonEnclosingRange(src, 0), undefined);
    });

    it("an indented class inside a function", () => {
      const src = py(`
def factory():
    class Local:
        attr = 1
    return Local
`);
      assert.deepStrictEqual(pythonEnclosingRange(src, 2), [1, 2]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 3), [0, 3]);
    });
  });

  describe("known bugs", () => {
    // BUG: pythonEnclosingRange (src/context/pyscope.ts, the `end` scan at
    // `if (indent(lines[j]) <= ind) break;`). A multi-line signature whose
    // closing line `):` sits at the def's own indentation (Black / PEP 8 style)
    // ends the block scan early, so the body is cut off.
    //   input   : ["def foo(", "    a,", "    b,", "):", "    x = 1", "    return x"], line 4
    //   expected: [0, 5]
    //   actual  : undefined  (and [0, 2] for lines 0-2, i.e. a range that stops before `):`)
    it("a Black-style multi-line def signature keeps its body inside the range", () => {
      const src = ["def foo(", "    a,", "    b,", "):", "    x = 1", "    return x", "", "y = 2"];
      assert.deepStrictEqual(pythonEnclosingRange(src, 4), [0, 5]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 5), [0, 5]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 1), [0, 5]);
    });
  });
});

describe("lineIdentifiers", () => {
  const words = (text: string, exclude?: string, max?: number): string[] =>
    lineIdentifiers(text, exclude, max).map((i) => i.word);

  it("returns identifiers with their 0-based column", () => {
    assert.deepStrictEqual(lineIdentifiers("x = requests.get(url, timeout=3)", undefined), [
      { word: "x", character: 0 },
      { word: "requests", character: 4 },
      { word: "get", character: 13 },
      { word: "url", character: 17 },
      { word: "timeout", character: 22 },
    ]);
  });

  it("columns refer to the original line, including leading whitespace", () => {
    assert.deepStrictEqual(lineIdentifiers("    def foo(bar):", undefined), [
      { word: "foo", character: 8 },
      { word: "bar", character: 12 },
    ]);
  });

  it("returns [] for empty and whitespace-only lines", () => {
    assert.deepStrictEqual(lineIdentifiers("", undefined), []);
    assert.deepStrictEqual(lineIdentifiers("   \t ", undefined), []);
  });

  it("skips Python keywords", () => {
    assert.deepStrictEqual(words("if x is not None and y in z:"), ["x", "y", "z"]);
    assert.deepStrictEqual(words("return await foo()"), ["foo"]);
    assert.deepStrictEqual(words("for item in items: yield item"), ["item", "items"]);
  });

  it("skips self and cls like keywords", () => {
    assert.deepStrictEqual(words("self.value = cls.make(arg)"), ["value", "make", "arg"]);
  });

  it("keeps identifiers that merely contain or start with a keyword", () => {
    assert.deepStrictEqual(words("iffy = import_data(format_, is_ok)"), ["iffy", "import_data", "format_", "is_ok"]);
  });

  it("keyword matching is case-sensitive", () => {
    assert.deepStrictEqual(words("true = none or False"), ["true", "none"]);
  });

  it("skips the excluded word everywhere it appears", () => {
    assert.deepStrictEqual(words("requests.get(url)", "get"), ["requests", "url"]);
    assert.deepStrictEqual(words("foo(foo, bar, foo)", "foo"), ["bar"]);
  });

  it("the excluded word must match exactly (not as a prefix or substring)", () => {
    assert.deepStrictEqual(words("get(getter, forget)", "get"), ["getter", "forget"]);
  });

  it("an undefined exclude excludes nothing", () => {
    assert.deepStrictEqual(words("a(b)", undefined), ["a", "b"]);
  });

  it("returns each identifier once, at its first position", () => {
    assert.deepStrictEqual(lineIdentifiers("foo(bar, foo, bar, baz)", undefined), [
      { word: "foo", character: 0 },
      { word: "bar", character: 4 },
      { word: "baz", character: 19 },
    ]);
  });

  it("does not treat standalone numbers as identifiers", () => {
    assert.deepStrictEqual(words("foo(1, 22, 333, 4.5)"), ["foo"]);
  });

  it("keeps identifiers that contain digits", () => {
    assert.deepStrictEqual(words("x1 = y2 + _3 + a_4b"), ["x1", "y2", "_3", "a_4b"]);
  });

  it("accepts leading underscores and dunder names", () => {
    assert.deepStrictEqual(words("_private = __dunder__"), ["_private", "__dunder__"]);
  });

  it("ignores everything after #", () => {
    assert.deepStrictEqual(words("x = 1  # y = z"), ["x"]);
    assert.deepStrictEqual(words("# only a comment"), []);
    assert.deepStrictEqual(words("a # b # c"), ["a"]);
  });

  it("stops at the first # even when it is the first character after indentation", () => {
    assert.deepStrictEqual(words("    # foo(bar)"), []);
  });

  describe("max", () => {
    it("defaults to 5", () => {
      assert.deepStrictEqual(words("a b c d e f g"), ["a", "b", "c", "d", "e"]);
    });

    it("honours a custom limit", () => {
      assert.deepStrictEqual(words("a b c d e", undefined, 2), ["a", "b"]);
      assert.deepStrictEqual(words("a b c d e", undefined, 10), ["a", "b", "c", "d", "e"]);
    });

    it("max 0 returns nothing", () => {
      assert.deepStrictEqual(words("a b c", undefined, 0), []);
    });

    it("keywords, duplicates and the excluded word do not use up the budget", () => {
      assert.deepStrictEqual(words("if if self a a skip b c", "skip", 2), ["a", "b"]);
    });
  });

  describe("known bugs", () => {
    // BUG: lineIdentifiers (src/context/pyscope.ts). The `/^\d/` guard can never
    // trigger because the regex cannot start a match on a digit, so the letter
    // suffix of a numeric literal is reported as an identifier.
    //   input   : "x = 1e5 + 0xFF + 10j + 3d"
    //   expected: ["x"]
    //   actual  : ["x", "e5", "xFF", "j", "d"]
    it("numeric literals with letters (1e5, 0xFF, 10j) yield no identifiers", () => {
      assert.deepStrictEqual(words("x = 1e5 + 0xFF + 10j + 3d"), ["x"]);
    });
  });
});

describe("isKeyword", () => {
  const KEYWORDS = (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try " +
    "while with yield"
  ).split(" ");

  it("is true for every Python hard keyword", () => {
    for (const k of KEYWORDS) {
      assert.strictEqual(isKeyword(k), true, k);
    }
  });

  it("is true for self and cls", () => {
    assert.strictEqual(isKeyword("self"), true);
    assert.strictEqual(isKeyword("cls"), true);
  });

  it("is false for ordinary identifiers and builtins", () => {
    for (const w of ["foo", "print", "len", "requests", "_", "x1", "selfish", "classy", "defs"]) {
      assert.strictEqual(isKeyword(w), false, w);
    }
  });

  it("is case-sensitive", () => {
    for (const w of ["true", "none", "FALSE", "Def", "Self", "IF"]) {
      assert.strictEqual(isKeyword(w), false, w);
    }
  });

  it("is false for the empty string and for words with surrounding whitespace", () => {
    assert.strictEqual(isKeyword(""), false);
    assert.strictEqual(isKeyword(" def"), false);
    assert.strictEqual(isKeyword("def "), false);
  });

  it("does not leak Object.prototype members", () => {
    assert.strictEqual(isKeyword("constructor"), false);
    assert.strictEqual(isKeyword("toString"), false);
    assert.strictEqual(isKeyword("__proto__"), false);
  });
});
