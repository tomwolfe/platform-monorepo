// ESLint 9 Flat Config for table-stack
// Uses eslint-config-next's internal setup via require()
// to avoid ESM/CJS interop issues with subpath exports.

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the legacy config from eslint-config-next
const legacyConfig = require("eslint-config-next");

// For ESLint 9 flat config, we use a minimal config that
// leverages the eslint-config-next parser and settings.
export default [
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: resolve(__dirname, "tsconfig.json"),
      },
    },
    plugins: {
      "@next/next": require("@next/eslint-plugin-next"),
    },
    rules: {
      // Filter out rules that reference plugins we don't have loaded
      ...Object.fromEntries(
        Object.entries(legacyConfig.rules || {}).filter(
          ([key]) => !key.startsWith("import/") && !key.startsWith("jsx-a11y/") && !key.startsWith("react-hooks/") && !key.startsWith("react/")
        )
      ),
      // Core Web Vitals
      "@next/next/no-html-link-for-pages": "error",
      "@next/next/no-img-element": "error",
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
    settings: legacyConfig.settings || {},
  },
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"],
  },
];
