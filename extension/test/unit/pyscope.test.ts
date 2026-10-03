import * as assert from "node:assert";
import { pythonEnclosingRange } from "../../src/code/pyscope";

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

  describe("multi-line headers", () => {
    // A Black-style signature whose closing `):` sits at the def's own
    // indentation must not cut the body off.
    it("a Black-style multi-line def signature keeps its body inside the range", () => {
      const src = ["def foo(", "    a,", "    b,", "):", "    x = 1", "    return x", "", "y = 2"];
      assert.deepStrictEqual(pythonEnclosingRange(src, 4), [0, 5]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 5), [0, 5]);
      assert.deepStrictEqual(pythonEnclosingRange(src, 1), [0, 5]);
    });
  });
});
