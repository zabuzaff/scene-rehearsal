import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { canonical, hash } from '../src/handoff.ts'
import { manifestSchema } from '../src/model.ts'
import { buildAssetSpec, contentDigest, specSchema } from '../src/spec.ts'

const draft = () => {
  const scene = manifestSchema.parse({
    version: 3, title: 'Gate yard', unit: 'meter', up: 'Y', duration: 100,
    plan: { storyboardId: 'yard', sceneId: 'gate' }, intent: 'Walk through the gate.', pendingChecks: [],
    scaleReference: { asset: 'baseline-character', label: 'Baseline character', height: 1.75 },
    objects: [
      { id: 'floor', label: 'Floor', kind: 'box', position: [0, -.1, 0], size: [10, .2, 10], scale: [1, 1, 1], rotation: [0, 0, 0], build: { walkable: true } },
      { id: 'gate', label: 'Gate', kind: 'box', position: [0, 1, -2], size: [1, 2, .2], scale: [2, 1, 1], rotation: [0, 0, 0],
        build: { notes: 'Opens inward.', clearance: [{ id: 'passage', label: 'Door passage', size: [1.2, 2.1, 1], offset: [0, 0, .5] }] } },
      { id: 'crate', label: 'Crate', kind: 'box', position: [3, .5, 1], size: [1, 1, 1], scale: [1, 1, 1], rotation: [0, Math.PI / 2, 0] },
      { id: 'barrel', label: 'Barrel', kind: 'box', position: [0, .5, 1], size: [.6, 1, .6], scale: [1, 1, 1], rotation: [0, 0, 0] },
    ],
    scenarios: [{ id: 'main', label: 'Main', events: [
      { id: 'walk', tick: 10, label: 'Walk to gate', intent: 'Player walks to the gate.', route: [[0, .05, 4], [0, .05, -1.6]], targets: [{ object: 'gate' }] },
      { id: 'open', tick: 40, label: 'Gate opens', intent: 'The gate swings open.', targets: [{ object: 'gate', clip: 'open' }, { object: 'gate', clip: 'open' }] },
    ] }],
  })
  assert.equal(scene.version, 3)
  return scene as Extract<typeof scene, { version: 3 }>
}
const spec = (scene = draft(), approvedAt: string | null = '2026-11-22T00:00:00.000Z') =>
  buildAssetSpec({ draftId: 'a'.repeat(64), draftRev: 3, scene, approvedAt, reviewChecked: approvedAt ? 'Checked.' : null })
const piece = (s: ReturnType<typeof spec>, id: string) => s.pieces.find(p => p.id === id)!

test('the spec reports real dimensions, pivot, interaction, clips and scale reference', () => {
  const s = spec()
  assert.deepEqual(specSchema.parse(s), s)
  assert.deepEqual(piece(s, 'gate').dimensions, [2, 2, .2])
  assert.deepEqual(piece(s, 'gate').pivot, { anchor: 'base-center', position: [0, 0, -2] })
  assert.equal(piece(s, 'gate').interactive, true)
  assert.deepEqual(piece(s, 'gate').animationClips, ['open'])
  assert.equal(piece(s, 'crate').interactive, false)
  assert.deepEqual(s.scaleReference, { asset: 'baseline-character', label: 'Baseline character', height: 1.75 })
  assert.ok(piece(s, 'gate').placementNotes.includes('Opens inward.'))
  const { specDigest, ...body } = s
  assert.equal(specDigest, hash(canonical(body)))
})

test('clearance includes authored passages and walk routes, and flags placeholder intersections', () => {
  const s = spec()
  const gate = piece(s, 'gate').clearance
  assert.deepEqual(gate.find(c => c.kind === 'authored'), { id: 'passage', label: 'Door passage', kind: 'authored', center: [0, 1, -1.5], size: [1.2, 2.1, 1], rotationEuler: [0, 0, 0], intersectsPlaceholder: false })
  const route = gate.find(c => c.kind === 'route')!
  assert.deepEqual(route.size, [6.6, 1.8, 1])
  assert.equal(route.cue?.event, 'walk')
  assert.equal(route.intersectsPlaceholder, true)
  assert.ok(s.warnings.some(w => w.startsWith('gate intersects')))
  // The barrel sits in the lane; the walkable floor and the far crate do not get route clearance.
  assert.equal(piece(s, 'barrel').clearance.find(c => c.kind === 'route')?.intersectsPlaceholder, true)
  assert.equal(piece(s, 'floor').clearance.length, 0)
  assert.equal(piece(s, 'crate').clearance.length, 0)
})

test('rotation, anchor and digest follow the draft content', () => {
  const scene = draft()
  const tilted = { ...scene, objects: scene.objects.map(o => o.id === 'crate' ? { ...o, rotation: [0, 0, 0] as [number, number, number], build: { anchor: 'center' as const } } : o) }
  assert.deepEqual(piece(spec(tilted), 'crate').pivot, { anchor: 'center', position: [3, .5, 1] })
  const edited = { ...scene, intent: 'Changed.' }
  assert.notEqual(contentDigest(edited), contentDigest(scene))
  assert.equal(spec(scene).source.contentDigest, contentDigest(scene))
  assert.equal(spec(scene).source.approved, true)
  assert.equal(spec(scene, null).source.approved, false)
  assert.notEqual(spec(edited).specDigest, spec(scene).specDigest)
  assert.throws(() => manifestSchema.parse({ ...scene, scenarios: [{ ...scene.scenarios[0], events: [{ id: 'x', tick: 1, label: 'x', intent: 'x', targets: [{ object: 'missing' }] }] }] }))
})

async function freePort() {
  const spare = createServer().listen(0, '127.0.0.1')
  await once(spare, 'listening')
  const port = (spare.address() as { port: number }).port
  await new Promise<void>(resolve => spare.close(() => resolve()))
  return port
}

test('the service serves the spec, detects staleness, and refuses a second instance', { timeout: 20000 }, async () => {
  const port = await freePort()
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rehearsal-spec-'))
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, SCENE_REHEARSAL_DATA_DIR: root, SCENE_REHEARSAL_PORT: String(port) }
  const service = spawn(process.execPath, ['server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      service.stdout.on('data', data => { if (String(data).includes(origin)) resolve() })
      service.once('exit', code => reject(Error('Service exited with ' + code)))
    })
    const run = (args: string[], file = 'cli.ts') => promisify(execFile)(process.execPath, [file, ...args], { env })
    const cli = async (...args: string[]) => JSON.parse((await run(args)).stdout)
    const scene = draft()
    const author = await readFile(join(root, 'author.token'), 'utf8')
    const { token } = await (await fetch(origin + '/api/session')).json()
    const post = (path: string, body: unknown, credential: string) => fetch(origin + '/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential }, body: JSON.stringify(body),
    })
    const { revision } = await (await post('publish', { request: 'spec-1', scene }, author)).json()
    await assert.rejects(run(['spec', revision]), /Accept this draft/)
    const preview = await cli('spec', 'yard/gate', '--unapproved')
    assert.equal(preview.source.approved, false)
    assert.ok((await post('revision/' + revision + '/approve', { kind: 'final', review: { checked: 'Checked.' } }, token)).ok)
    const approved = await cli('spec', revision)
    assert.deepEqual(specSchema.parse(approved), approved)
    assert.equal(approved.source.approved, true)
    assert.equal(approved.source.contentDigest, contentDigest(scene))
    assert.deepEqual(await cli('spec', revision), approved)
    const fresh = await cli('spec', revision, '--expect', approved.source.contentDigest)
    assert.equal(fresh.check.stale, false)
    // An edit makes the earlier spec stale and clears approval.
    assert.ok((await post('publish', { request: 'spec-2', scene: { ...scene, intent: 'Revised.' } }, author)).ok)
    await assert.rejects(run(['spec', revision, '--expect', approved.source.contentDigest, '--unapproved']), (error: { code: number; stdout: string }) => error.code === 3 && JSON.parse(error.stdout).check.stale === true)

    // Status and the second-start message report the running instance.
    const status = JSON.parse((await run(['--status'], 'server.ts')).stdout)
    assert.equal(status.running.pid, service.pid)
    assert.equal(status.running.port, port)
    assert.equal(status.running.dataDir, root)
    assert.match(status.running.revision, /\S/)
    assert.equal((await (await fetch(origin + '/api/status')).json()).pid, service.pid)
    await assert.rejects(run([], 'server.ts'), (second: { code: number; stderr: string }) => second.code === 1 && /already running/.test(second.stderr) &&
      second.stderr.includes(origin) && second.stderr.includes('pid ' + service.pid) && second.stderr.includes(root))
    assert.equal(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).pid, service.pid)
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit')
      service.kill()
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
