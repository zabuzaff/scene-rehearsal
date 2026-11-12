import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixture, evaluate, manifestSchema } from '../src/model.ts'
import { canonical, hash, sourceKey, verifyPackage } from '../src/handoff.ts'

test('interruption starts, merges a repeat, and returns to routine', () => {
  const scene = manifestSchema.parse(fixture)
  assert.equal(evaluate(scene, 'interruption', 79).activity, 'Researching')
  assert.equal(evaluate(scene, 'interruption', 80).activity, 'Walking to terminal')
  assert.equal(evaluate(scene, 'interruption', 105).trace[1].result, 'Merged with active response')
  assert.equal(evaluate(scene, 'interruption', 135).activity, 'Checking collector')
  assert.equal(evaluate(scene, 'interruption', 175).activity, 'Returning to desk')
  assert.equal(evaluate(scene, 'interruption', 225).activity, 'Researching')
  const reverse = structuredClone(scene)
  reverse.scenarios[1].events.reverse()
  assert.deepEqual(evaluate(reverse, 'interruption', 105), evaluate(scene, 'interruption', 105))
})

test('a changed route that invalidates a checkpoint is rejected', () => {
  const scene = structuredClone(fixture)
  scene.route[3][0] += 1
  assert.equal(manifestSchema.safeParse(scene).success, false)
})

test('consumer requires separately trusted final approval and verified blobs', () => {
  const bytes = Buffer.from('asset bytes')
  const digest = hash(bytes)
  const scene = structuredClone(fixture)
  scene.objects.find(object => object.requiresAsset)!.asset = { hash: digest, clip: 'walk' }
  const path = 'assets/' + digest + '.glb'
  const body = { parent: null, scene, links: [] }
  const manifest = {
    format: 'scene-rehearsal-1', revision: hash(canonical(body)), ...body,
    approval: { kind: 'final', at: '2026-11-12T00:00:00Z' },
    assets: [{ path, source: { project: 'test', asset: 'human', revision: 'r1', hash: digest, clips: ['walk'] } }],
  }
  const trusted = new Set([hash(canonical(manifest))])
  const pkg = { manifest, blobs: { [path]: bytes.toString('base64') } }
  assert.deepEqual(verifyPackage(pkg, trusted), scene)
  const changedRoom = structuredClone(pkg)
  changedRoom.manifest.scene.room![0].size[0] += 1
  assert.throws(() => verifyPackage(changedRoom, trusted), /not approved/)
  const legacy = structuredClone(pkg)
  delete legacy.manifest.scene.room
  legacy.manifest.revision = hash(canonical({ parent: legacy.manifest.parent, scene: legacy.manifest.scene, links: legacy.manifest.links }))
  assert.throws(() => verifyPackage(legacy, new Set([hash(canonical(legacy.manifest))])), /include room/)
  assert.throws(() => verifyPackage(pkg, new Set()), /not approved/)
  assert.throws(() => verifyPackage({ ...pkg, blobs: { [path]: 'YQ==' } }, trusted), /Asset digest/)
  const blockout = { ...manifest, approval: { ...manifest.approval, kind: 'blockout' } }
  assert.throws(() => verifyPackage({ ...pkg, manifest: blockout }, new Set([hash(canonical(blockout))])))
})

test('Kairo v2 draft verifies ordered alerts, independent routines and evidence recovery', () => {
  const request = JSON.parse(readFileSync(new URL('../fixtures/kairo-office.json', import.meta.url), 'utf8'))
  const scene = manifestSchema.parse(request.scene)
  assert.equal(scene.version, 2)
  const overlap = evaluate(scene, 'interruption', 30)
  assert.deepEqual(overlap.trace.slice(-3).map(event => event.result),
    ['Response started', 'Merged with active response', 'Ignored while busy'])
  assert.equal(evaluate(scene, 'interruption', 98).actors[0].activity, 'inspect')
  assert.equal(evaluate(scene, 'interruption', 123).actors[0].activity, 'return')
  assert.equal(evaluate(scene, 'interruption', 191).actors[0].activity, 'quiet')
  assert.equal(evaluate(scene, 'recovery', 205).actors[0].activity, 'outbound')
  assert.equal(evaluate(scene, 'recovery', 205).actors[1].clipTick, 205)
  assert.deepEqual(evaluate(scene, 'recovery', 15).evidence[1], {
    station: 'collector-terminal', health: 'healthy', freshness: 'stale',
  })
  assert.equal(evaluate(scene, 'recovery', 25).trace.some(event => event.result === 'Response started'), false)
  assert.equal(evaluate(scene, 'recovery', 151).evidence[1].health, 'healthy')
  const invalid = structuredClone(scene)
  invalid.returning.at(-1)!.position[0] += 1
  assert.equal(manifestSchema.safeParse(invalid).success, false)
})

test('v2 packages preserve two exact sources for one GLB, including a legacy mapping', () => {
  const request = JSON.parse(readFileSync(new URL('../fixtures/kairo-office.json', import.meta.url), 'utf8'))
  const scene = manifestSchema.parse(request.scene)
  assert.equal(scene.version, 2)
  const bytes = Buffer.from('shared GLB fixture bytes')
  const digest = hash(bytes)
  const first = { project: 'test', asset: 'human', revision: 'r1', hash: digest, clips: ['work'], ownerChecked: true as const }
  const next = { ...first, revision: 'r2' }
  for (const object of scene.objects.filter(object => object.requiresAsset)) {
    object.asset = {
      hash: digest,
      clips: Object.fromEntries(object.requiredActivities!.map(activity => [activity, 'work'])),
    }
  }
  scene.objects.find(object => object.id === 'observer')!.asset!.source = sourceKey(next)
  const path = 'assets/' + digest + '.glb'
  const body = { parent: null, scene, links: [] }
  const manifest = {
    format: 'scene-rehearsal-2', revision: hash(canonical(body)), ...body,
    approval: { kind: 'final', at: '2026-11-12T00:00:00Z' },
    assets: [{ path, source: first, legacy: true as const }, { path, source: next }],
  }
  const blobs = { [path]: bytes.toString('base64') }
  const verify = (candidate: typeof manifest) =>
    verifyPackage({ manifest: candidate, blobs }, new Set([hash(canonical(candidate))]))
  assert.deepEqual(verify(manifest), scene)
  assert.throws(() => verify({ ...manifest, assets: [{ path, source: first }, { path, source: next }] }), /Missing mapped asset/)
  assert.throws(() => verify({ ...manifest, assets: [{ path, source: first }] }), /Missing mapped asset/)
})
