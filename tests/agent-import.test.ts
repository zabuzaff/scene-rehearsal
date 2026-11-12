import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash } from '../src/handoff.ts'

function triangleGLB() {
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }
  const json = JSON.stringify(document)
  const padded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4))
  const bytes = Buffer.alloc(28 + padded.length + 36)
  bytes.write('glTF')
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(padded.length, 12)
  bytes.write('JSON', 16)
  padded.copy(bytes, 20)
  bytes.writeUInt32LE(36, 20 + padded.length)
  bytes.write('BIN\0', 24 + padded.length)
  bytes.writeFloatLE(1, 40 + padded.length)
  bytes.writeFloatLE(1, 56 + padded.length)
  return bytes
}

test('agent import checks credentials, library, clips and live acceptance before storing bytes', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rehearsal-import-'))
  const bytes = triangleGLB()
  const digest = hash(bytes)
  const expected = { project: 'test', asset: 'prop', revision: 'r1', hash: digest, clips: [] }
  const model = { id: 'r1', assetId: 'prop', stage: 'model', files: [{ kind: 'model', hash: digest }] }
  const project = { schemaVersion: 1, id: 'test', accepted: { prop: 'r1' }, revisions: [model, { ...model, id: 'r2' }] }
  const bundle = { format: 'mesh-foundry-1', project, blobs: { [digest]: bytes.toString('base64') } }
  let live = 'r2'
  const foundry = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/session' ? { dataRoot: root } : { ...project, accepted: { prop: live } }))
  }).listen(0, '127.0.0.1')
  await once(foundry, 'listening')
  const spare = createServer().listen(0, '127.0.0.1')
  await once(spare, 'listening')
  const port = (spare.address() as {port: number}).port
  await new Promise<void>(resolve => spare.close(() => resolve()))
  const app = spawn(process.execPath, ['server.ts'], {
    env: { ...process.env, SCENE_REHEARSAL_DATA_DIR: root, SCENE_REHEARSAL_PORT: String(port),
      SCENE_REHEARSAL_MESH_FOUNDRY_PORT: String((foundry.address() as {port: number}).port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  app.stdout.on('data', data => { log += data })
  app.stderr.on('data', data => { log += data })
  try {
    for (let i = 0; i < 100 && !log.includes('Scene Rehearsal at') && app.exitCode === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.match(log, /Scene Rehearsal at/)
    const authorization = 'Bearer ' + await readFile(join(root, 'author.token'), 'utf8')
    const origin = 'http://127.0.0.1:' + port
    const body = { bundle, meshFoundryDataDir: root, expected }
    const post = (path: string, body: unknown, credential: string | false = authorization) => fetch(origin + '/api/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...(credential ? { authorization: credential } : {}) },
      body: JSON.stringify(body),
    })
    assert.equal((await post('agent/assets/import', body, false)).status, 403)
    assert.equal((await post('agent/assets/import', { ...body, expected: { ...expected, clips: ['wrong'] } })).status, 409)
    assert.equal((await post('agent/assets/import', { ...body, meshFoundryDataDir: tmpdir() })).status, 409)
    assert.equal((await post('agent/assets/import', body)).status, 409)
    assert.deepEqual(await readdir(join(root, 'blobs')), [])
    assert.equal((await fetch(origin + '/api/assets/' + digest)).status, 404)
    live = 'r1'
    assert.equal((await post('agent/assets/import', body)).status, 200)
    assert.equal((await fetch(origin + '/api/assets/' + digest)).status, 200)
    assert.deepEqual(await (await fetch(origin + '/api/library')).json(), { revisions: [] })
    const draft = JSON.parse(await readFile(new URL('../fixtures/kairo-office.json', import.meta.url), 'utf8'))
    const published = await post('publish', draft)
    assert.equal(published.status, 200)
    const { revision: head } = await published.json()
    assert.equal((await post('revision/' + head + '/approve', { kind: 'final' })).status, 403)
    assert.equal((await post('revision/' + head + '/export', {})).status, 403)
    const approve = 'revision/' + head + '/approve'
    assert.equal((await post(approve, { kind: 'blockout' }, false)).status, 403)
    assert.equal((await fetch(origin + '/api/session', { headers: { origin: 'https://example.com' } })).status, 403)
    const session = await fetch(origin + '/api/session')
    assert.equal(session.headers.get('cache-control'), 'no-store')
    const { token } = await session.json()
    assert.equal((await post('publish', draft, 'Bearer ' + token)).status, 403)
    assert.equal((await post(approve, { kind: 'blockout' }, 'Bearer ' + token)).status, 200)
  } finally {
    if (app.exitCode === null) {
      const exited = once(app, 'exit')
      app.kill()
      await exited
    }
    await new Promise<void>(resolve => foundry.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
