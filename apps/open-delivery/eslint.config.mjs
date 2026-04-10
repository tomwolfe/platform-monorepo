// ESLint 9 Flat Config for open-delivery
// Uses shared config from @repo/eslint-config

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createNextJsConfig } from "@repo/eslint-config/next-js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export default createNextJsConfig(__dirname, require);
