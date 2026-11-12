import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, evaluate, manifestSchema } from '../src/model.ts'
import { canonical, hash, verifyPackage } from '../src/handoff.ts'

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
