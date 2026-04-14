/**
 * Shared ESLint 9 Flat Config for TypeScript packages
 *
 * Usage in package-level eslint.config.mjs:
 * ```javascript
 * import { createRequire } from "module";
 * import { fileURLToPath } from "url";
 * import { dirname } from "path";
 * import { tsConfig } from "@repo/eslint-config/ts";
 *
 * const require = createRequire(import.meta.url);
 *
 * export default tsConfig(require);
 * ```
 *
 * @package @repo/eslint-config
 */

/**
 * Base TypeScript config for non-Next.js packages
 *
 * @param req - Node.js require function
 * @returns ESLint 9 flat config array
 */
export function tsConfig(req) {
  return [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: req("@typescript-eslint/parser"),
        parserOptions: {
          project: "./tsconfig.json",
        },
      },
      plugins: {
        "@typescript-eslint": req("@typescript-eslint/eslint-plugin"),
      },
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unused-vars": [
          "warn",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/no-floating-promises": "warn",
      },
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.ts", "**/__tests__/**/*.tsx"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": [
          "warn",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
          },
        ],
      },
    },
    {
      ignores: ["node_modules/**", "dist/**", ".turbo/**"],
    },
  ];
}
