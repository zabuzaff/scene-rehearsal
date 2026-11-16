import { Group, type Object3D } from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { resolveGlbNode } from './glb-node.ts'

export async function modelInstance(gltf: GLTF, node: string | undefined, slot: string, clips: readonly string[] = []) {
  if (node === undefined) return { model: gltf.scene, placement: gltf.scene }
  const index = resolveGlbNode(gltf.parser.json, node, slot, clips)
  const dependency: Object3D = await gltf.parser.getDependency('node', index)
  // GLTFLoader gives named nodes unique runtime names and retains them on scene clones.
  const model = gltf.scene.getObjectByName(dependency.name)
  if (!model) throw Error('Mapped node unavailable for ' + slot)
  const placement = new Group()
  placement.position.copy(model.position).negate()
  placement.add(model)
  return { model, placement }
}
