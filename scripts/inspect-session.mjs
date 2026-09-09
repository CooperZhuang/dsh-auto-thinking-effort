/**
 * Inspect one persisted DSH session log.
 *
 * Verification helper, not part of the plugin. `~/.dsh/sessions/<slug>/session-<id>/
 * session.jsonl.zstd` is a *concatenated* zstd stream — one independently
 * decodable frame per header/batch flush — so `zstdDecompressSync` on the whole
 * file reads only the first frame and silently hides every event. This walks
 * the frame headers (the same way dsh-session-persistence-jsonl does), decodes
 * each frame, and prints the events that prove what each model request carried.
 *
 * Usage:
 *   node scripts/inspect-session.mjs <session-dir-or-jsonl.zstd> [--all] [--grep <regex>]
 *
 * Default output: turn/request/user/assistant events. `--all` prints every
 * event; `--grep` keeps only events whose JSON matches.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little-endian. */
const ZSTD_MAGIC = 0xFD2FB528

/**
 * Locate complete zstd frames without decompressing their blocks.
 * @param buffer - the whole file.
 * @returns one byte range per complete frame.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${String(offset)}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/** Resolve the argument to one session log file. */
function resolveLog(target) {
  if (statSync(target).isFile()) return target
  const entry = readdirSync(target).find((name) => name.startsWith('session.jsonl'))
  if (entry === undefined) throw new Error(`no session.jsonl* in ${target}`)
  return join(target, entry)
}

/** Decode a session artifact (multi-frame zstd or plain JSONL) to text. */
function readText(file) {
  const buffer = readFileSync(file)
  if (!file.endsWith('.zstd')) return buffer.toString('utf8')
  return scanFrames(buffer).map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')).join('')
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/inspect-session.mjs <session-dir-or-jsonl.zstd> [--all] [--grep <regex>]')
  process.exit(2)
}
const showAll = process.argv.includes('--all')
const grepIndex = process.argv.indexOf('--grep')
const filter = grepIndex < 0 ? undefined : new RegExp(process.argv[grepIndex + 1] ?? '')

const events = readText(resolveLog(target)).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
console.log(`# ${String(events.length)} events`)
for (const event of events) {
  const type = String(event.type ?? '')
  const json = JSON.stringify(event)
  if (filter !== undefined && !filter.test(json)) continue
  if (filter === undefined && !showAll && !/request\/header|request\/context|turn\/start|user\/message|assistant\/message/.test(type)) continue
  console.log(`\n[${type}]`)
  console.log(json.slice(0, 2_000))
}
