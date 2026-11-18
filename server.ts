import Fastify from 'fastify'
import serveStatic from '@fastify/static'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { assetClips, draftReviewSchema, defaultRoom, missingAsset, manifestSchema, noteSchema, sha, type SceneObject } from './src/model.ts'
import { canonical, hash, sourceIdentity, sourceKey, sourceSchema } from './src/handoff.ts'
import { acceptedModel, readAcceptedModel } from './src/mesh.ts'
import { verifyGlbNode } from './src/glb-node.ts'

const root = process.env.SCENE_REHEARSAL_DATA_DIR ?? join(homedir(), 'Library/Application Support/Scene Rehearsal')
let port = Number(process.env.SCENE_REHEARSAL_PORT ?? 4331)
if (!isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local configuration.')
let origin = 'http://127.0.0.1:' + port
const runtimePath = join(root, 'runtime.json')
if (process.argv.includes('--status')) {
  console.log(JSON.stringify({ root: existsSync(root) ? realpathSync(root) : root, origin, database: join(root, 'review.sqlite') }))
  process.exit(0)
}
mkdirSync(root, { recursive: true, mode: 0o700 })
if (realpathSync(root) !== root) throw Error('Use the canonical data path.')
const running = existsSync(runtimePath) ? (() => { try { return JSON.parse(readFileSync(runtimePath, 'utf8')) as { url: string; pid: number } } catch { return undefined } })() : undefined
if (running && Number.isInteger(running.pid)) {
  let alive = false
  try { process.kill(running.pid, 0); alive = true } catch { /* stale file */ }
  if (alive) {
    console.log('Scene Rehearsal already running at ' + running.url + '\nData: ' + root)
    process.exit(0)
  }
}
// One service per data directory: whoever creates the lock first runs, others exit.
const lockPath = join(root, 'service.lock')
for (let attempt = 0; ; attempt++) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
    break
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    const owner = Number(readFileSync(lockPath, 'utf8'))
    let alive = false
    try { process.kill(owner, 0); alive = owner !== process.pid } catch { /* stale lock */ }
    if (alive || attempt > 2) {
      console.log('Scene Rehearsal is already starting or running for this data directory.')
      process.exit(0)
    }
    rmSync(lockPath, { force: true })
  }
}
const blobDir = join(root, 'blobs')
mkdirSync(blobDir, { mode: 0o700, recursive: true })
const db = new DatabaseSync(join(root, 'review.sqlite'))
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS revisions (digest TEXT PRIMARY KEY, parent TEXT, scene TEXT NOT NULL, links TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS drafts (key TEXT PRIMARY KEY, digest TEXT NOT NULL, rev INTEGER NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plan_heads (plan TEXT PRIMARY KEY, digest TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS draft_reviews (revision TEXT PRIMARY KEY, checked TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, revision TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, revision TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS note_decisions (id INTEGER PRIMARY KEY, note INTEGER NOT NULL, resolved INTEGER NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals (revision TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(revision,kind));
  CREATE TABLE IF NOT EXISTS asset_sources (key TEXT PRIMARY KEY, source TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, source TEXT NOT NULL);
`)
const head = () => db.prepare('SELECT digest FROM head').get()?.digest as string | undefined
const transaction = <T>(work: () => T) => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
const planKey = (scene: z.infer<typeof manifestSchema>) => scene.version === 3 ? canonical(scene.plan) : undefined
function saveRevision(parent: string | null, scene: z.infer<typeof manifestSchema>, links: number[]) {
  const digest = hash(canonical({ parent, scene, links }))
  db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?)').run(digest, parent, JSON.stringify(scene), JSON.stringify(links))
  const plan = planKey(scene)
  if (plan) db.prepare('INSERT INTO plan_heads VALUES(?,?) ON CONFLICT(plan) DO UPDATE SET digest=excluded.digest').run(plan, digest)
  else db.prepare('INSERT INTO head VALUES(1,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest').run(digest)
  return digest
}
const tokenPath = join(root, 'author.token')
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
const authorToken = readFileSync(tokenPath, 'utf8')
const reviewToken = randomBytes(32).toString('hex')
const app = Fastify({ bodyLimit: 1_000_000 })
function requireRole(pass: boolean) {
  if (!pass) throw Object.assign(Error('This action requires the appropriate local role.'), { statusCode: 403 })
}
const bad = (message: string, statusCode = 400) => Object.assign(Error(message), { statusCode })
function revision(id: string) {
  const row = db.prepare('SELECT * FROM revisions WHERE digest=?').get(id)
  if (!row) throw bad('Revision not found.', 404)
  return { digest: id, parent: row.parent as string | null, scene: manifestSchema.parse(JSON.parse(String(row.scene))), links: JSON.parse(String(row.links)) as number[] }
}
const params = z.object({ digest: sha })
const getRevision = (input: unknown) => revision(params.parse(input).digest)
function resolveSource(asset: NonNullable<SceneObject['asset']>) {
  const legacy = db.prepare('SELECT source FROM assets WHERE hash=?').get(asset.hash)
  const key = 'source' in asset ? asset.source : undefined
  const row = key ? db.prepare('SELECT source FROM asset_sources WHERE key=?').get(key) : legacy
  const record = row ? sourceSchema.parse(JSON.parse(String(row.source))) : undefined
  if (record?.hash === asset.hash) return record
  if (!row && key && legacy) {
    const fallback = sourceSchema.parse(JSON.parse(String(legacy.source)))
    if (sourceKey(fallback) === key) return fallback
  }
}

function mappings(rev: ReturnType<typeof revision>, required: boolean) {
  const result = new Map<string, { source: z.infer<typeof sourceSchema>; file: Buffer; legacy: boolean }>()
  for (const object of rev.scene.objects) {
    if (required && missingAsset(object)) throw bad('Complete the required asset and clip mappings for ' + object.label + '.')
    if (!object.asset) continue
    const source = resolveSource(object.asset)
    if (!source) throw bad('Mapped asset not found.')
    if (rev.scene.version !== 1 && !source.ownerChecked) throw bad('Confirm the Mesh Foundry source record for ' + object.label + '.')
    const file = readFileSync(join(blobDir, source.hash))
    const clips = assetClips(object.asset)
    if (clips.some(clip => !source.clips.includes(clip)) || hash(file) !== source.hash) throw bad('Mapped asset or clip is invalid.')
    if (object.asset.node !== undefined) {
      verifyGlbNode(file, object.asset.node, object.id, clips)
    }
    const key = sourceKey(source)
    const explicit = 'source' in object.asset && object.asset.source
    result.set(key, { source, file, legacy: !explicit || result.get(key)?.legacy === true })
  }
  return result
}

app.addHook('onRequest', async (req) => {
  if (req.headers.host !== '127.0.0.1:' + port ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers['sec-fetch-site'] === 'cross-site') throw bad('Invalid local origin.', 403)
  if (req.method !== 'GET' && !req.headers.authorization && req.headers.origin !== origin) throw bad('Browser origin required.', 403)
})
app.setErrorHandler((error, _req, reply) => {
  const err = error as Error & {statusCode?: number}
  const status = err.statusCode ?? 400
  reply.code(status).send({ error: err instanceof z.ZodError ? err.issues.map(i => i.message).join(' ') : err.message })
})
app.get('/api/session', async (_req, reply) => {
  return reply.header('Cache-Control', 'no-store').send({ token: reviewToken })
})
app.get('/api/library', async () => ({
  head: head(),
  planHeads: db.prepare('SELECT plan, digest FROM plan_heads ORDER BY plan').all()
    .map(row => ({ plan: JSON.parse(String(row.plan)), digest: row.digest })),
  drafts: db.prepare('SELECT key, digest, rev, updated FROM drafts ORDER BY key').all(),
  revisions: db.prepare('SELECT digest, parent, json_extract(scene,\'$.title\') AS title FROM revisions ORDER BY rowid DESC').all(),
}))
app.get('/api/revision/:digest', async req => {
  const rev = getRevision(req.params)
  const notes = db.prepare(`SELECT n.id,n.revision,n.data,
    COALESCE((SELECT resolved FROM note_decisions WHERE note=n.id ORDER BY id DESC LIMIT 1),0) AS resolved
    FROM notes n ORDER BY n.id`).all()
  const sources = rev.scene.objects.flatMap(object => {
    if (!object.asset) return []
    const source = resolveSource(object.asset)
    return source ? [{ ...source, object: object.id }] : []
  })
  const draft = db.prepare('SELECT rev, updated FROM drafts WHERE digest=?').get(rev.digest)
  return { ...rev, ...(draft ? { draftRev: draft.rev, updatedAt: draft.updated } : {}), sources, notes: notes.filter(n => n.revision === rev.digest || rev.links.includes(Number(n.id)))
    .map(n => ({ id: n.id, revision: n.revision, resolved: Boolean(n.resolved), ...JSON.parse(String(n.data)) })),
    draftReview: db.prepare('SELECT checked FROM draft_reviews WHERE revision=?').get(rev.digest),
    approvals: db.prepare('SELECT kind,at FROM approvals WHERE revision=?').all(rev.digest) }
})
app.post('/api/publish', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + authorToken)
  const input = z.strictObject({ request: z.string().min(1).max(100), parent: sha.nullable().default(null), scene: manifestSchema, links: z.array(z.number().int().positive()).max(200).default([]) }).parse(req.body)
  return transaction(() => {
    const checksum = hash(canonical(input))
    const previous = db.prepare('SELECT * FROM receipts WHERE id=?').get(input.request)
    if (previous) {
      if (previous.request_hash !== checksum) throw bad('Request ID already used.', 409)
      return { revision: previous.revision }
    }
    if (input.scene.version === 3) {
      const key = input.scene.plan.storyboardId + '/' + input.scene.plan.sceneId
      const existing = db.prepare('SELECT digest, rev FROM drafts WHERE key=?').get(key)
      const digest = existing ? String(existing.digest) : hash(canonical({ draft: key }))
      for (const link of input.links) {
        const note = db.prepare('SELECT revision FROM notes WHERE id=?').get(link)
        if (!note || note.revision !== digest) throw bad('Linked note not found on this draft.')
      }
      if (!existing) db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(digest, null, JSON.stringify(input.scene), JSON.stringify(input.links))
      const changed = existing && canonical(revision(digest).scene) !== canonical(input.scene)
      if (changed) {
        db.prepare('UPDATE revisions SET scene=?, links=? WHERE digest=?').run(JSON.stringify(input.scene), JSON.stringify(input.links), digest)
        db.prepare('DELETE FROM approvals WHERE revision=?').run(digest)
        db.prepare('DELETE FROM draft_reviews WHERE revision=?').run(digest)
      }
      const now = new Date().toISOString()
      if (!existing) db.prepare('INSERT INTO drafts VALUES(?,?,1,?)').run(key, digest, now)
      else if (changed) db.prepare('UPDATE drafts SET rev=rev+1, updated=? WHERE key=?').run(now, key)
      mappings(revision(digest), false)
      db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.request, checksum, digest)
      return { revision: digest }
    }
    const base = head()
    if ((base ?? null) !== input.parent) throw bad('The base revision changed. Read the head before publishing.', 409)
    for (const link of input.links) {
      if (!db.prepare('SELECT id FROM notes WHERE id=?').get(link)) throw bad('Linked note not found.')
    }
    const requiredSlots = input.parent ? revision(input.parent).scene.objects.filter(object => 'requiresAsset' in object && object.requiresAsset) : []
    if (requiredSlots.some(slot => !input.scene.objects.some(object => object.id === slot.id && 'requiresAsset' in object && object.requiresAsset && object.kind === slot.kind &&
      (!('requiredActivities' in slot) || (slot.requiredActivities ?? []).every(beat =>
        'requiredActivities' in object && object.requiredActivities?.includes(beat)))))) {
      throw bad('This revision must preserve required asset slots.')
    }
    const scene = input.scene.version === 1 ? { ...input.scene, room: input.scene.room ?? defaultRoom } : input.scene
    const digest = saveRevision(input.parent, scene, input.links)
    mappings(revision(digest), false)
    db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.request, checksum, digest)
    return { revision: digest }
  })
})
app.post('/api/revision/:digest/remove', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + authorToken)
  const rev = getRevision(req.params)
  if (db.prepare('SELECT 1 FROM drafts WHERE digest=?').get(rev.digest)) throw bad('A scene\'s live draft cannot be removed.', 409)
  return transaction(() => {
    const notes = db.prepare('SELECT id FROM notes WHERE revision=?').all(rev.digest).map(row => Number(row.id))
    for (const id of notes) db.prepare('DELETE FROM note_decisions WHERE note=?').run(id)
    db.prepare('DELETE FROM notes WHERE revision=?').run(rev.digest)
    db.prepare('DELETE FROM approvals WHERE revision=?').run(rev.digest)
    db.prepare('DELETE FROM draft_reviews WHERE revision=?').run(rev.digest)
    db.prepare('DELETE FROM receipts WHERE revision=?').run(rev.digest)
    db.prepare('DELETE FROM head WHERE digest=?').run(rev.digest)
    db.prepare('DELETE FROM plan_heads WHERE digest=?').run(rev.digest)
    db.prepare('UPDATE revisions SET parent=NULL WHERE parent=?').run(rev.digest)
    db.prepare('DELETE FROM revisions WHERE digest=?').run(rev.digest)
    return { removed: rev.digest }
  })
})
app.post('/api/revision/:digest/note', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + reviewToken)
  const rev = getRevision(req.params)
  const note = noteSchema.parse(req.body)
  if (!rev.scene.scenarios.some(s => s.id === note.scenario) || note.tick > rev.scene.duration ||
      (note.end !== undefined && (note.end < note.tick || note.end > rev.scene.duration)) ||
      (note.object && !rev.scene.objects.some(o => o.id === note.object))) throw bad('Invalid pin context.')
  return { id: Number(db.prepare('INSERT INTO notes(revision,data) VALUES(?,?)').run(rev.digest, JSON.stringify(note)).lastInsertRowid) }
})
app.post('/api/note/:id/decision', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + reviewToken)
  const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params)
  const { resolved } = z.object({ resolved: z.boolean() }).parse(req.body)
  if (!db.prepare('SELECT id FROM notes WHERE id=?').get(id)) throw bad('Note not found.', 404)
  db.prepare('INSERT INTO note_decisions(note,resolved,at) VALUES(?,?,?)').run(id, +resolved, new Date().toISOString())
  return { resolved }
})
app.post('/api/revision/:digest/approve', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + reviewToken)
  const rev = getRevision(req.params)
  const { kind, review } = z.object({ kind: z.enum(['blockout', 'final']), review: draftReviewSchema.optional() }).parse(req.body)
  if (rev.scene.version === 3 && (kind !== 'final' || !review)) throw bad('Record what you checked to approve this exact draft.')
  if (kind === 'final' && rev.scene.version !== 3 && !rev.scene.room) throw bad('Publish a new revision to include the room before final approval.')
  mappings(rev, kind === 'final')
  transaction(() => {
    if (rev.scene.version === 3 && review) {
      const prior = db.prepare('SELECT checked FROM draft_reviews WHERE revision=?').get(rev.digest)
      if (prior && prior.checked !== review.checked) throw bad('This draft already has review evidence.', 409)
      db.prepare('INSERT OR IGNORE INTO draft_reviews VALUES(?,?)').run(rev.digest, review.checked)
    }
    db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?)').run(rev.digest, kind, new Date().toISOString())
  })
  return { kind }
})
app.post('/api/revision/:digest/export', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + reviewToken)
  const rev = getRevision(req.params)
  if (rev.scene.version !== 3 && !rev.scene.room) throw bad('Publish and approve a new revision that includes the room.')
  const approval = db.prepare("SELECT kind,at FROM approvals WHERE revision=? AND kind='final'").get(rev.digest)
  if (!approval) throw bad('Final approval is required.')
  const assets = []
  const blobs: Record<string, string> = {}
  const entries = [...mappings(rev, true).values()]
  const hashCounts = new Map<string, number>()
  for (const { source } of entries) hashCounts.set(source.hash, (hashCounts.get(source.hash) ?? 0) + 1)
  for (const entry of entries) {
    const path = 'assets/' + entry.source.hash + '.glb'
    const { ownerChecked, ...source } = entry.source
    assets.push({ path, source: rev.scene.version !== 1 ? { ...source, ownerChecked } : source,
      ...(entry.legacy && (hashCounts.get(source.hash) ?? 0) > 1 ? { legacy: true } : {}) })
    blobs[path] = entry.file.toString('base64')
  }
  const manifest = { format: 'scene-rehearsal-' + rev.scene.version, revision: rev.scene.version === 3 ? hash(canonical({ parent: rev.parent, scene: rev.scene, links: rev.links })) : rev.digest, parent: rev.parent, links: rev.links, scene: rev.scene, approval, assets,
    ...(rev.scene.version === 3 ? { draftReview: db.prepare('SELECT checked FROM draft_reviews WHERE revision=?').get(rev.digest) } : {}) }
  return { digest: hash(canonical(manifest)), package: { manifest, blobs } }
})
app.post('/api/assets/import', { bodyLimit: 190_000_000 }, async req => {
  requireRole(req.headers.authorization === 'Bearer ' + reviewToken)
  const { bundle, asset, expected } = z.object({
    bundle: z.unknown(), asset: z.string().min(1), expected: sourceIdentity.optional(),
  }).parse(req.body)
  const { bytes, source } = await readAcceptedModel(bundle, asset)
  if (expected && (source.project !== expected.project || source.asset !== expected.asset ||
    source.revision !== expected.revision || source.hash !== expected.hash)) {
    throw bad('The bundle does not match the owner-confirmed Mesh Foundry model revision.')
  }
  return storeModel(bytes, source, Boolean(expected))
})

app.post('/api/agent/assets/import', { bodyLimit: 190_000_000 }, async req => {
  requireRole(req.headers.authorization === 'Bearer ' + authorToken)
  const foundryDir = process.env.MESH_FOUNDRY_DATA_DIR ?? join(homedir(), 'Library/Application Support/Mesh Foundry')
  const { bundle, expected, meshFoundryDataDir } = z.strictObject({
    bundle: z.unknown(),
    meshFoundryDataDir: z.string().refine(isAbsolute, 'Use an absolute Mesh Foundry data directory.').optional(),
    expected: sourceIdentity.extend({ clips: z.array(z.string().min(1)) }),
  }).parse(req.body)
  let foundryPort = Number(process.env.SCENE_REHEARSAL_MESH_FOUNDRY_PORT)
  if (!process.env.SCENE_REHEARSAL_MESH_FOUNDRY_PORT) {
    try {
      const { url } = JSON.parse(readFileSync(join(foundryDir, 'runtime.json'), 'utf8')) as { url: string }
      foundryPort = Number(new URL(url).port)
    } catch { /* not running */ }
  }
  if (!Number.isInteger(foundryPort) || foundryPort < 1024 || foundryPort > 65535 || foundryPort === port) {
    throw bad('Start Mesh Foundry so Scene Rehearsal can find it.', 503)
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(expected.project)) throw bad('Invalid Mesh Foundry project ID.')
  const { bytes, source } = await readAcceptedModel(bundle, expected.asset)
  if (sourceKey(source) !== sourceKey(expected) || JSON.stringify(source.clips) !== JSON.stringify(expected.clips)) {
    throw bad('The bundle does not match the copied model identity and clips.', 409)
  }
  let record: unknown
  try {
    const foundry = 'http://127.0.0.1:' + foundryPort
    const options = { signal: AbortSignal.timeout(5000), redirect: 'error' } as const
    const session = await fetch(foundry + '/api/session', options)
    if (!session.ok) throw Error('Mesh Foundry session request failed.')
    const { dataRoot } = z.object({ dataRoot: z.string().refine(isAbsolute) }).parse(await session.json())
    if (realpathSync(dataRoot) !== realpathSync(meshFoundryDataDir ?? foundryDir)) {
      throw bad('The configured Mesh Foundry service is running a different library than the copied prompt.', 409)
    }
    const response = await fetch(foundry + '/api/projects/' + encodeURIComponent(expected.project), options)
    if (response.status === 404) throw bad('The configured Mesh Foundry library does not contain the source project.', 409)
    if (!response.ok) throw Error('Mesh Foundry request failed.')
    record = await response.json()
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) throw error
    throw bad('Could not read the configured local Mesh Foundry acceptance record.', 503)
  }
  if (sourceKey(acceptedModel(record, expected.asset)) !== sourceKey(expected)) {
    throw bad('Mesh Foundry model acceptance changed. Copy a fresh handoff prompt.', 409)
  }
  return storeModel(bytes, source, true)
})

function storeModel(bytes: Buffer, source: z.infer<typeof sourceSchema>, checked: boolean) {
  const key = sourceKey(source)
  const destination = join(blobDir, source.hash)
  const pending = destination + '.' + randomBytes(8).toString('hex')
  writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 })
  renameSync(pending, destination)
  return transaction(() => {
    const known = resolveSource({ hash: source.hash, source: key })
    const record = sourceSchema.parse({ ...source, ownerChecked: checked || known?.ownerChecked ? true : undefined })
    const serialized = JSON.stringify(record)
    db.prepare('INSERT INTO asset_sources VALUES(?,?) ON CONFLICT(key) DO UPDATE SET source=excluded.source')
      .run(key, serialized)
    db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?)').run(source.hash, serialized)
    const legacy = resolveSource({ hash: source.hash })
    if (legacy && sourceKey(legacy) === key && record.ownerChecked && !legacy.ownerChecked) {
      db.prepare('UPDATE assets SET source=? WHERE hash=?').run(serialized, source.hash)
    }
    return { ...record, sourceKey: key }
  })
}
app.get('/api/assets/:digest', async (req, reply) => {
  const { digest } = params.parse(req.params)
  if (!db.prepare('SELECT hash FROM assets WHERE hash=?').get(digest)) throw bad('Asset not found.', 404)
  const file = readFileSync(join(blobDir, digest))
  if (hash(file) !== digest) throw bad('Asset digest mismatch.')
  return reply.type('model/gltf-binary').send(file)
})
await app.register(serveStatic, { root: join(import.meta.dirname, 'dist') })
app.setNotFoundHandler((req, reply) => req.method === 'GET' && !req.url.startsWith('/api/')
  ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found.' }))
try {
  await app.listen({ host: '127.0.0.1', port })
} catch (error) {
  if ((error as { code?: string }).code !== 'EADDRINUSE' || process.env.SCENE_REHEARSAL_PORT) throw error
  await app.listen({ host: '127.0.0.1', port: 0 })
  port = (app.server.address() as { port: number }).port
  origin = 'http://127.0.0.1:' + port
}
writeFileSync(runtimePath, JSON.stringify({ url: origin, pid: process.pid, dataDir: root }), { mode: 0o600 })
console.log('Scene Rehearsal at ' + origin + '\nData: ' + root)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close()
  db.close()
  rmSync(runtimePath, { force: true })
  rmSync(lockPath, { force: true })
  process.exit(0)
})
