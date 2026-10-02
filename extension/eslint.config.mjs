import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", "node_modules/**", "*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression.callee[property.name=/^(applyEdit|edit|insertSnippet)$/]",
          message: "Invariant I1: Assistive never modifies the user's buffers.",
        },
        {
          selector: "NewExpression[callee.property.name='WorkspaceEdit']",
          message: "Invariant I1: Assistive never modifies the user's buffers.",
        },
      ],
    },
  },
  {
    // Tests type into documents themselves (the I1 check excludes that typing).
    files: ["test/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
