// Build @dsh-external/dsh-mermaid: emit lib/client.js and ensure the vendored
// mermaid chunk is present. No bundler is involved — the client half is already
// in the module-loader factory format the host serves, so "build" is a copy plus
// a size check.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(root, 'src', 'client.js')
const out = path.join(root, 'lib', 'client.js')
const chunk = path.join(root, 'lib', 'client.mermaid.js')
const CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'

fs.mkdirSync(path.join(root, 'lib'), { recursive: true })

const banner = `// GENERATED from src/client.js by build.mjs — edit the source, not this file.\n`
fs.writeFileSync(out, banner + fs.readFileSync(src, 'utf8'))
console.log(`client.js         ${fs.statSync(out).size} bytes`)

if (!fs.existsSync(chunk)) {
  console.log('vendoring mermaid from ' + CDN)
  const res = await fetch(CDN)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  fs.writeFileSync(chunk, Buffer.from(await res.arrayBuffer()))
}
console.log(`client.mermaid.js ${fs.statSync(chunk).size} bytes`)
