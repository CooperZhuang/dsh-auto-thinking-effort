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
    // Verification scripts are plain Node ESM, not part of the shipped bundle.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
)
