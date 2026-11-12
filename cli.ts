import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { verifyPackage } from './src/handoff.ts'

const [command, file, digest] = process.argv.slice(2)
try {
  const root = process.env.SCENE_REHEARSAL_DATA_DIR ?? join(homedir(), 'Library/Application Support/Scene Rehearsal')
  const origin = 'http://127.0.0.1:' + (process.env.SCENE_REHEARSAL_PORT ?? '4331')
  let result
  if (command === 'verify') {
    result = verifyPackage(JSON.parse(readFileSync(file, 'utf8')), new Set([digest]))
  } else {
    const publish = command === 'publish'
    const path = publish ? '/api/publish' : command === 'read' ? '/api/revision/' + encodeURIComponent(file) : '/api/library'
    if (!['publish', 'read', 'list'].includes(command)) throw Error('Use list, read DIGEST, publish FILE, or verify PACKAGE TRUSTED_DIGEST.')
    const response = await fetch(origin + path, publish ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readFileSync(join(root, 'author.token'), 'utf8') },
      body: readFileSync(file, 'utf8'),
    } : undefined)
    result = await response.json()
    if (!response.ok) throw Error(result.error)
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
