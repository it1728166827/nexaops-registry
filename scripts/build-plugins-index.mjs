#!/usr/bin/env node
// Build plugins-index.json from the on-disk plugins/ tree.
//
// Walks plugins/<name>/plugin.toml, extracts the fields the LibreFang
// daemon actually consumes (name, version?, description?, needs?), sorts
// the result by name for byte-determinism, and writes it to the repo
// root. The committed file is what the registry-worker forced-refresh
// path signs — keeping the worker's input to a single subrequest
// regardless of how large the registry grows.
//
// Run by .github/workflows/refresh-cache.yml on every push under
// plugins/**, and committed back via github-actions[bot].

import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..')
const pluginsDir = path.join(repoRoot, 'plugins')
const outPath = path.join(repoRoot, 'plugins-index.json')

function pickString(text, key) {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
  return m ? m[1] : ''
}

function pickStringArray(text, key) {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))
  if (!m) return undefined
  const items = m[1].match(/"([^"]*)"/g)?.map(s => s.replace(/"/g, ''))
  return items?.length ? items : undefined
}

const entries = []
for (const dir of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const manifest = path.join(pluginsDir, dir.name, 'plugin.toml')
  if (!fs.existsSync(manifest)) continue
  const text = fs.readFileSync(manifest, 'utf8')

  const name = pickString(text, 'name')
  if (!name) continue

  const out = { name }
  const version = pickString(text, 'version')
  if (version) out.version = version
  const description = pickString(text, 'description')
  if (description) out.description = description
  const needs = pickStringArray(text, 'needs')
  if (needs?.length) out.needs = needs
  entries.push(out)
}

entries.sort((a, b) => a.name.localeCompare(b.name))

const json = JSON.stringify(entries)
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null
if (prev === json) {
  console.log(`plugins-index.json unchanged (${entries.length} entries)`)
  process.exit(0)
}
fs.writeFileSync(outPath, json)
console.log(`plugins-index.json updated: ${entries.length} entries`)
