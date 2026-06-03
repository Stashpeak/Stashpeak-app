import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // src-tauri holds the Rust crate (no JS/TS) plus generated Tauri schemas; dist
    // and target are build output. eslint-config-prettier is last so it can turn
    // off any stylistic rules that would fight Prettier.
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      ".claude/**",
      "coverage/**",
      "*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-undef": "off",
      // New in ESLint 10's recommended set. The Tauri command wrappers in src/lib
      // already surface the original error's message via `${e}` interpolation but
      // do not chain it as a structured `{ cause }`. Kept as a tracked warning
      // rather than failing the gate; the proper cleanup (add `{ cause: e }` plus
      // the `ES2022.Error` tsconfig lib needed to type it) is a separate change.
      "preserve-caught-error": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
