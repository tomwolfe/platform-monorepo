// ESLint 9 Flat Config for intention-engine
// Standalone config without eslint-config-next to avoid @rushstack/eslint-patch issues

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

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
      // Custom rules from original .eslintrc.json
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "warn",
      // Core Web Vitals and Next.js recommended rules
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
        dir: __dirname,
      },
    },
  },
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"],
  },
];
