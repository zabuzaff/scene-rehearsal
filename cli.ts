import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { verifyPackage } from './src/handoff.ts'

async function locate(root: string) {
  if (process.env.SCENE_REHEARSAL_PORT) return 'http://127.0.0.1:' + process.env.SCENE_REHEARSAL_PORT
  const read = () => { try { return JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { url: string; pid: number } } catch { return undefined } }
  const live = (info?: { pid: number }) => { if (!info) return false; try { process.kill(info.pid, 0); return true } catch { return false } }
  let info = read()
  if (!live(info)) {
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'server.ts')], { detached: true, stdio: 'ignore', env: process.env }).unref()
    for (let i = 0; i < 50 && !(info = read(), live(info)); i++) await new Promise(r => setTimeout(r, 200))
    if (!live(info)) throw Error('Could not start Scene Rehearsal. Run npm start in its checkout.')
  }
  return info!.url
}

const flags = process.argv.slice(2)
const flag = (name: string, value = false) => { const i = flags.indexOf(name); if (i < 0) return undefined; const [, v] = flags.splice(i, value ? 2 : 1); return value ? v ?? (() => { throw Error(name + ' needs a value.') })() : 'yes' }
const specFlags = { unapproved: flag('--unapproved'), expect: flag('--expect', true), out: flag('--out', true) }
const [command, file, digest] = flags
try {
  const root = process.env.SCENE_REHEARSAL_DATA_DIR ?? join(homedir(), 'Library/Application Support/Scene Rehearsal')
  const origin = command === 'verify' ? '' : await locate(root)
  let result
  if (command === 'verify') {
    result = verifyPackage(JSON.parse(readFileSync(file, 'utf8')), new Set([digest]))
  } else {
    if (command === 'spec') {
      if (!file) throw Error('Use spec DRAFT_ID_OR_STORYBOARD/SCENE [--expect CONTENT_DIGEST] [--unapproved] [--out FILE].')
      const query = new URLSearchParams({ scene: file, ...(specFlags.unapproved ? { unapproved: '1' } : {}), ...(specFlags.expect ? { expect: specFlags.expect } : {}) })
      const response = await fetch(origin + '/api/spec?' + query)
      const spec = await response.json()
      if (!response.ok) throw Error(spec.error)
      if (specFlags.out) {
        if (!isAbsolute(specFlags.out)) throw Error('Use an absolute --out path.')
        const pending = specFlags.out + '.' + process.pid + '.tmp'
        writeFileSync(pending, JSON.stringify(spec, null, 2) + '\n', { mode: 0o600 })
        renameSync(pending, specFlags.out)
      }
      result = (specFlags.out ? { written: specFlags.out, contentDigest: spec.source.contentDigest, specDigest: spec.specDigest, ...(spec.check ? { check: spec.check } : {}) } : spec)
      if (spec.check?.stale) process.exitCode = 3
    }
    if (command !== 'spec') {
    const publish = command === 'publish'
    const importing = command === 'import-model'
    const removing = command === 'remove'
    const path = importing ? '/api/agent/assets/import' : publish ? '/api/publish' : removing ? '/api/revision/' + encodeURIComponent(file) + '/remove' : command === 'read' ? '/api/revision/' + encodeURIComponent(file) : '/api/library'
    if (!['publish', 'read', 'list', 'import-model', 'remove'].includes(command)) throw Error('Use list, read DIGEST, remove DIGEST, spec DRAFT, publish FILE, import-model REQUEST, or verify PACKAGE TRUSTED_DIGEST.')
    let body = publish || importing ? readFileSync(file, 'utf8') : removing ? '{}' : undefined
    if (importing) {
      const { bundlePath, meshFoundryDataDir, expected } = JSON.parse(body!)
      body = JSON.stringify({ bundle: JSON.parse(readFileSync(bundlePath, 'utf8')), meshFoundryDataDir, expected })
    }
    const response = await fetch(origin + path, publish || importing || removing ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readFileSync(join(root, 'author.token'), 'utf8') },
      body,
    } : undefined)
    result = await response.json()
    if (!response.ok) throw Error(result.error)
    }
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
