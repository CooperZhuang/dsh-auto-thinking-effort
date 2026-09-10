/**
 * Publish the browser half as this package's client bundle.
 *
 * `src/client.js` is already written in the client module system's own format
 * (a classic script registering one lazy CJS factory), so there is nothing to
 * compile — but the Host serves the *built* artifact and fails activation
 * loudly when a declared client bundle is missing, so the file has to reach
 * `lib/` on every build. Validating the two things the shell depends on (the
 * registration id equals the package name, and the file really is a bundle)
 * turns a silent "no card in the GUI" into a build failure.
 *
 * @module dsh-auto-thinking-effort/build-client
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'src/client.js')
const target = resolve(root, 'lib/client.js')
const { name } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const text = readFileSync(source, 'utf8')
if (!text.includes('__ModuleLoader__')) {
  throw new Error('src/client.js is not a client bundle: it never touches window.__ModuleLoader__')
}
if (!text.includes(`'${name}'`) && !text.includes(`"${name}"`)) {
  throw new Error(`src/client.js never names the package (${name}), so its bundle id cannot be right`)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, text)
console.log(`client bundle: lib/client.js (${String(text.length)} bytes, id ${name})`)
