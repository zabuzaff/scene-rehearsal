import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Group, Mesh, Raycaster, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { modelInstance } from '../src/model-instance.ts'
import { resolveGlbNode } from '../src/glb-node.ts'
import { canonical, hash, sourceKey, verifyPackage } from '../src/handoff.ts'
import { manifestSchema } from '../src/model.ts'

const names = ['Desk A', 'Desk B', 'Chair A', 'Chair B']
function kit(duplicate = false) {
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2, 3] }, { nodes: [8] }],
    nodes: [
      ...names.map((name, i) => ({
        name: duplicate && i === 1 ? names[0] : name,
        children: [4 + i], translation: [20 + i * 5, 0, 0], scale: [2, 1, 1],
      })),
      ...names.map(() => ({ mesh: 0, translation: [0, 1, 0], extras: { id: 'glTF metadata' } })),
      { name: names[0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Fixture oak' }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }
  const json = JSON.stringify(document)
  const padded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4))
  const glb = new ArrayBuffer(28 + padded.length + 36)
  const bytes = Buffer.from(glb)
  bytes.write('glTF')
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(padded.length, 12)
  bytes.write('JSON', 16)
  padded.copy(bytes, 20)
  const bin = 20 + padded.length
  bytes.writeUInt32LE(36, bin)
  bytes.write('BIN\0', bin + 4)
  bytes.writeFloatLE(1, bin + 20)
  bytes.writeFloatLE(1, bin + 36)
  return glb
}

test('four node bindings retain only their own geometry and can be placed and ray-picked independently', async () => {
  const glb = kit()
  const loader = new GLTFLoader()
  const groups = []
  for (const [i, name] of names.entries()) {
    const gltf = await loader.parseAsync(glb, '')
    const { model, placement } = await modelInstance(gltf, name, name)
    const group = new Group()
    group.position.x = i * 4
    group.add(placement)
    group.updateMatrixWorld()
    const meshes = placement.getObjectsByProperty('isMesh', true) as Mesh[]
    assert.equal(meshes.length, 1)
    assert.equal((meshes[0].material as { name: string }).name, 'Fixture oak')
    assert.deepEqual(model.scale.toArray(), [2, 1, 1])
    assert.deepEqual(meshes[0].getWorldPosition(new Vector3()).toArray(), [i * 4, 1, 0])
    groups.push(group)
  }
  for (const [i, group] of groups.entries()) {
    const ray = new Raycaster(new Vector3(i * 4 + .5, 1.25, 1), new Vector3(0, 0, -1))
    const hits = ray.intersectObjects(groups, true)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].object, group.getObjectByProperty('isMesh', true))
  }
  const full = await loader.parseAsync(glb, '')
  const { placement } = await modelInstance(full, undefined, 'whole model')
  assert.equal(placement, full.scene)
  assert.deepEqual(placement.children.map(child => child.position.x), [20, 25, 30, 35])
  await assert.rejects(modelInstance(full, 'desk A', 'v09'), /"desk A" for v09 is missing/)
  await assert.rejects(modelInstance(await loader.parseAsync(kit(true), ''), names[0], 'v09'), /"Desk A" for v09 is ambiguous/)
})

test('verified handoff retains four selectors and one exact source, and rejects invalid selectors', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/kairo-office.json', import.meta.url), 'utf8'))
  function verify(selectors: readonly string[], glb: ArrayBuffer, replaceSource = false) {
    const scene = manifestSchema.parse(fixture.scene)
    assert.equal(scene.version, 2)
    const bytes = Buffer.from(glb)
    const digest = hash(bytes)
    const source = { project: 'fixture', asset: 'kit', revision: 'accepted-1', hash: digest, clips: ['work'], ownerChecked: true }
    const props = scene.objects.filter(object => object.kind === 'desk' || object.kind === 'chair')
    assert.equal(props.length, 4)
    for (const object of scene.objects.filter(object => object.requiresAsset)) {
      object.asset = {
        hash: digest, source: sourceKey(source),
        clips: Object.fromEntries(object.requiredActivities!.map(activity => [activity, 'work'])),
      }
    }
    for (const [i, object] of props.entries()) object.asset = { hash: digest, source: sourceKey(source), node: selectors[i] }
    const body = { parent: null, scene, links: [] }
    const path = 'assets/' + digest + '.glb'
    const manifest = {
      format: 'scene-rehearsal-2', revision: hash(canonical(body)), ...body,
      approval: { kind: 'final', at: '2026-11-16T00:00:00Z' },
      assets: [{ path, source: replaceSource ? { ...source, revision: 'accepted-2' } : source }],
    }
    const verified = verifyPackage({ manifest, blobs: { [path]: bytes.toString('base64') } }, new Set([hash(canonical(manifest))]))
    assert.deepEqual(verified.objects, scene.objects)
  }
  verify(names, kit())
  assert.throws(() => verify(['unknown', ...names.slice(1)], kit()), /node "unknown".*missing/)
  assert.throws(() => verify(names, kit(true)), /node "Desk A".*ambiguous/)
  assert.throws(() => verify(names, kit(), true), /Missing mapped asset/)
})

test('node bindings reject empty subtrees and clips that target sibling pieces', () => {
  const document = {
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'Desk', children: [3] }, { name: 'Chair', mesh: 0 }, { name: 'Empty' }, { mesh: 0 }],
    meshes: [{ primitives: [{}] }],
    animations: [
      { name: 'desk', channels: [{ target: { node: 3 } }] },
      { name: 'chair', channels: [{ target: { node: 1 } }] },
      { name: 'mixed', channels: [{ target: { node: 3 } }, { target: { node: 1 } }] },
    ],
  }
  assert.equal(resolveGlbNode(document, 'Desk', 'v09', ['desk']), 0)
  assert.throws(() => resolveGlbNode(document, 'Empty', 'v09'), /contains no renderable geometry/)
  for (const clip of ['chair', 'mixed']) {
    assert.throws(() => resolveGlbNode(document, 'Desk', 'v09', [clip]), new RegExp(`cannot bind clip "${clip}"`))
  }
})
