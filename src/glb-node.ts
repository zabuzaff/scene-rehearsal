type NodeDocument = {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { name?: string; children?: number[]; mesh?: number }[]
  meshes?: { primitives?: unknown[] }[]
  animations?: { name?: string; channels: { target: { node?: number } }[] }[]
}

export function resolveGlbNode(document: NodeDocument, name: string, slot: string, clips: readonly string[] = []) {
  const visited = new Set<number>()
  const matches: number[] = []
  const pending = [...(document.scenes?.[document.scene ?? 0]?.nodes ?? [])]
  while (pending.length) {
    const index = pending.pop()!
    if (visited.has(index)) continue
    visited.add(index)
    const node = document.nodes?.[index]
    if (node?.name === name) matches.push(index)
    for (const child of node?.children ?? []) pending.push(child)
  }
  if (matches.length !== 1) {
    const reason = matches.length ? 'ambiguous' : 'missing'
    throw Error(`GLB node ${JSON.stringify(name)} for ${slot} is ${reason} in the default scene.`)
  }
  const selected = matches[0]
  const subtree = new Set<number>()
  pending.push(selected)
  while (pending.length) {
    const index = pending.pop()!
    if (subtree.has(index)) continue
    subtree.add(index)
    for (const child of document.nodes?.[index]?.children ?? []) pending.push(child)
  }
  const binding = `GLB node ${JSON.stringify(name)} for ${slot}`
  if (![...subtree].some(index => {
    const mesh = document.nodes?.[index]?.mesh
    return mesh !== undefined && document.meshes?.[mesh]?.primitives?.length
  })) throw Error(binding + ' contains no renderable geometry.')
  for (const clip of clips) {
    const animation = document.animations?.find(animation => animation.name === clip)
    if (!animation?.channels.length || animation.channels.some(
      ({ target }) => target.node === undefined || !subtree.has(target.node)
    )) throw Error(binding + ` cannot bind clip ${JSON.stringify(clip)} entirely within its subtree.`)
  }
  return selected
}

export function verifyGlbNode(bytes: Uint8Array, name: string, slot: string, clips: readonly string[] = []) {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 20 || header.getUint32(0, true) !== 0x46546c67 ||
      header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== bytes.length ||
      header.getUint32(16, true) !== 0x4e4f534a || header.getUint32(12, true) > bytes.length - 20) {
    throw Error(`Invalid GLB for ${slot}.`)
  }
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + header.getUint32(12, true)))
  resolveGlbNode(JSON.parse(json), name, slot, clips)
}
