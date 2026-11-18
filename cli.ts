import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
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

const [command, file, digest] = process.argv.slice(2)
try {
  const root = process.env.SCENE_REHEARSAL_DATA_DIR ?? join(homedir(), 'Library/Application Support/Scene Rehearsal')
  const origin = command === 'verify' ? '' : await locate(root)
  let result
  if (command === 'verify') {
    result = verifyPackage(JSON.parse(readFileSync(file, 'utf8')), new Set([digest]))
  } else {
    const publish = command === 'publish'
    const importing = command === 'import-model'
    const path = importing ? '/api/agent/assets/import' : publish ? '/api/publish' : command === 'read' ? '/api/revision/' + encodeURIComponent(file) : '/api/library'
    if (!['publish', 'read', 'list', 'import-model'].includes(command)) throw Error('Use list, read DIGEST, publish FILE, import-model REQUEST, or verify PACKAGE TRUSTED_DIGEST.')
    let body = publish || importing ? readFileSync(file, 'utf8') : undefined
    if (importing) {
      const { bundlePath, meshFoundryDataDir, expected } = JSON.parse(body!)
      body = JSON.stringify({ bundle: JSON.parse(readFileSync(bundlePath, 'utf8')), meshFoundryDataDir, expected })
    }
    const response = await fetch(origin + path, publish || importing ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readFileSync(join(root, 'author.token'), 'utf8') },
      body,
    } : undefined)
    result = await response.json()
    if (!response.ok) throw Error(result.error)
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
