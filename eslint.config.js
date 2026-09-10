import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', 'coverage/**', '*.tgz', '.verify/**', '.playwright-cli/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Leading-underscore names mark deliberately unused bindings (e.g. a
      // destructured field removed on purpose).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The browser half is a classic script the web shell executes as a client
    // bundle (a lazy CJS factory over `window.__ModuleLoader__`), not a module.
    files: ['src/client.js'],
    languageOptions: {
      globals: { window: 'readonly' },
      sourceType: 'script',
    },
  },
  {
    // Verification scripts are plain Node ESM, not part of the shipped bundle.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
)
