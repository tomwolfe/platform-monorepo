// ESLint 9 Flat Config for shared package
// Uses shared config from @repo/eslint-config

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { tsConfig } from "@repo/eslint-config/ts";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export default tsConfig(require);
