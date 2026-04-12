/**
 * Shared ESLint 9 Flat Config for Next.js Apps
 *
 * This config standardizes linting rules across all Next.js apps in the monorepo.
 * It includes:
 * - TypeScript parser with project-level type-aware linting
 * - Next.js Core Web Vitals rules
 * - Consistent rule severity across all apps
 *
 * Usage in app-level eslint.config.mjs:
 * ```javascript
 * import { createRequire } from "module";
 * import { fileURLToPath } from "url";
 * import { dirname, resolve } from "path";
 * import { nextJsConfig } from "@repo/eslint-config/next-js";
 *
 * const require = createRequire(import.meta.url);
 * const __dirname = dirname(fileURLToPath(import.meta.url));
 *
 * export default nextJsConfig(__dirname, require);
 * ```
 *
 * @package @repo/eslint-config
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

/**
 * Create Next.js ESLint config for a specific app
 *
 * @param appDir - Absolute path to the app directory
 * @param req - Node.js require function from the app's eslint.config.mjs
 * @returns ESLint 9 flat config array
 */
export function createNextJsConfig(appDir, req) {
  return [
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      languageOptions: {
        parser: req("@typescript-eslint/parser"),
        parserOptions: {
          ecmaFeatures: { jsx: true },
          project: resolve(appDir, "tsconfig.json"),
        },
      },
      plugins: {
        "@typescript-eslint": req("@typescript-eslint/eslint-plugin"),
        "@next/next": req("@next/eslint-plugin-next"),
      },
      rules: {
        // TypeScript strict rules
        // NOTE: no-explicit-any and no-misused-promises set to warn (not error)
        // to allow builds to pass in large codebases with pre-existing any usage.
        // These should be fixed incrementally over time.
        "@typescript-eslint/no-explicit-any": "warn",
        "@typescript-eslint/no-unused-vars": [
          "warn",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            destructuredArrayIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/no-floating-promises": "warn",
        "@typescript-eslint/no-misused-promises": "warn",

        // Core Web Vitals and Next.js recommended rules
        "@next/next/no-html-link-for-pages": "error",
        "@next/next/no-img-element": "warn",
        "@next/next/no-css-tags": "error",
        "@next/next/no-duplicate-head": "error",
        "@next/next/no-typos": "error",
        "@next/next/no-script-component-in-head": "error",
        "@next/next/no-async-client-component": "warn",
        "@next/next/no-page-custom-font": "error",
        "@next/next/no-before-interactive-script-outside-document": "error",
        "@next/next/no-styled-jsx-in-document": "error",
        "@next/next/no-sync-scripts": "error",
        "@next/next/no-unwanted-polyfillio": "error",
        "@next/next/google-font-display": "warn",
        "@next/next/google-font-preconnect": "warn",
      },
      settings: {
        next: {
          dir: appDir,
        },
      },
    },
    {
      ignores: [
        ".next/**",
        "out/**",
        "build/**",
        "next-env.d.ts",
        "node_modules/**",
        ".turbo/**",
      ],
    },
  ];
}

/**
 * Base TypeScript config for non-Next.js packages
 *
 * @param req - Node.js require function
 * @returns ESLint 9 flat config array
 */
export function createTsConfig(req) {
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
      ignores: ["node_modules/**", "dist/**", ".turbo/**"],
    },
  ];
}
