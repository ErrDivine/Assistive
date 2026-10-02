// A small JSON Schema subset for tool parameters, with a validator that
// produces messages the model can act on ("nodes[2].kind must be one of …").

export interface JsonSchema {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface Checked {
  value: unknown;
  errors: string[];
  /** Unknown fields that were dropped. */
  ignored: string[];
}

/** Validate and lightly coerce (numeric strings → numbers, "true" → true, scalar → [scalar]). */
export function check(value: unknown, schema: JsonSchema, path = "arguments"): Checked {
  const errors: string[] = [];
  const ignored: string[] = [];
  const walk = (v: unknown, s: JsonSchema, p: string): unknown => {
    switch (s.type) {
      case "object": {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          errors.push(`${p} must be an object.`);
          return v;
        }
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const req of s.required ?? []) {
          if (obj[req] === undefined || obj[req] === null) {
            errors.push(`${p}.${req} is required.`);
          }
        }
        for (const [k, val] of Object.entries(obj)) {
          const ps = s.properties?.[k];
          if (!ps) {
            if (s.additionalProperties === false) {
              ignored.push(`${p}.${k}`);
              continue;
            }
            out[k] = val;
            continue;
          }
          if (val === null || val === undefined) {
            continue; // optional field sent as null
          }
          out[k] = walk(val, ps, `${p}.${k}`);
        }
        return out;
      }
      case "array": {
        let arr = v;
        if (!Array.isArray(arr)) {
          if (arr !== undefined && arr !== null && typeof arr !== "object") {
            arr = [arr];
          } else if (arr && typeof arr === "object" && s.items?.type === "object") {
            arr = [arr];
          } else {
            errors.push(`${p} must be an array.`);
            return v;
          }
        }
        const list = arr as unknown[];
        if (s.minItems !== undefined && list.length < s.minItems) {
          errors.push(`${p} needs at least ${s.minItems} item(s).`);
        }
        if (s.maxItems !== undefined && list.length > s.maxItems) {
          errors.push(`${p} allows at most ${s.maxItems} item(s); got ${list.length}.`);
        }
        return s.items ? list.map((x, i) => walk(x, s.items!, `${p}[${i}]`)) : list;
      }
      case "string": {
        if (typeof v === "number" || typeof v === "boolean") {
          v = String(v);
        }
        if (typeof v !== "string") {
          errors.push(`${p} must be a string.`);
          return v;
        }
        if (s.enum && !s.enum.includes(v)) {
          errors.push(`${p} must be one of ${s.enum.join(", ")}; got '${v}'.`);
        }
        if (s.minLength !== undefined && v.trim().length < s.minLength) {
          errors.push(`${p} must not be empty.`);
        }
        if (s.maxLength !== undefined && v.length > s.maxLength) {
          return v.slice(0, s.maxLength);
        }
        return v;
      }
      case "integer":
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n) || (s.type === "integer" && !Number.isInteger(n))) {
          errors.push(`${p} must be ${s.type === "integer" ? "an integer" : "a number"}.`);
          return v;
        }
        if ((s.minimum !== undefined && n < s.minimum) || (s.maximum !== undefined && n > s.maximum)) {
          errors.push(`${p} must be between ${s.minimum ?? "-∞"} and ${s.maximum ?? "∞"}; got ${n}.`);
        }
        return n;
      }
      case "boolean": {
        if (v === "true" || v === "false") {
          return v === "true";
        }
        if (typeof v !== "boolean") {
          errors.push(`${p} must be true or false.`);
        }
        return v;
      }
      default:
        return v;
    }
  };
  const out = walk(value, schema, path);
  return { value: out, errors, ignored };
}
