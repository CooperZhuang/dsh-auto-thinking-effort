/**
 * tsdown build for dsh-auto-thinking-effort.
 *
 * Host-half only: the plugin contributes no browser bundle. lib/index.js is a
 * plain ESM Node bundle whose only externals are the DSH/cordis peers the
 * profile composition already provides (bundling them would duplicate the
 * service registry).
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown, so
 * the declaration surface stays a straight projection of src/.
 */
import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: false,
  sourcemap: false,
  /** DSH resolves `lib/index.js` through the package exports, not `.mjs`. */
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/] },
} satisfies UserConfig
