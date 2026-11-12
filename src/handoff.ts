import { createHash } from 'node:crypto'
import { z } from 'zod'
import { manifestSchema, sha } from './model.ts'

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export const sourceSchema = z.strictObject({
  project: z.string(), asset: z.string(), revision: z.string(), hash: sha, clips: z.array(z.string()),
})
const contract = z.strictObject({
  format: z.literal('scene-rehearsal-1'), revision: sha, parent: sha.nullable(),
  links: z.array(z.number().int().positive()), scene: manifestSchema,
  approval: z.strictObject({ kind: z.literal('final'), at: z.string() }),
  assets: z.array(z.strictObject({ path: z.string(), source: sourceSchema })),
})

export function verifyPackage(input: unknown, trusted: Set<string>) {
  const pkg = z.strictObject({ manifest: contract, blobs: z.record(z.string(), z.string()) }).parse(input)
  const m = pkg.manifest
  if (!trusted.has(hash(canonical(m)))) throw Error('Manifest digest is not approved by the consumer.')
  if (hash(canonical({ parent: m.parent, scene: m.scene, links: m.links })) !== m.revision) throw Error('Revision digest mismatch.')
  if (!m.scene.room) throw Error('Approved package must include room geometry.')
  const paths = new Set<string>()
  for (const { path, source } of m.assets) {
    if (path !== 'assets/' + source.hash + '.glb' || paths.has(path) || !Object.hasOwn(pkg.blobs, path)) throw Error('Invalid asset path.')
    if (hash(Buffer.from(pkg.blobs[path], 'base64')) !== source.hash) throw Error('Asset digest mismatch.')
    paths.add(path)
  }
  if (Object.keys(pkg.blobs).length !== paths.size) throw Error('Unexpected asset bytes.')
  for (const object of m.scene.objects) {
    if (object.requiresAsset && !object.asset) throw Error('Required asset missing.')
    if (object.asset && !m.assets.some(a => a.source.hash === object.asset?.hash && a.source.clips.includes(object.asset.clip))) {
      throw Error('Missing mapped asset or clip.')
    }
  }
  return m.scene
}
