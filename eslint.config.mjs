// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-package/**',
      '.tsbuildcache/**',
      'native/*/build/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything typechecked against the project graph in tsconfig.json
    // (src/shared, src/main, src/preload, src/renderer, resources, tests).
    files: ['src/**/*.ts', 'src/**/*.tsx', 'resources/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // No `any` outside .d.ts files — see override below.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'resources/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Root tooling: build/dev scripts, and standalone config files that are
    // deliberately not part of the tsconfig.json project graph (they
    // configure the tools that read that graph, not code inside it) —
    // plain JS lint only, no type-aware rules.
    files: ['scripts/**/*.mjs', '*.config.ts', '*.config.js', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
  },
  {
    // The native addon's JS glue (build output require + hand-written
    // .d.ts) — no tsconfig backs this small package, so no type-aware
    // linting here either.
    files: ['native/**/*.js', 'native/**/*.d.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
    rules: {
      // The addon's whole JS surface is `module.exports = require(<native binding>)`
      // — the standard, correct way to load a compiled .node file.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier,
);
