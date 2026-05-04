#!/usr/bin/env node
// Sign plugins-index.json with the registry's Ed25519 private key and
// commit the .sig alongside the JSON. Pair with build-plugins-index.mjs
// (which produces the bytes) — this script's only job is to attach a
// detached signature.
//
// Run by .github/workflows/refresh-cache.yml. Reads the PKCS#8-base64
// private key from the REGISTRY_PRIVATE_KEY env var (set as a GitHub
// Actions repo secret); aborts loudly if the secret is missing or
// malformed so a misconfigured CI run can't silently ship an unsigned
// index.
//
// PR #4600 review CRITICAL #1: signing now happens here, not in the
// Cloudflare worker. The worker never holds the private key — it just
// transports the bytes + signature this script produces. That ties the
// trust root to the registry repo's branch protection + Actions secret
// scope, instead of the worker being a sign-anything oracle reachable
// via REGISTRY_REFRESH_TOKEN.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..')
const indexPath = path.join(repoRoot, 'plugins-index.json')
const sigPath = path.join(repoRoot, 'plugins-index.json.sig')

const pkcs8B64 = (process.env.REGISTRY_PRIVATE_KEY || '').trim()
if (!pkcs8B64) {
  console.error(
    'REGISTRY_PRIVATE_KEY is not set — refusing to ship unsigned index. ' +
    'Add the PKCS#8-base64 Ed25519 private key as a GitHub Actions secret ' +
    'on this repo (gh secret set REGISTRY_PRIVATE_KEY).',
  )
  process.exit(1)
}
if (!fs.existsSync(indexPath)) {
  console.error(
    `plugins-index.json missing at ${indexPath} — run scripts/build-plugins-index.mjs first.`,
  )
  process.exit(1)
}

const pkcs8Der = Buffer.from(pkcs8B64.replace(/\s+/g, ''), 'base64')
let key
try {
  key = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' })
} catch (e) {
  console.error(`REGISTRY_PRIVATE_KEY is not a valid PKCS#8-DER Ed25519 key: ${e.message}`)
  process.exit(1)
}
if (key.asymmetricKeyType !== 'ed25519') {
  console.error(
    `REGISTRY_PRIVATE_KEY is a ${key.asymmetricKeyType} key — must be ed25519`,
  )
  process.exit(1)
}

const indexBytes = fs.readFileSync(indexPath)
const sigBytes = crypto.sign(null, indexBytes, key)
const sigB64 = sigBytes.toString('base64')

const prev = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf8').trim() : null
if (prev === sigB64) {
  console.log(`plugins-index.json.sig unchanged (${sigBytes.length} bytes)`)
  process.exit(0)
}
fs.writeFileSync(sigPath, sigB64 + '\n')
console.log(
  `plugins-index.json.sig written: ${sigBytes.length} bytes signature ` +
  `over ${indexBytes.length} bytes of index`,
)
