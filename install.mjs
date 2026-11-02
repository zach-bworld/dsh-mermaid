// Install @dsh-external/dsh-mermaid into a DSH profile:
//   node install.mjs <profile> [--uninstall]
// Copies the package into the profile's node_modules, records it in the profile
// package.json (dependency + profile bundle), and reports the composed result.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@dsh-external/dsh-mermaid'
const root = path.dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const profile = process.argv[2]
const uninstall = process.argv.includes('--uninstall')
if (!profile) {
  console.error('usage: node install.mjs <profile> [--uninstall]')
  process.exit(2)
}

const profileDir = path.join(home, 'profiles', profile)
const manifestPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`no such profile: ${profileDir}`)
  process.exit(2)
}

// PowerShell-written profile manifests may carry a BOM.
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const target = path.join(profileDir, 'node_modules', ...PKG.split('/'))
// Relative spec so a later `pnpm install` in the profile reproduces this install
// from the canonical source instead of pruning it.
const spec = 'file:' + path.relative(profileDir, root).split(path.sep).join('/')

if (uninstall) {
  fs.rmSync(target, { recursive: true, force: true })
  delete manifest.dependencies?.[PKG]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== PKG)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`uninstalled ${PKG} from profile "${profile}"`)
  process.exit(0)
}

// Copy the shipped files only; the vendored chunk is large but required.
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
for (const entry of ['package.json', 'cordis.patch.yml', 'README.md']) {
  if (fs.existsSync(path.join(root, entry))) fs.copyFileSync(path.join(root, entry), path.join(target, entry))
}
fs.cpSync(path.join(root, 'lib'), path.join(target, 'lib'), { recursive: true })
fs.cpSync(path.join(root, 'src'), path.join(target, 'src'), { recursive: true })

manifest.dependencies ??= {}
manifest.dependencies[PKG] = spec
if (!manifest.dsh.profile.bundles.includes(PKG)) manifest.dsh.profile.bundles.push(PKG)
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const installed = path.join(target, 'lib', 'client.js')
console.log(`installed ${PKG} -> ${target}`)
console.log(`  lib/client.js         ${fs.statSync(installed).size} bytes`)
console.log(`  lib/client.mermaid.js ${fs.statSync(path.join(target, 'lib', 'client.mermaid.js')).size} bytes`)
console.log(`  profile bundles:      ${manifest.dsh.profile.bundles.join(', ')}`)
console.log('Restart the profile for the host to compose the new bundle.')
