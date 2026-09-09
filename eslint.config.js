import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', 'coverage/**', '*.tgz'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Verification scripts are plain Node ESM, not part of the shipped bundle.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
)
