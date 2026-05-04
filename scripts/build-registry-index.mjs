#!/usr/bin/env node
// Build registry-index.json from the on-disk content tree.
//
// Mirrors the dict-shaped payload the registry-worker's
// `refreshRegistryCache` would produce by walking the GitHub Contents API
// — but does it from the checked-out repo, so the worker's forced-refresh
// path stays at a single subrequest regardless of registry size.
//
// Output shape (consumed by dashboard via /api/registry):
//   {
//     hands:[{id,name,description,category,icon,tags?,i18n?}, ...],
//     channels:[...], providers:[...], workflows:[...], agents:[...],
//     plugins:[...], skills:[...], mcp:[...],
//     handsCount: ..., ..., pluginsCount: ..., skillsCount: ...,
//     fetchedAt: <ISO>,
//     signature: <directory-signature>,    // for cron-skip parity
//   }

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..')
const outPath = path.join(repoRoot, 'registry-index.json')

// Layouts: directory-with-manifest categories use `<name>/<manifest>`;
// flat-file categories list `*.toml` directly. mcp tolerates both
// (matches the existing worker `m.name.endsWith('.toml') ? mcp/<name> :
// mcp/<name>/MCP.toml`).
const DIR_MANIFEST = {
  hands: 'HAND.toml',
  agents: 'agent.toml',
  plugins: 'plugin.toml',
}
const SKILL_DIR = 'SKILL.md'
const FLAT_TOML = ['channels', 'providers', 'workflows']

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

function parseI18n(text) {
  const i18n = {}
  const re = /\[i18n\.([a-zA-Z-]+)\]\s*\n([^[]*?)(?=\n\[|\n*$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const descM = (m[2] || '').match(/description\s*=\s*"([^"]*)"/)
    if (descM) i18n[m[1]] = { description: descM[1] }
  }
  return i18n
}

function parseToml(text, fallbackId) {
  const out = {
    id: pickString(text, 'id') || fallbackId,
    name: pickString(text, 'name') || fallbackId,
    description: pickString(text, 'description'),
    category: pickString(text, 'category'),
    icon: pickString(text, 'icon'),
  }
  const version = pickString(text, 'version')
  if (version) out.version = version
  const tags = pickStringArray(text, 'tags')
  if (tags?.length) out.tags = tags
  const needs = pickStringArray(text, 'needs')
  if (needs?.length) out.needs = needs
  const i18n = parseI18n(text)
  if (Object.keys(i18n).length) out.i18n = i18n
  return out
}

function parseSkillMd(text, fallbackId) {
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return null
  const get = key => {
    const m = fm[1].match(new RegExp(`^${key}\\s*:\\s*"?([^"\\n]*?)"?\\s*$`, 'm'))
    return m ? m[1].trim() : ''
  }
  return {
    id: get('id') || fallbackId,
    name: get('name') || fallbackId,
    description: get('description'),
    category: 'skills',
    icon: '',
  }
}

function loadDirCategory(category, manifest) {
  const dir = path.join(repoRoot, category)
  if (!fs.existsSync(dir)) return { items: [], rawNames: [] }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'README.md')
    .sort((a, b) => a.name.localeCompare(b.name))

  const items = []
  for (const e of entries) {
    const f = path.join(dir, e.name, manifest)
    if (!fs.existsSync(f)) continue
    items.push(parseToml(fs.readFileSync(f, 'utf8'), e.name))
  }
  return { items, rawNames: entries.map(e => e.name) }
}

function loadFlatTomlCategory(category) {
  const dir = path.join(repoRoot, category)
  if (!fs.existsSync(dir)) return { items: [], rawNames: [] }
  const files = fs
    .readdirSync(dir)
    .filter(n => n.endsWith('.toml') && n !== 'README.md')
    .sort((a, b) => a.localeCompare(b))

  const items = []
  for (const f of files) {
    const id = f.replace(/\.toml$/, '')
    items.push(parseToml(fs.readFileSync(path.join(dir, f), 'utf8'), id))
  }
  return { items, rawNames: files }
}

function loadSkills() {
  const dir = path.join(repoRoot, 'skills')
  if (!fs.existsSync(dir)) return { items: [], rawNames: [] }
  const dirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  const items = []
  for (const d of dirs) {
    const f = path.join(dir, d.name, SKILL_DIR)
    if (!fs.existsSync(f)) continue
    const parsed = parseSkillMd(fs.readFileSync(f, 'utf8'), d.name)
    if (parsed) items.push(parsed)
  }
  return { items, rawNames: dirs.map(d => d.name) }
}

function loadMcp() {
  const dir = path.join(repoRoot, 'mcp')
  if (!fs.existsSync(dir)) return { items: [], rawNames: [] }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.name !== 'README.md')
    .sort((a, b) => a.name.localeCompare(b.name))

  const items = []
  const rawNames = []
  for (const e of entries) {
    let manifest
    let id
    if (e.isFile() && e.name.endsWith('.toml')) {
      manifest = path.join(dir, e.name)
      id = e.name.replace(/\.toml$/, '')
    } else if (e.isDirectory()) {
      manifest = path.join(dir, e.name, 'MCP.toml')
      id = e.name
      if (!fs.existsSync(manifest)) continue
    } else {
      continue
    }
    items.push(parseToml(fs.readFileSync(manifest, 'utf8'), id))
    rawNames.push(e.name)
  }
  return { items, rawNames }
}

const hands = loadDirCategory('hands', DIR_MANIFEST.hands)
const agents = loadDirCategory('agents', DIR_MANIFEST.agents)
const plugins = loadDirCategory('plugins', DIR_MANIFEST.plugins)
const skills = loadSkills()
const channels = loadFlatTomlCategory('channels')
const providers = loadFlatTomlCategory('providers')
const workflows = loadFlatTomlCategory('workflows')
const mcp = loadMcp()

// Signature mirrors the worker's per-category `name@sha`-style join, but
// keyed off the file content hash so the registry-worker cron can detect
// "no real change" identically to its current GitHub-Contents-API path.
function categorySig(category, rawNames) {
  return rawNames
    .map(n => {
      const p = path.join(repoRoot, category, n)
      let bytes = ''
      if (fs.existsSync(p)) {
        if (fs.statSync(p).isDirectory()) {
          // hash the directory's manifest for the signature
          for (const m of ['HAND.toml', 'agent.toml', 'plugin.toml', 'SKILL.md', 'MCP.toml']) {
            const inner = path.join(p, m)
            if (fs.existsSync(inner)) {
              bytes = fs.readFileSync(inner, 'utf8')
              break
            }
          }
        } else {
          bytes = fs.readFileSync(p, 'utf8')
        }
      }
      const sha = crypto.createHash('sha1').update(bytes).digest('hex')
      return `${n}@${sha}`
    })
    .join(',')
}

const signature = [
  'hands', 'channels', 'providers', 'workflows',
  'agents', 'plugins', 'skills', 'mcp',
]
  .map((c, _) => {
    const raw = ({ hands, channels, providers, workflows, agents, plugins, skills, mcp }[c]).rawNames
    return `${c}=${categorySig(c, raw)}`
  })
  .join('|')

const result = {
  hands: hands.items,
  channels: channels.items,
  providers: providers.items,
  workflows: workflows.items,
  agents: agents.items,
  plugins: plugins.items,
  skills: skills.items,
  mcp: mcp.items,
  handsCount: hands.rawNames.length,
  channelsCount: channels.rawNames.length,
  providersCount: providers.rawNames.length,
  workflowsCount: workflows.rawNames.length,
  agentsCount: agents.rawNames.length,
  pluginsCount: plugins.rawNames.length,
  skillsCount: skills.rawNames.length,
  mcpCount: mcp.rawNames.length,
  // fetchedAt intentionally OMITTED — including a wall-clock timestamp
  // here would make every CI run produce a diff and an empty commit
  // even when the registry hasn't changed. The worker stamps an
  // updated_at into D1 when it ingests the file, which is what
  // dashboards should display anyway.
  signature,
}

const json = JSON.stringify(result)
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null
if (prev === json) {
  console.log(
    `registry-index.json unchanged (${plugins.rawNames.length} plugins, ` +
    `${hands.rawNames.length} hands, ${agents.rawNames.length} agents, ` +
    `${skills.rawNames.length} skills, ${channels.rawNames.length} channels, ` +
    `${providers.rawNames.length} providers, ${workflows.rawNames.length} workflows, ` +
    `${mcp.rawNames.length} mcp)`,
  )
  process.exit(0)
}
fs.writeFileSync(outPath, json)
console.log(
  `registry-index.json updated: ${plugins.rawNames.length}p ${hands.rawNames.length}h ` +
  `${agents.rawNames.length}a ${skills.rawNames.length}s ${channels.rawNames.length}c ` +
  `${providers.rawNames.length}pr ${workflows.rawNames.length}w ${mcp.rawNames.length}mcp`,
)
