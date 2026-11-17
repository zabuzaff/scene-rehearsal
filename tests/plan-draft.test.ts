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
    assert.deepEqual(list.planHeads, [{ plan: scene.plan, digest: draft.digest }])
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
    assert.equal((await post('publish', { request: 'wrong-root', parent: legacy.revision, scene }, author)).status, 409)
    assert.equal((await post('publish', { request: 'duplicate-root', parent: null, scene }, author)).status, 409)
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

    const child = await post('publish', { request: 'child', parent: draft.digest, scene }, author)
    assert.ok(child.ok)
    const { revision } = await child.json()
    assert.deepEqual((await cli('read', revision)).approvals, [])
    assert.deepEqual(await cli('publish', sample), published)
    const nextPlan = { ...scene.plan, planRevision: 3, approvalId: 'fictional-owner-approval-2' }
    const nextDraft = await post('publish', { request: 'next-plan', parent: null, scene: { ...scene, plan: nextPlan } }, author)
    assert.ok(nextDraft.ok)
    const { revision: nextDigest } = await nextDraft.json()
    assert.deepEqual(await cli('list').then(({ head, planHeads }) => ({ head, planHeads })), {
      head: legacy.revision,
      planHeads: [{ plan: scene.plan, digest: revision }, { plan: nextPlan, digest: nextDigest }],
    })
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit')
      service.kill()
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
