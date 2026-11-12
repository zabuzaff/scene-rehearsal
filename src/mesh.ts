import validator from 'gltf-validator'
import { z } from 'zod'
import { hash, sourceSchema } from './handoff.ts'
import { sha } from './model.ts'

const file = z.object({ kind: z.string(), hash: sha })
const bundle = z.object({
  format: z.literal('mesh-foundry-1'),
  project: z.object({
    schemaVersion: z.literal(1), id: z.string(),
    acceptance: z.array(z.object({ revisionId: z.string(), previousRevisionId: z.string().optional() })).default([]),
    accepted: z.record(z.string(), z.string()),
    revisions: z.array(z.object({
      id: z.string(), assetId: z.string(), stage: z.string(), files: z.array(file),
    })),
  }),
  blobs: z.record(sha, z.string()),
})

export async function readAcceptedModel(input: unknown, asset: string) {
  const { project, blobs } = bundle.parse(input)
  const models = new Map(project.revisions.filter(r => r.assetId === asset && r.stage === 'model').map(r => [r.id, r]))
  const history = [...project.acceptance].reverse()
  const approved = models.get(project.accepted[asset]) ??
    models.get(history.find(event => models.has(event.revisionId))?.revisionId ?? '') ??
    models.get(history.find(event => event.previousRevisionId && models.has(event.previousRevisionId))?.previousRevisionId ?? '')
  const rev = approved
  const glb = rev?.files.find(f => f.kind === 'model')
  if (!rev || !glb || !Object.hasOwn(blobs, glb.hash)) throw Error('The bundle has no accepted model for this asset.')
  const bytes = Buffer.from(blobs[glb.hash], 'base64')
  if (bytes.length < 20 || bytes.length > 100_000_000 || hash(bytes) !== glb.hash ||
    bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) {
    throw Error('Invalid GLB bytes.')
  }
  const end = 20 + bytes.readUInt32LE(12)
  if (end > bytes.length) throw Error('Invalid GLB chunk size.')
  const model = JSON.parse(bytes.toString('utf8', 20, end))
  if (!model.meshes?.length || model.buffers?.some((b: { uri?: string }) => b.uri) ||
      model.images?.some((i: { uri?: string }) => i.uri)) throw Error('Use an embedded GLB with geometry.')
  const clips = z.array(z.object({ name: z.string().min(1) })).parse(model.animations ?? []).map(a => a.name)
  if (new Set(clips).size !== clips.length) throw Error('Ambiguous animation clip names.')
  const validation = await validator.validateBytes(bytes, { maxIssues: 20 })
  if (validation.issues.numErrors) throw Error('GLB failed validation.')
  return { bytes, source: sourceSchema.parse({ project: project.id, asset, revision: rev.id, hash: glb.hash, clips }) }
}
