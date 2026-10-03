import * as assert from "node:assert";
import { check, type JsonSchema } from "../../src/llm/schema";

// A schema shaped like the graph tools' parameters.
const NODE: JsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["function", "class", "method"] },
    label: { type: "string", maxLength: 10 },
    order: { type: "integer", minimum: 1, maximum: 99 },
    notes: { type: "array", items: { type: "string" } },
  },
};
const ADD_NODES: JsonSchema = {
  type: "object",
  required: ["nodes"],
  additionalProperties: false,
  properties: { nodes: { type: "array", minItems: 1, maxItems: 3, items: NODE } },
};

describe("check: objects", () => {
  it("accepts a valid value and returns it without errors", () => {
    const r = check({ nodes: [{ id: "a", kind: "function" }] }, ADD_NODES);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ignored, []);
    assert.deepStrictEqual(r.value, { nodes: [{ id: "a", kind: "function" }] });
  });

  it("reports each missing required field with its path", () => {
    const r = check({}, ADD_NODES);
    assert.deepStrictEqual(r.errors, ["arguments.nodes is required."]);
    const r2 = check({ nodes: [{ kind: "class" }, { id: "b" }] }, ADD_NODES);
    assert.deepStrictEqual(r2.errors, ["arguments.nodes[0].id is required.", "arguments.nodes[1].kind is required."]);
  });

  it("treats null and undefined required fields as missing", () => {
    const r = check({ id: null, kind: undefined }, NODE);
    assert.deepStrictEqual(r.errors, ["arguments.id is required.", "arguments.kind is required."]);
  });

  it("does not report a null required field twice", () => {
    const r = check({ id: null, kind: "class" }, NODE);
    assert.deepStrictEqual(r.errors, ["arguments.id is required."]);
  });

  for (const [label, bad] of [
    ["an array", []],
    ["null", null],
    ["a string", "x"],
    ["a number", 3],
    ["undefined", undefined],
  ] as [string, unknown][]) {
    it(`rejects ${label} where an object is expected`, () => {
      const r = check(bad, NODE);
      assert.deepStrictEqual(r.errors, ["arguments must be an object."]);
      assert.strictEqual(r.value, bad);
    });
  }

  it("uses a custom root path in messages", () => {
    const r = check({}, NODE, "update_nodes");
    assert.deepStrictEqual(r.errors, ["update_nodes.id is required.", "update_nodes.kind is required."]);
    assert.deepStrictEqual(check(5, NODE, "args").errors, ["args must be an object."]);
  });

  it("puts the index in the path of nested type errors: arguments.nodes[2].kind", () => {
    const r = check(
      {
        nodes: [
          { id: "a", kind: "function" },
          { id: "b", kind: "class" },
          { id: "c", kind: "banana" },
        ],
      },
      ADD_NODES,
    );
    assert.deepStrictEqual(r.errors, ["arguments.nodes[2].kind must be one of function, class, method; got 'banana'."]);
  });

  it("reports errors in several items, in order", () => {
    const r = check({ nodes: [{ id: "a", kind: "x" }, { id: "b", kind: "class", order: "soon" }] }, ADD_NODES);
    assert.deepStrictEqual(r.errors, [
      "arguments.nodes[0].kind must be one of function, class, method; got 'x'.",
      "arguments.nodes[1].order must be an integer.",
    ]);
  });

  it("returns the original value for a field that fails its type check", () => {
    const r = check({ id: "a", kind: "class", order: "soon" }, NODE);
    assert.strictEqual((r.value as Record<string, unknown>).order, "soon");
  });

  it("does not validate fields that have no property schema when additionalProperties is not false", () => {
    const schema: JsonSchema = { type: "object", properties: { a: { type: "integer" } } };
    const r = check({ a: "1", extra: { deep: [1, 2] } }, schema);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ignored, []);
    assert.deepStrictEqual(r.value, { a: 1, extra: { deep: [1, 2] } });
  });

  it("passes values through for a schema without a type", () => {
    const r = check({ x: [1, "a"] }, { type: "object", properties: { x: {} } });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.value, { x: [1, "a"] });
    assert.deepStrictEqual(check("anything", {}).value, "anything");
  });
});

describe("check: unknown fields (additionalProperties: false)", () => {
  it("drops unknown fields into `ignored` with their path", () => {
    const r = check({ id: "a", kind: "class", colour: "red" }, NODE);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ignored, ["arguments.colour"]);
    assert.deepStrictEqual(r.value, { id: "a", kind: "class" });
  });

  it("reports nested unknown fields with the item index", () => {
    const r = check({ nodes: [{ id: "a", kind: "class" }, { id: "b", kind: "class", bogus: 1 }], extra: true }, ADD_NODES);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual([...r.ignored].sort(), ["arguments.extra", "arguments.nodes[1].bogus"]);
    assert.deepStrictEqual((r.value as { nodes: unknown[] }).nodes[1], { id: "b", kind: "class" });
    assert.ok(!("extra" in (r.value as object)));
  });

  it("an unknown field is not an error even when its value is garbage", () => {
    const r = check({ id: "a", kind: "class", junk: { a: [] } }, NODE);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ignored, ["arguments.junk"]);
  });
});

describe("check: optional fields sent as null", () => {
  it("skips null and undefined optional fields instead of validating them", () => {
    const r = check({ id: "a", kind: "class", order: null, label: undefined, notes: null }, NODE);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ignored, []);
    assert.deepStrictEqual(r.value, { id: "a", kind: "class" });
  });

  it("a null optional field does not trigger min/max or type errors", () => {
    const schema: JsonSchema = { type: "object", properties: { n: { type: "integer", minimum: 5 }, list: { type: "array", minItems: 2 } } };
    assert.deepStrictEqual(check({ n: null, list: null }, schema).errors, []);
  });
});

describe("check: arrays", () => {
  const list: JsonSchema = { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } };

  it("enforces minItems", () => {
    assert.deepStrictEqual(check(["a"], list).errors, ["arguments needs at least 2 item(s)."]);
    assert.deepStrictEqual(check([], list).errors, ["arguments needs at least 2 item(s)."]);
    assert.deepStrictEqual(check(["a", "b"], list).errors, []);
  });

  it("enforces maxItems and reports the actual count", () => {
    assert.deepStrictEqual(check(["a", "b", "c"], list).errors, []);
    assert.deepStrictEqual(check(["a", "b", "c", "d", "e"], list).errors, ["arguments allows at most 3 item(s); got 5."]);
  });

  it("uses the field path for item-count errors", () => {
    const r = check({ nodes: [] }, ADD_NODES);
    assert.deepStrictEqual(r.errors, ["arguments.nodes needs at least 1 item(s)."]);
    const tooMany = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, kind: "class" }));
    assert.deepStrictEqual(check({ nodes: tooMany }, ADD_NODES).errors, ["arguments.nodes allows at most 3 item(s); got 4."]);
  });

  it("wraps a scalar in an array", () => {
    const r = check("solo", { type: "array", items: { type: "string" } });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.value, ["solo"]);
  });

  it("wraps a scalar and then coerces it to the item type", () => {
    const r = check("7", { type: "array", items: { type: "integer" } });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.value, [7]);
    assert.deepStrictEqual(check(5, { type: "array", items: { type: "string" } }).value, ["5"]);
    assert.deepStrictEqual(check(true, { type: "array", items: { type: "boolean" } }).value, [true]);
  });

  it("a wrapped scalar still counts toward minItems", () => {
    const r = check("solo", list);
    assert.deepStrictEqual(r.errors, ["arguments needs at least 2 item(s)."]);
  });

  it("wraps a single object when the items are objects", () => {
    const r = check({ nodes: { id: "a", kind: "class" } }, ADD_NODES);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.value, { nodes: [{ id: "a", kind: "class" }] });
  });

  it("does not wrap an object when the items are not objects", () => {
    const r = check({ x: 1 }, { type: "array", items: { type: "string" } });
    assert.deepStrictEqual(r.errors, ["arguments must be an array."]);
  });

  it("rejects null and undefined where an array is required", () => {
    assert.deepStrictEqual(check(null, list).errors, ["arguments must be an array."]);
    assert.deepStrictEqual(check(undefined, list).errors, ["arguments must be an array."]);
  });

  it("validates every item and keeps going after the first failure", () => {
    const r = check([1, {}, "ok", null], { type: "array", items: { type: "string" } });
    // 1 is coerced to "1"; {} and null are not strings.
    assert.deepStrictEqual(r.errors, ["arguments[1] must be a string.", "arguments[3] must be a string."]);
    assert.deepStrictEqual((r.value as unknown[])[0], "1");
  });

  it("returns the list untouched when there is no item schema", () => {
    const r = check([1, "a", { b: 2 }], { type: "array" });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.value, [1, "a", { b: 2 }]);
  });

  it("checks both the count and the items in one pass", () => {
    const r = check([{ id: "a" }], { type: "array", minItems: 2, items: NODE });
    assert.deepStrictEqual(r.errors, ["arguments needs at least 2 item(s).", "arguments[0].kind is required."]);
  });
});

describe("check: strings", () => {
  it("rejects objects, arrays and null", () => {
    const s: JsonSchema = { type: "string" };
    assert.deepStrictEqual(check({}, s).errors, ["arguments must be a string."]);
    assert.deepStrictEqual(check(["a"], s).errors, ["arguments must be a string."]);
    assert.deepStrictEqual(check(null, s).errors, ["arguments must be a string."]);
  });

  it("coerces numbers and booleans to strings", () => {
    assert.strictEqual(check(42, { type: "string" }).value, "42");
    assert.strictEqual(check(1.5, { type: "string" }).value, "1.5");
    assert.strictEqual(check(false, { type: "string" }).value, "false");
    assert.deepStrictEqual(check(42, { type: "string" }).errors, []);
  });

  it("reports enum violations with the allowed values and the offending one", () => {
    const r = check("purple", { type: "string", enum: ["red", "green"] });
    assert.deepStrictEqual(r.errors, ["arguments must be one of red, green; got 'purple'."]);
    assert.deepStrictEqual(check("red", { type: "string", enum: ["red", "green"] }).errors, []);
  });

  it("enum matching is case-sensitive", () => {
    const r = check("Red", { type: "string", enum: ["red"] });
    assert.deepStrictEqual(r.errors, ["arguments must be one of red; got 'Red'."]);
  });

  it("a coerced number can satisfy a string enum", () => {
    assert.deepStrictEqual(check(2, { type: "string", enum: ["1", "2"] }).errors, []);
  });

  it("minLength rejects empty and whitespace-only strings", () => {
    const s: JsonSchema = { type: "string", minLength: 1 };
    assert.deepStrictEqual(check("", s).errors, ["arguments must not be empty."]);
    assert.deepStrictEqual(check("   \n", s).errors, ["arguments must not be empty."]);
    assert.deepStrictEqual(check(" x ", s).errors, []);
  });

  it("minLength is measured on the trimmed text", () => {
    const s: JsonSchema = { type: "string", minLength: 3 };
    assert.deepStrictEqual(check("  ab  ", s).errors, ["arguments must not be empty."]);
    assert.deepStrictEqual(check("abc", s).errors, []);
  });

  it("truncates to maxLength without an error", () => {
    const r = check("abcdefghijklmnop", { type: "string", maxLength: 5 });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.value, "abcde");
  });

  it("keeps a string that is exactly maxLength", () => {
    assert.strictEqual(check("abcde", { type: "string", maxLength: 5 }).value, "abcde");
  });

  it("truncates nested strings, as for a node label", () => {
    const r = check({ id: "a", kind: "class", label: "a very long label indeed" }, NODE);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual((r.value as { label: string }).label, "a very lon");
  });

  it("validates the enum before truncating", () => {
    const r = check("abcdefgh", { type: "string", enum: ["abc"], maxLength: 3 });
    assert.deepStrictEqual(r.errors, ["arguments must be one of abc; got 'abcdefgh'."]);
  });
});

describe("check: numbers and integers", () => {
  it("accepts integers for both types", () => {
    assert.deepStrictEqual(check(3, { type: "integer" }).errors, []);
    assert.deepStrictEqual(check(3, { type: "number" }).errors, []);
    assert.deepStrictEqual(check(-7, { type: "integer" }).errors, []);
  });

  it("rejects a fractional value for integer but not for number", () => {
    assert.deepStrictEqual(check(1.5, { type: "integer" }).errors, ["arguments must be an integer."]);
    assert.deepStrictEqual(check(1.5, { type: "number" }).errors, []);
    assert.strictEqual(check(1.5, { type: "number" }).value, 1.5);
  });

  it("rejects non-numeric types with the right wording", () => {
    assert.deepStrictEqual(check({}, { type: "integer" }).errors, ["arguments must be an integer."]);
    assert.deepStrictEqual(check([], { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check(true, { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check(null, { type: "integer" }).errors, ["arguments must be an integer."]);
  });

  it("rejects NaN and infinities", () => {
    assert.deepStrictEqual(check(NaN, { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check(Infinity, { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check(-Infinity, { type: "integer" }).errors, ["arguments must be an integer."]);
    assert.deepStrictEqual(check("Infinity", { type: "number" }).errors, ["arguments must be a number."]);
  });

  it("coerces numeric strings", () => {
    assert.strictEqual(check("12", { type: "integer" }).value, 12);
    assert.strictEqual(check(" 12 ", { type: "integer" }).value, 12);
    assert.strictEqual(check("0.25", { type: "number" }).value, 0.25);
    assert.strictEqual(check("-3", { type: "integer" }).value, -3);
    assert.strictEqual(check("1e2", { type: "number" }).value, 100);
    assert.strictEqual(check("5.0", { type: "integer" }).value, 5);
    assert.deepStrictEqual(check("12", { type: "integer" }).errors, []);
  });

  it("rejects strings that are not numbers", () => {
    assert.deepStrictEqual(check("abc", { type: "integer" }).errors, ["arguments must be an integer."]);
    assert.deepStrictEqual(check("12px", { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check("", { type: "number" }).errors, ["arguments must be a number."]);
    assert.deepStrictEqual(check("   ", { type: "integer" }).errors, ["arguments must be an integer."]);
  });

  it("rejects a fractional numeric string for integer", () => {
    assert.deepStrictEqual(check("1.5", { type: "integer" }).errors, ["arguments must be an integer."]);
  });

  it("returns the original value when coercion fails", () => {
    assert.strictEqual(check("abc", { type: "integer" }).value, "abc");
  });

  it("enforces minimum and maximum with the value in the message", () => {
    const s: JsonSchema = { type: "integer", minimum: 1, maximum: 5 };
    assert.deepStrictEqual(check(0, s).errors, ["arguments must be between 1 and 5; got 0."]);
    assert.deepStrictEqual(check(6, s).errors, ["arguments must be between 1 and 5; got 6."]);
    assert.deepStrictEqual(check(1, s).errors, []);
    assert.deepStrictEqual(check(5, s).errors, []);
  });

  it("checks the range on the coerced number", () => {
    const s: JsonSchema = { type: "integer", minimum: 1, maximum: 5 };
    assert.deepStrictEqual(check("9", s).errors, ["arguments must be between 1 and 5; got 9."]);
    assert.deepStrictEqual(check("3", s).errors, []);
  });

  it("shows an infinite bound when only one side is set", () => {
    assert.deepStrictEqual(check(0, { type: "number", minimum: 1 }).errors, ["arguments must be between 1 and ∞; got 0."]);
    assert.deepStrictEqual(check(9, { type: "number", maximum: 5 }).errors, ["arguments must be between -∞ and 5; got 9."]);
  });

  it("an out-of-range number is still returned (as a number) alongside the error", () => {
    const r = check("9", { type: "integer", maximum: 5 });
    assert.strictEqual(r.value, 9);
    assert.strictEqual(r.errors.length, 1);
  });

  it("a type error takes precedence over range errors", () => {
    const r = check(1.5, { type: "integer", minimum: 5 });
    assert.deepStrictEqual(r.errors, ["arguments must be an integer."]);
  });
});

describe("check: booleans", () => {
  it("accepts true and false", () => {
    assert.deepStrictEqual(check(true, { type: "boolean" }), { value: true, errors: [], ignored: [] });
    assert.deepStrictEqual(check(false, { type: "boolean" }), { value: false, errors: [], ignored: [] });
  });

  it('coerces "true" and "false"', () => {
    assert.deepStrictEqual(check("true", { type: "boolean" }), { value: true, errors: [], ignored: [] });
    assert.deepStrictEqual(check("false", { type: "boolean" }), { value: false, errors: [], ignored: [] });
  });

  it("only coerces the exact lowercase spellings", () => {
    for (const bad of ["TRUE", "False", "yes", "1", "", " true"]) {
      assert.deepStrictEqual(check(bad, { type: "boolean" }).errors, ["arguments must be true or false."], bad);
    }
  });

  it("rejects numbers, objects and null", () => {
    assert.deepStrictEqual(check(1, { type: "boolean" }).errors, ["arguments must be true or false."]);
    assert.deepStrictEqual(check(0, { type: "boolean" }).errors, ["arguments must be true or false."]);
    assert.deepStrictEqual(check({}, { type: "boolean" }).errors, ["arguments must be true or false."]);
    assert.deepStrictEqual(check(null, { type: "boolean" }).errors, ["arguments must be true or false."]);
  });

  it("coerces inside objects and keeps the path in errors", () => {
    const schema: JsonSchema = { type: "object", properties: { regex: { type: "boolean" } } };
    assert.deepStrictEqual((check({ regex: "true" }, schema).value as { regex: boolean }).regex, true);
    assert.deepStrictEqual(check({ regex: "maybe" }, schema).errors, ["arguments.regex must be true or false."]);
  });
});

describe("check: a realistic bad tool call", () => {
  it("collects every problem from one call", () => {
    const r = check(
      {
        nodes: [
          { id: "ok", kind: "function", order: "2" },
          { id: "", kind: "function" },
          { id: "bad", kind: "widget", order: 0, colour: "red" },
        ],
        verbose: true,
      },
      ADD_NODES,
    );
    assert.deepStrictEqual(r.errors, [
      "arguments.nodes[1].id must not be empty.",
      "arguments.nodes[2].kind must be one of function, class, method; got 'widget'.",
      "arguments.nodes[2].order must be between 1 and 99; got 0.",
    ]);
    assert.deepStrictEqual([...r.ignored].sort(), ["arguments.nodes[2].colour", "arguments.verbose"]);
    assert.strictEqual((r.value as { nodes: { order?: number }[] }).nodes[0].order, 2);
  });
});
