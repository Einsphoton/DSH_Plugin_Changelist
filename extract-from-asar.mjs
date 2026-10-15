/**
 * Extract the Cordis framework out of an installed DSH `app.asar` so
 * `integration-test.mjs` can run against the real framework.
 *
 *   node dsh-changelist/extract-from-asar.mjs "<...\resources\app.asar>" ".changelist-test/cordis"
 *
 * Shell tools, node, ripgrep and pnpm cannot read inside `app.asar`; this reads
 * the archive header and copies only the three packages the plugin needs.
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , asarPath, outDir] = process.argv
if (!asarPath || !outDir) {
  console.error('usage: node dsh-changelist/extract-from-asar.mjs "<app.asar>" "<out dir>"')
  process.exit(2)
}
if (!fs.existsSync(asarPath)) {
  console.error(`no app.asar at ${asarPath}`)
  process.exit(2)
}

/** Packages the integration test needs, in archive order. */
const PACKAGES = ['cordis', 'cosmokit', 'schemastery']

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const headBuffer = Buffer.alloc(headerSize)
fs.readSync(fd, headBuffer, 0, headerSize, 8)
const headText = headBuffer.toString('utf8')
const index = JSON.parse(headText.slice(headText.indexOf('{')))
const baseOffset = 8 + headerSize

const entries = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else entries.push({ path: p, offset: entry.offset === undefined ? null : Number(entry.offset), size: entry.size })
  }
}
walk(index, '')

let written = 0
let bytes = 0
for (const entry of entries) {
  const match = /^dsh\/node_modules\/@deepseek-ai\/([^/]+)\//.exec(entry.path)
  if (!match || !PACKAGES.includes(match[1])) continue
  const relative = entry.path.replace(/^dsh\/node_modules\/@deepseek-ai\//, 'node_modules/@deepseek-ai/')
  const target = path.join(outDir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (entry.offset === null || entry.size === 0) {
    fs.writeFileSync(target, Buffer.alloc(0))
    continue
  }
  const buffer = Buffer.alloc(entry.size)
  fs.readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset)
  fs.writeFileSync(target, buffer)
  written++
  bytes += entry.size
}
fs.closeSync(fd)

console.log(`extracted ${written} files (${(bytes / 1048576).toFixed(2)} MB) into ${outDir}`)
console.log(`next: node dsh-changelist/integration-test.mjs "${path.join(outDir, 'node_modules/@deepseek-ai/cordis')}"`)
