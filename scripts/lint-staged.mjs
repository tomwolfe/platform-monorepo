#!/usr/bin/env node
/**
 * Lint staged files using the correct per-package ESLint config.
 * 
 * This script maps file paths to their owning package directory and runs
 * eslint from there so that package-local dependencies (like eslint-config-next)
 * are resolvable.
 * 
 * Usage: node scripts/lint-staged.mjs file1.ts file2.tsx ...
 */

import { execSync } from 'child_process';
import { resolve, dirname, relative } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = resolve(__dirname, '..');

/**
 * Find the nearest directory containing an eslint config file.
 */
function findEslintConfigDir(filePath) {
  let dir = dirname(filePath);
  const configs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.mjs',
    '.eslintrc.cjs',
    '.eslintrc',
    '.eslintrc.json',
  ];

  // Walk up from the file's directory to monorepo root
  while (dir.startsWith(MONOREPO_ROOT) && dir !== MONOREPO_ROOT) {
    for (const cfg of configs) {
      if (existsSync(resolve(dir, cfg))) {
        return dir;
      }
    }
    dir = dirname(dir);
  }

  // Fallback: check the file's own directory relative to monorepo root
  return null;
}

/**
 * Group files by their ESLint config directory.
 */
function groupFilesByConfig(files) {
  const groups = new Map();

  for (const file of files) {
    const absPath = resolve(MONOREPO_ROOT, file);
    const configDir = findEslintConfigDir(absPath);

    if (configDir) {
      if (!groups.has(configDir)) {
        groups.set(configDir, []);
      }
      groups.get(configDir).push(file);
    }
    // Files with no ESLint config are silently skipped
  }

  return groups;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.exit(0);
}

const groups = groupFilesByConfig(files);

let hasError = false;

for (const [configDir, groupFiles] of groups) {
  try {
    const relFiles = groupFiles.map(f => relative(configDir, resolve(MONOREPO_ROOT, f)).replace(/\\/g, '/'));
    execSync(`npx eslint --fix ${relFiles.join(' ')}`, {
      cwd: configDir,
      stdio: 'inherit',
    });
  } catch (err) {
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}
