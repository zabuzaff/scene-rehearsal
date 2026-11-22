import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { evaluate, manifestSchema } from '../src/model.ts'
import { verifyPackage } from '../src/handoff.ts'

test('publish, play, review and export a placeholder draft beside a legacy history', { timeout: 15000 }, async () => {
  const spare = createServer().listen(0, '127.0.0.1')
  await once(spare, 'listening')
  const port = (spare.address() as { port: number }).port
  await new Promise<void>(resolve => spare.close(() => resolve()))
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rehearsal-plan-'))
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, SCENE_REHEARSAL_DATA_DIR: root, SCENE_REHEARSAL_PORT: String(port) }
  const service = spawn(process.execPath, ['server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      service.stdout.on('data', data => { if (String(data).includes(origin)) resolve() })
      let errors = ''
      service.stderr.on('data', data => { errors += data })
      service.once('exit', code => reject(Error('Service exited with ' + code + ': ' + errors)))
      service.once('error', reject)
    })
    const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['cli.ts', ...args], { env })).stdout)
    const legacy = await cli('publish', 'fixtures/kairo-office.json')
    const initial = await cli('read', legacy.revision)
    const sample = 'fixtures/lighthouse-arrival.json'
    const published = await cli('publish', sample)
    assert.deepEqual(await cli('publish', sample), published)
    const draft = await cli('read', published.revision)
    const scene = manifestSchema.parse(draft.scene)
    assert.equal(scene.version, 3)
    assert.equal(draft.parent, null)
    assert.deepEqual(draft.approvals, [])
    assert.ok(scene.objects.every(object => !object.asset))
    assert.deepEqual(await cli('read', legacy.revision), initial)
    assert.equal(evaluate(initial.scene, 'interruption', 98).actors[0].activity, 'inspect')
    const list = await cli('list')
    assert.equal(list.head, legacy.revision)
    assert.deepEqual(list.drafts.map(({ key, digest }: { key: string; digest: string }) => ({ key, digest })),
      [{ key: scene.plan.storyboardId + '/' + scene.plan.sceneId, digest: draft.digest }])
    assert.equal(evaluate(scene, 'arrival', 9).trace.length, 0)
    assert.equal(evaluate(scene, 'arrival', 10).activity, 'Cross the landing')
    assert.equal(evaluate(scene, 'arrival', 30).activity, 'Reveal the beacon')
    assert.equal(evaluate(scene, 'arrival', 0).activity, 'Placement preview')
    const { token } = await (await fetch(origin + '/api/session')).json()
    const author = await readFile(join(root, 'author.token'), 'utf8')
    const post = (path: string, body: unknown, credential = token) => fetch(origin + '/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential },
      body: JSON.stringify(body),
    })
    const path = 'revision/' + draft.digest + '/'
    const review = { checked: 'Inspected grouped placement, the traversal cue and beacon framing.' }
    assert.equal((await post(path + 'export', {})).status, 400)
    assert.equal((await post(path + 'approve', { kind: 'final' })).status, 400)
    assert.equal((await post(path + 'approve', { kind: 'final', review }, author)).status, 403)
    assert.ok((await post(path + 'approve', { kind: 'final', review })).ok)
    assert.deepEqual((await cli('read', draft.digest)).draftReview, review)
    assert.equal((await post(path + 'approve', { kind: 'final', review: { checked: 'Overwrite' } })).status, 409)
    const exported = await post(path + 'export', {})
    assert.ok(exported.ok)
    const { digest, package: pkg } = await exported.json()
    assert.deepEqual(verifyPackage(pkg, new Set([digest])), scene)
    assert.deepEqual(pkg.manifest.draftReview, review)
    assert.deepEqual(pkg.blobs, {})

    // An unchanged republish keeps the approval; an edit overwrites the same draft and resets it.
    assert.ok((await post('publish', { request: 'same', scene }, author)).ok)
    assert.equal((await cli('read', draft.digest)).approvals.length, 1)
    const pin = await post(path + 'note', { scenario: scene.scenarios[0].id, tick: 0, text: 'Move the beacon.', object: scene.objects[0].id, camera: [0, 5, 5], target: [0, 0, 0] })
    assert.ok(pin.ok)
    const pinned = (await cli('read', draft.digest)).notes.length
    assert.equal(pinned, 1)
    const edited = { ...scene, intent: scene.intent + ' Revised.' }
    const update = await post('publish', { request: 'edit', scene: edited }, author)
    assert.ok(update.ok)
    assert.deepEqual(await update.json(), { revision: draft.digest })
    assert.equal((await cli('read', draft.digest)).draftRev, 2)
    const after = await cli('read', draft.digest)
    assert.equal(after.scene.intent, edited.intent)
    assert.deepEqual(after.approvals, [])
    assert.equal(after.notes.length, pinned)
    assert.equal(after.draftReview, undefined)
    assert.equal((await cli('list')).drafts.length, 1)
    assert.ok((await post(path + 'approve', { kind: 'final', review })).ok)
    assert.deepEqual(await cli('publish', sample), published)
    // Old history can be removed, a scene's live draft cannot.
    assert.equal((await post('revision/' + draft.digest + '/remove', {}, author)).status, 409)
    assert.equal((await post('revision/' + legacy.revision + '/remove', {}, token)).status, 403)
    assert.deepEqual(await cli('remove', legacy.revision), { removed: legacy.revision })
    assert.equal((await cli('list')).head, undefined)
    assert.ok((await cli('read', draft.digest)).notes.length === 1)
    // A different scene gets its own draft; plan fields are optional.
    const other = { ...scene, plan: { storyboardId: scene.plan.storyboardId, sceneId: 'other-scene' } }
    const second = await post('publish', { request: 'other', scene: other }, author)
    assert.ok(second.ok)
    assert.equal((await cli('list')).drafts.length, 2)
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit')
      service.kill()
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
