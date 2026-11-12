import Fastify from 'fastify'
import serveStatic from '@fastify/static'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { randomBytes, randomInt } from 'node:crypto'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { defaultRoom, fixture, manifestSchema, noteSchema, sha } from './src/model.ts'
import { canonical, hash } from './src/handoff.ts'
import { readAcceptedModel } from './src/mesh.ts'

const root = process.env.SCENE_REHEARSAL_DATA_DIR ?? join(homedir(), 'Library/Application Support/Scene Rehearsal')
const port = Number(process.env.SCENE_REHEARSAL_PORT ?? 4331)
if (!isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local configuration.')
const origin = 'http://127.0.0.1:' + port
if (process.argv.includes('--status')) {
  console.log(JSON.stringify({ root: existsSync(root) ? realpathSync(root) : root, origin, database: join(root, 'review.sqlite') }))
  process.exit(0)
}
mkdirSync(root, { recursive: true, mode: 0o700 })
if (realpathSync(root) !== root) throw Error('Use the canonical data path.')
const blobDir = join(root, 'blobs')
mkdirSync(blobDir, { mode: 0o700, recursive: true })
const db = new DatabaseSync(join(root, 'review.sqlite'))
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS revisions (digest TEXT PRIMARY KEY, parent TEXT, scene TEXT NOT NULL, links TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, revision TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, revision TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS note_decisions (id INTEGER PRIMARY KEY, note INTEGER NOT NULL, resolved INTEGER NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals (revision TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(revision,kind));
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
function saveRevision(parent: string | null, scene: z.infer<typeof manifestSchema>, links: number[]) {
  const digest = hash(canonical({ parent, scene, links }))
  db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?)').run(digest, parent, JSON.stringify(scene), JSON.stringify(links))
  db.prepare('INSERT INTO head VALUES(1,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest').run(digest)
  return digest
}
transaction(() => { if (!head()) saveRevision(null, manifestSchema.parse(fixture), []) })
const tokenPath = join(root, 'author.token')
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
const authorToken = readFileSync(tokenPath, 'utf8')
const app = Fastify({ bodyLimit: 1_000_000 })
let code = ''
let expires = 0
let lastAttempt = 0
const sessions = new Map<string, number>()
const owner = (cookie = '') => {
  const key = cookie.split(/;\s*/).find(value => value.startsWith('rehearsal_owner='))?.slice(16) ?? ''
  return (sessions.get(key) ?? 0) > Date.now()
}
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
function mappings(rev: ReturnType<typeof revision>, required: boolean) {
  const result = new Map()
  for (const object of rev.scene.objects) {
    if (!object.asset) {
      if (required && object.requiresAsset) throw bad('Map the required asset for ' + object.label + '.')
      continue
    }
    const row = db.prepare('SELECT source FROM assets WHERE hash=?').get(object.asset.hash)
    if (!row) throw bad('Mapped asset not found.')
    const source = JSON.parse(String(row.source))
    const file = readFileSync(join(blobDir, source.hash))
    if (!source.clips.includes(object.asset.clip) || hash(file) !== source.hash) throw bad('Mapped asset or clip is invalid.')
    result.set(source.hash, { source, file })
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
app.get('/api/library', async req => ({
  owner: owner(req.headers.cookie), head: head(),
  revisions: db.prepare('SELECT digest, parent, json_extract(scene,\'$.title\') AS title FROM revisions ORDER BY rowid DESC').all(),
}))
app.get('/api/revision/:digest', async req => {
  const rev = getRevision(req.params)
  const notes = db.prepare(`SELECT n.id,n.revision,n.data,
    COALESCE((SELECT resolved FROM note_decisions WHERE note=n.id ORDER BY id DESC LIMIT 1),0) AS resolved
    FROM notes n ORDER BY n.id`).all()
  return { ...rev, owner: owner(req.headers.cookie), notes: notes.filter(n => n.revision === rev.digest || rev.links.includes(Number(n.id)))
    .map(n => ({ id: n.id, revision: n.revision, resolved: Boolean(n.resolved), ...JSON.parse(String(n.data)) })),
    approvals: db.prepare('SELECT kind,at FROM approvals WHERE revision=?').all(rev.digest) }
})
app.post('/api/enroll', async (req, reply) => {
  if (req.headers.origin !== origin || req.headers.authorization) throw bad('Use the owner browser form.', 403)
  const input = z.object({ code: z.string().regex(/^\d{8}$/) }).parse(req.body)
  const now = Date.now()
  if (now - lastAttempt < 1000) throw bad('Wait a moment before retrying.', 429)
  lastAttempt = now
  if (now >= expires || input.code !== code) throw bad('Invalid or expired owner code.', 403)
  expires = 0
  code = ''
  sessions.clear()
  const key = randomBytes(32).toString('hex')
  sessions.set(key, now + 8 * 3600_000)
  return reply.header('Set-Cookie', 'rehearsal_owner=' + key + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800').send({ owner: true })
})
app.post('/api/publish', async req => {
  requireRole(req.headers.authorization === 'Bearer ' + authorToken)
  const input = z.strictObject({ request: z.string().min(1).max(100), parent: sha, scene: manifestSchema, links: z.array(z.number().int().positive()).max(200).default([]) }).parse(req.body)
  return transaction(() => {
    const checksum = hash(canonical(input))
    const previous = db.prepare('SELECT * FROM receipts WHERE id=?').get(input.request)
    if (previous) {
      if (previous.request_hash !== checksum) throw bad('Request ID already used.', 409)
      return { revision: previous.revision }
    }
    if (head() !== input.parent) throw bad('The base revision changed. Read the head before publishing.', 409)
    for (const link of input.links) if (!db.prepare('SELECT id FROM notes WHERE id=?').get(link)) throw bad('Linked note not found.')
    const requiredSlots = revision(input.parent).scene.objects.filter(object => object.requiresAsset)
    if (requiredSlots.some(slot => !input.scene.objects.some(object => object.id === slot.id && object.requiresAsset))) {
      throw bad('This revision must preserve required asset slots.')
    }
    const scene = { ...input.scene, room: input.scene.room ?? defaultRoom }
    const digest = saveRevision(input.parent, scene, input.links)
    mappings(revision(digest), false)
    db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.request, checksum, digest)
    return { revision: digest }
  })
})
app.post('/api/revision/:digest/note', async req => {
  requireRole(owner(req.headers.cookie))
  const rev = getRevision(req.params)
  const note = noteSchema.parse(req.body)
  if (!rev.scene.scenarios.some(s => s.id === note.scenario) || note.tick > rev.scene.duration ||
      (note.end !== undefined && (note.end < note.tick || note.end > rev.scene.duration)) ||
      (note.object && !rev.scene.objects.some(o => o.id === note.object))) throw bad('Invalid pin context.')
  return { id: Number(db.prepare('INSERT INTO notes(revision,data) VALUES(?,?)').run(rev.digest, JSON.stringify(note)).lastInsertRowid) }
})
app.post('/api/note/:id/decision', async req => {
  requireRole(owner(req.headers.cookie))
  const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params)
  const { resolved } = z.object({ resolved: z.boolean() }).parse(req.body)
  if (!db.prepare('SELECT id FROM notes WHERE id=?').get(id)) throw bad('Note not found.', 404)
  db.prepare('INSERT INTO note_decisions(note,resolved,at) VALUES(?,?,?)').run(id, +resolved, new Date().toISOString())
  return { resolved }
})
app.post('/api/revision/:digest/approve', async req => {
  requireRole(owner(req.headers.cookie))
  const rev = getRevision(req.params)
  const { kind } = z.object({ kind: z.enum(['blockout', 'final']) }).parse(req.body)
  if (kind === 'final' && !rev.scene.room) throw bad('Publish a new revision to include the room before final approval.')
  mappings(rev, kind === 'final')
  db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?)').run(rev.digest, kind, new Date().toISOString())
  return { kind }
})
app.post('/api/revision/:digest/export', async req => {
  requireRole(owner(req.headers.cookie))
  const rev = getRevision(req.params)
  if (!rev.scene.room) throw bad('Publish and approve a new revision that includes the room.')
  const approval = db.prepare("SELECT kind,at FROM approvals WHERE revision=? AND kind='final'").get(rev.digest)
  if (!approval) throw bad('Final approval is required.')
  const assets = []
  const blobs: Record<string, string> = {}
  for (const [digest, entry] of mappings(rev, true)) {
    const path = 'assets/' + digest + '.glb'
    assets.push({ path, source: entry.source })
    blobs[path] = entry.file.toString('base64')
  }
  const manifest = { format: 'scene-rehearsal-1', revision: rev.digest, parent: rev.parent, links: rev.links, scene: rev.scene, approval, assets }
  return { digest: hash(canonical(manifest)), package: { manifest, blobs } }
})
app.post('/api/assets/import', { bodyLimit: 190_000_000 }, async req => {
  requireRole(owner(req.headers.cookie))
  const { bundle, asset } = z.object({ bundle: z.unknown(), asset: z.string().min(1) }).parse(req.body)
  const { bytes, source } = await readAcceptedModel(bundle, asset)
  const destination = join(blobDir, source.hash)
  const pending = destination + '.' + randomBytes(8).toString('hex')
  writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 })
  renameSync(pending, destination)
  const previous = db.prepare('SELECT source FROM assets WHERE hash=?').get(source.hash)
  if (previous && String(previous.source) !== JSON.stringify(source)) throw bad('These bytes already have a different source record.', 409)
  db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?)').run(source.hash, JSON.stringify(source))
  return source
})
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
await app.listen({ host: '127.0.0.1', port })
console.log('Scene Rehearsal at ' + origin + '\nData: ' + root)
if (process.stdin.isTTY) {
  console.log('Press Enter here for a one-time owner enrollment code.')
  createInterface({ input: process.stdin }).on('line', () => {
    code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    expires = Date.now() + 120_000
    console.log('Owner code (valid for two minutes): ' + code)
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await app.close()
  db.close()
  process.exit(0)
})
