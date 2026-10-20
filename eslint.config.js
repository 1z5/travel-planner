// ESLint flat config — 纯风格/质量规则（类型检查由 tsc --noEmit 负责）
// TS 7 太新，typescript-eslint 暂不支持，所以不用 type-aware rules
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "warn",
      "no-var": "error",
      eqeqeq: ["warn", "smart"],
      "no-duplicate-imports": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-t-*/**",
      ".next-verify/**",
      "out/**",
      "coverage/**",
      "scripts/stub-*.mjs",
      "scripts/*-stub.mjs",
      "*.config.*",
    ],
  },
];
