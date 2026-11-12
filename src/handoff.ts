import { createHash } from 'node:crypto'
import { z } from 'zod'
import { assetClips, manifestSchema, missingAsset, sha } from './model.ts'

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, val]) => JSON.stringify(key) + ':' + canonical(val)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export const sourceIdentity = z.strictObject({
  project: z.string().min(1), asset: z.string().min(1), revision: z.string().min(1), hash: sha,
})
export const sourceSchema = sourceIdentity.extend({ clips: z.array(z.string()), ownerChecked: z.literal(true).optional() })
export function sourceKey({ project, asset, revision, hash: digest }: z.infer<typeof sourceIdentity>) {
  return hash(canonical({ project, asset, revision, hash: digest }))
}

const contract = z.strictObject({
  format: z.enum(['scene-rehearsal-1', 'scene-rehearsal-2']), revision: sha, parent: sha.nullable(),
  links: z.array(z.number().int().positive()), scene: manifestSchema,
  approval: z.strictObject({ kind: z.literal('final'), at: z.string() }),
  assets: z.array(z.strictObject({ path: z.string(), source: sourceSchema, legacy: z.literal(true).optional() })),
})

export function verifyPackage(input: unknown, trusted: Set<string>) {
  const pkg = z.strictObject({ manifest: contract, blobs: z.record(z.string(), z.string()) }).parse(input)
  const m = pkg.manifest
  if (m.format !== 'scene-rehearsal-' + m.scene.version) throw Error('Scene format does not match package.')
  if (!trusted.has(hash(canonical(m)))) throw Error('Manifest digest is not approved by the consumer.')
  if (hash(canonical({ parent: m.parent, scene: m.scene, links: m.links })) !== m.revision) throw Error('Revision digest mismatch.')
  if (!m.scene.room) throw Error('Approved package must include room geometry.')
  const paths = new Set<string>()
  const records = new Map<string, typeof m.assets>()
  const identities = new Set<string>()
  for (const entry of m.assets) {
    const { path, source, legacy } = entry
    if (path !== 'assets/' + source.hash + '.glb' || !Object.hasOwn(pkg.blobs, path) ||
        (m.scene.version === 1 && (paths.has(path) || legacy))) throw Error('Invalid asset path.')
    const key = sourceKey(source)
    if (identities.has(key)) throw Error('Duplicate source record.')
    identities.add(key)
    const entries = records.get(source.hash) ?? []
    if (legacy && entries.some(entry => entry.legacy)) throw Error('Ambiguous legacy source record.')
    entries.push(entry)
    records.set(source.hash, entries)
    if (!paths.has(path) && hash(Buffer.from(pkg.blobs[path], 'base64')) !== source.hash) throw Error('Asset digest mismatch.')
    paths.add(path)
  }
  if (Object.keys(pkg.blobs).length !== paths.size) throw Error('Unexpected asset bytes.')
  for (const object of m.scene.objects) {
    if (missingAsset(object)) throw Error('Required asset missing.')
    const asset = object.asset
    if (!asset) continue
    const entries = records.get(asset.hash) ?? []
    const key = 'source' in asset ? asset.source : undefined
    const entry = key ? entries.find(entry => sourceKey(entry.source) === key) :
      entries.length === 1 ? entries[0] : entries.find(entry => entry.legacy)
    if (!entry || (m.scene.version === 2 && !entry.source.ownerChecked) ||
        assetClips(asset).some(clip => !entry.source.clips.includes(clip))) {
      throw Error('Missing mapped asset or clip.')
    }
  }
  return m.scene
}
