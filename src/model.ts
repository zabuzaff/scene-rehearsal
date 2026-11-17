import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const loomId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
const tick = z.number().int().min(0).max(36000)
export const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
export const sha = z.string().regex(/^[a-f0-9]{64}$/)
const roomSchema = z.array(z.strictObject({
  size: z.tuple([z.number().positive().max(100), z.number().positive().max(100), z.number().positive().max(100)]),
  position: point,
  color: z.number().int().min(0).max(0xffffff),
})).min(1).max(128)

export const defaultRoom: z.infer<typeof roomSchema> = [
  { size: [8.8, .18, 6.6], position: [0, -.13, 0], color: 0xb6bca9 },
  { size: [8.8, 2.25, .14], position: [0, 1, -3.3], color: 0xc3c8b7 },
  { size: [.14, 2.25, 6.6], position: [-4.4, 1, 0], color: 0xd1cdb9 },
  { size: [3.1, 1.2, .05], position: [-1.4, 1.32, -3.20], color: 0x435957 },
  ...[-2.25, -1.55, -.85, -.25].map((x): z.infer<typeof roomSchema>[number] => ({
    size: [.38, .45, .04], position: [x, 1.4, -3.16], color: 0xe5dbc3,
  })),
]

const legacySchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120),
  unit: z.literal('meter'),
  up: z.literal('Y'),
  duration: tick.min(1),
  room: roomSchema.optional(),
  objects: z.array(z.strictObject({
    id, label: z.string().min(1).max(80), position: point,
    kind: z.enum(['researcher', 'desk', 'chair', 'terminal']),
    asset: z.strictObject({ hash: sha, node: z.string().min(1).optional(), clip: z.string().min(1) }).optional(),
    requiresAsset: z.boolean().optional(),
  })).min(1).max(64),
  route: z.array(point).min(2).max(64),
  responder: id,
  station: id,
  rule: z.strictObject({ travelTicks: tick.min(1), inspectTicks: tick.min(1), repeat: z.literal('merge-same-feed') }),
  scenarios: z.array(z.strictObject({
    id, label: z.string().min(1).max(80),
    events: z.array(z.strictObject({ id, tick, feed: id })).max(100),
    checkpoints: z.array(z.strictObject({ tick, activity: z.string(), position: point })).min(1).max(100),
  })).min(1).max(16),
}).superRefine((m, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  const unique = (items: {id: string}[]) => new Set(items.map(item => item.id)).size === items.length
  if (!unique(m.objects) || !unique(m.scenarios)) invalid('Object and scenario IDs must be unique.')
  const actor = m.objects.find(o => o.id === m.responder && o.kind === 'researcher')
  const station = m.objects.find(o => o.id === m.station && o.kind === 'terminal')
  if (!actor || !station) invalid('The responder and terminal must exist.')
  if (actor && !actor.position.every((x, i) => x === m.route[0][i])) invalid('The route must start at the responder.')
  for (const scenario of m.scenarios) {
    if (!unique(scenario.events) || scenario.events.some(e => e.tick > m.duration)) invalid('Invalid scenario events.')
    for (const checkpoint of scenario.checkpoints) {
      const frame = evaluateLegacy(m, scenario.id, checkpoint.tick)
      if (checkpoint.tick > m.duration || frame.activity !== checkpoint.activity || frame.position.some((x, i) => Math.abs(x - checkpoint.position[i]) > 1e-6)) invalid('Scenario checkpoint does not match behavior.')
    }
  }
})
type LegacyManifest = z.infer<typeof legacySchema>
export const ticksPerSecond = 10
export const noteSchema = z.strictObject({
  scenario: id, tick, end: tick.optional(), text: z.string().trim().min(1).max(2000),
  object: loomId.optional(), point: point.optional(), camera: point, target: point,
})

function evaluateLegacy(m: LegacyManifest, scenarioId: string, tick: number) {
  const events = m.scenarios.find(s => s.id === scenarioId)?.events ?? []
  const ordered = [...events].sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const { travelTicks, inspectTicks } = m.rule
  const responseTicks = 2 * travelTicks + inspectTicks
  let start = -Infinity
  let feed = ''
  const trace = []
  for (const e of ordered) {
    if (e.tick > tick) break
    const busy = e.tick < start + responseTicks
    if (!busy) {
      start = e.tick
      feed = e.feed
    }
    trace.push({ ...e, result: !busy ? 'Response started' : e.feed === feed ? 'Merged with active response' : 'Ignored while busy' })
  }
  const elapsed = tick - start
  const activity = elapsed < travelTicks ? 'Walking to terminal' : elapsed < travelTicks + inspectTicks
    ? 'Checking collector' : elapsed < responseTicks ? 'Returning to desk' : 'Researching'
  const progress = elapsed < travelTicks ? elapsed / travelTicks : elapsed < travelTicks + inspectTicks
    ? 1 : elapsed < responseTicks ? (responseTicks - elapsed) / travelTicks : 0
  const segment = progress * (m.route.length - 1)
  const index = Math.min(Math.floor(segment), m.route.length - 2)
  const position = m.route[index].map((n, i) => n + (m.route[index + 1][i] - n) * (segment - index))
  return { activity, position, trace }
}

export const fixture: LegacyManifest = {
  version: 1, title: 'Kairo research office', unit: 'meter', up: 'Y', duration: 280, room: defaultRoom,
  objects: [
    { id: 'maya', label: 'Maya', kind: 'researcher', position: [-2, 0, 1], requiresAsset: true },
    { id: 'rafi', label: 'Rafi', kind: 'researcher', position: [1.8, 0, 1] },
    { id: 'research', label: 'Research desk', kind: 'desk', position: [-2, 0, 0] },
    { id: 'review', label: 'Evidence desk', kind: 'desk', position: [1.8, 0, 0] },
    { id: 'chair', label: 'Research chair', kind: 'chair', position: [-2, 0, 1.45] },
    { id: 'monitor', label: 'Collector station', kind: 'terminal', position: [2.6, 0, -2.6] },
  ],
  route: [[-2, 0, 1], [-3.1, 0, 0.9], [-3.1, 0, -1.65], [2.6, 0, -1.65]],
  responder: 'maya', station: 'monitor',
  rule: { travelTicks: 55, inspectTicks: 35, repeat: 'merge-same-feed' },
  scenarios: [
    { id: 'quiet', label: 'Quiet shift', events: [], checkpoints: [{ tick: 0, activity: 'Researching', position: [-2, 0, 1] }] },
    { id: 'interruption', label: 'Collector interruption', events: [
      { id: 'first', tick: 80, feed: 'sol-1h' }, { id: 'repeat', tick: 105, feed: 'sol-1h' },
    ], checkpoints: [
      { tick: 135, activity: 'Checking collector', position: [2.6, 0, -1.65] },
      { tick: 225, activity: 'Researching', position: [-2, 0, 1] },
    ] },
  ],
}

const activity = z.enum(['quiet', 'outbound', 'inspect', 'return'])
const pose = z.strictObject({ position: point, heading: z.number().min(-Math.PI * 2).max(Math.PI * 2) })
const waypoint = pose.extend({ tick })
const path = z.array(waypoint).min(2).max(64)
const health = z.enum(['unknown', 'healthy', 'delayed', 'offline'])
const freshness = z.enum(['loading', 'current', 'stale', 'unavailable'])
const evidence = z.strictObject({ station: id, health, freshness })
const response = z.enum(['Response started', 'Merged with active response', 'Ignored while busy', 'Evidence updated'])
const actorFrame = pose.extend({ id, activity, clipTick: tick })
const officeEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('alert'), id, tick, feed: id }),
  evidence.extend({ kind: z.literal('evidence'), id, tick, feed: id }),
])
const actor = pose.extend({ id, station: id, task: z.string().min(1).max(120) })
const station = z.strictObject({ id, feed: id, reference: z.string().min(1).max(200), approach: pose })
const bindings = z.partialRecord(activity, z.string().min(1).max(120))
const objectV2 = z.strictObject({
  id, label: z.string().min(1).max(80), position: point,
  kind: z.enum(['researcher', 'desk', 'chair', 'terminal']),
  requiresAsset: z.boolean().optional(),
  requiredActivities: z.array(activity).max(4).optional(),
  asset: z.strictObject({ hash: sha, node: z.string().min(1).optional(), source: sha.optional(), clips: bindings.optional() }).optional(),
})
const checkpoint = z.strictObject({
  tick,
  actors: z.array(actorFrame).length(2),
  evidence: z.array(evidence).length(2),
  trace: z.array(z.strictObject({ id, result: response })).max(100),
})
const officeSchema = z.strictObject({
  version: z.literal(2), title: z.string().trim().min(1).max(120),
  unit: z.literal('meter'), up: z.literal('Y'), duration: tick.min(1),
  room: z.array(roomSchema.element.extend({ id })).min(1).max(128),
  objects: z.array(objectV2).min(4).max(64),
  actors: z.array(actor).length(2),
  stations: z.array(station).length(2),
  responder: id, station: id,
  outbound: path, returning: path,
  inspectTicks: tick.min(1),
  scenarios: z.array(z.strictObject({
    id, label: z.string().min(1).max(80),
    events: z.array(officeEvent).max(100),
    checkpoints: z.array(checkpoint).min(1).max(100),
  })).min(1).max(16),
}).superRefine((scene, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  for (const items of [[...scene.room, ...scene.objects], scene.actors, scene.stations, scene.scenarios]) {
    if (new Set(items.map(item => item.id)).size !== items.length) invalid('Duplicate scene IDs.')
  }
  if (scene.objects.filter(o => o.kind === 'researcher').length !== 2) invalid('The office requires exactly two researchers.')
  if (scene.outbound.at(-1)!.tick + scene.inspectTicks + scene.returning.at(-1)!.tick > scene.duration) {
    invalid('The response must fit within the scene duration.')
  }
  for (const entry of scene.actors) {
    if (!scene.objects.some(o => o.id === entry.id && o.kind === 'researcher' && samePoint(o.position, entry.position)) ||
        !scene.stations.some(s => s.id === entry.station)) invalid('Invalid researcher or work station reference.')
  }
  for (const entry of scene.stations) {
    if (!scene.objects.some(o => o.id === entry.id && (o.kind === 'desk' || o.kind === 'terminal'))) invalid('Invalid station object.')
  }
  const responder = scene.actors.find(a => a.id === scene.responder)
  const target = scene.stations.find(s => s.id === scene.station)
  if (!responder || !target || !scene.objects.some(o => o.id === target.id && o.kind === 'terminal')) {
    invalid('Invalid responder or collector station.')
    return
  }
  for (const [route, start, end] of [[scene.outbound, responder, target.approach], [scene.returning, target.approach, responder]] as const) {
    if (route[0].tick !== 0 || route.some((p, i) => i > 0 && p.tick <= route[i - 1].tick) ||
        !samePose(route[0], start) || !samePose(route.at(-1)!, end)) {
      invalid('Invalid route timing or endpoints.')
      return
    }
  }
  for (const object of scene.objects) {
    const required = object.requiredActivities ?? []
    const clips = object.asset?.clips ?? {}
    if (object.kind === 'researcher' ? object.requiresAsset !== true ||
      !required.includes('quiet') || (object.id === scene.responder && activity.options.some(beat => !required.includes(beat))) :
      required.length > 0 || Object.keys(clips).length > 0) invalid('Invalid asset activities for ' + object.label + '.')
  }
  for (const scenario of scene.scenarios) {
    if (new Set(scenario.events.map(e => e.id)).size !== scenario.events.length ||
        scenario.events.some(e => e.tick > scene.duration || !scene.stations.some(s => s.feed === e.feed &&
          (e.kind === 'alert' || s.id === e.station)))) invalid('Invalid scenario events.')
    for (const expected of scenario.checkpoints) {
      const actual = evaluateOffice(scene, scenario.id, expected.tick)
      if (expected.tick > scene.duration ||
        actual.actors.some((actor, index) => {
          const expectedActor = expected.actors[index]
          return actor.id !== expectedActor.id || actor.activity !== expectedActor.activity ||
            actor.clipTick !== expectedActor.clipTick ||
            Math.abs(actor.heading - expectedActor.heading) > 1e-6 ||
            actor.position.some((value, axis) => Math.abs(value - expectedActor.position[axis]) > 1e-6)
        }) ||
        JSON.stringify(actual.evidence) !== JSON.stringify(expected.evidence) ||
        JSON.stringify(actual.trace.map(({ id, result }) => ({ id, result }))) !== JSON.stringify(expected.trace)) {
        invalid('Scenario checkpoint does not match behavior at tick ' + expected.tick + '.')
      }
    }
  }
})

type OfficeManifest = z.infer<typeof officeSchema>
export const planIdentity = z.strictObject({
  storyboardId: loomId, sceneId: loomId, planId: loomId,
  planRevision: z.union([z.number().int().nonnegative(), loomId]), approvalId: loomId,
})
const intent = z.string().trim().min(1).max(2000)
export const draftReviewSchema = z.strictObject({ checked: intent })
const draftSchema = z.strictObject({
  version: z.literal(3), title: z.string().trim().min(1).max(120),
  unit: z.literal('meter'), up: z.literal('Y'), duration: tick.min(1),
  plan: planIdentity,
  intent, pendingChecks: z.array(intent).max(40),
  objects: z.array(z.strictObject({
    id: loomId, label: z.string().min(1).max(80), position: point,
    kind: z.enum(['box', 'marker']),
    size: roomSchema.element.shape.size,
    scale: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    rotation: point,
    pieces: z.array(loomId).min(1).max(100).optional(),
    asset: objectV2.shape.asset.unwrap().pick({ hash: true, node: true, source: true }).optional(),
  })).min(1).max(128),
  scenarios: z.array(z.strictObject({
    id, label: z.string().min(1).max(80),
    events: z.array(z.strictObject({ id, tick, label: z.string().min(1).max(80), intent,
      route: z.array(point).min(2).max(64).optional(),
      camera: z.strictObject({ position: point, target: point }).optional(),
    })).max(100),
  })).min(1).max(16),
}).superRefine((scene, ctx) => {
  const unique = (ids: string[]) => new Set(ids).size === ids.length
  const pieceIds = scene.objects.flatMap(object => object.pieces ?? [])
  if (!unique([...scene.objects.map(o => o.id), ...pieceIds]) ||
      !unique(scene.scenarios.map(s => s.id)) ||
      scene.scenarios.some(s => !unique(s.events.map(e => e.id)) || s.events.some(e => e.tick > scene.duration))) {
    ctx.addIssue({ code: 'custom', message: 'Use unique object, piece, scenario and cue IDs and keep cues within the draft duration.' })
  }
  if (scene.scenarios.some(s => s.events.some(e => e.camera && samePoint(e.camera.position, e.camera.target)))) {
    ctx.addIssue({ code: 'custom', message: 'A camera cue needs distinct position and target.' })
  }
})

export const manifestSchema = z.discriminatedUnion('version', [legacySchema, officeSchema, draftSchema])
export type Manifest = z.infer<typeof manifestSchema>
export type SceneObject = Manifest['objects'][number]

function samePoint(a: z.infer<typeof point>, b: z.infer<typeof point>) {
  return a.every((value, index) => value === b[index])
}

function samePose(a: z.infer<typeof pose>, b: z.infer<typeof pose>) {
  return samePoint(a.position, b.position) && a.heading === b.heading
}

function routePose(route: z.infer<typeof path>, time: number): z.infer<typeof pose> {
  const index = route.findIndex(p => p.tick > time)
  if (index < 0) return route.at(-1)!
  const from = route[index - 1]
  const to = route[index]
  const progress = (time - from.tick) / (to.tick - from.tick)
  const headingDelta = Math.atan2(Math.sin(to.heading - from.heading), Math.cos(to.heading - from.heading))
  return {
    position: [
      from.position[0] + (to.position[0] - from.position[0]) * progress,
      from.position[1] + (to.position[1] - from.position[1]) * progress,
      from.position[2] + (to.position[2] - from.position[2]) * progress,
    ],
    heading: from.heading + headingDelta * progress,
  }
}

const labels = { quiet: 'Researching', outbound: 'Walking to terminal', inspect: 'Checking collector', return: 'Returning to desk' }

function evaluateOffice(scene: OfficeManifest, scenarioId: string, time: number) {
  const events = [...(scene.scenarios.find(s => s.id === scenarioId)?.events ?? [])]
    .sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const evidenceByStation = new Map(scene.stations.map(s => [s.id, { station: s.id, health: 'unknown', freshness: 'loading' } as z.infer<typeof evidence>]))
  const arrival = scene.outbound.at(-1)!.tick
  const returnStart = arrival + scene.inspectTicks
  const duration = returnStart + scene.returning.at(-1)!.tick
  let started = -Infinity
  let activeFeed = ''
  const trace: { id: string; tick: number; feed: string; result: z.infer<typeof response> }[] = []
  for (const event of events) {
    if (event.tick > time) break
    const { id, tick, feed } = event
    if (event.kind === 'evidence') {
      const prior = evidenceByStation.get(event.station)
      evidenceByStation.set(event.station, {
        station: event.station,
        health: event.freshness === 'current' ? event.health : prior?.health ?? 'unknown',
        freshness: event.freshness,
      })
      trace.push({ id, tick, feed, result: 'Evidence updated' })
      continue
    }
    const busy = tick < started + duration
    trace.push({ id, tick, feed, result: busy ? feed === activeFeed ? 'Merged with active response' : 'Ignored while busy' : 'Response started' })
    if (!busy) {
      started = tick
      activeFeed = feed
    }
  }
  const elapsed = time - started
  const beat = elapsed < arrival ? 'outbound' : elapsed < returnStart ? 'inspect' : elapsed < duration ? 'return' : 'quiet'
  const actors = scene.actors.map((actor): z.infer<typeof actorFrame> => {
    const activity = actor.id === scene.responder ? beat : 'quiet'
    const placement = activity === 'outbound' ? routePose(scene.outbound, elapsed) :
      activity === 'inspect' ? scene.outbound.at(-1)! :
      activity === 'return' ? routePose(scene.returning, elapsed - returnStart) : actor
    const clipTick = activity === 'outbound' ? elapsed : activity === 'inspect' ? elapsed - arrival :
      activity === 'return' ? elapsed - returnStart :
      actor.id === scene.responder && Number.isFinite(started) ? elapsed - duration : time
    return { position: placement.position, heading: placement.heading, id: actor.id, activity, clipTick }
  })
  return { activity: labels[beat], position: actors.find(actor => actor.id === scene.responder)!.position,
    trace, actors, evidence: [...evidenceByStation.values()] }
}

export function evaluate(scene: Manifest, scenario: string, tick: number) {
  if (scene.version === 3) {
    const events = (scene.scenarios.find(s => s.id === scenario)?.events ?? [])
      .filter(event => event.tick <= tick).sort((a, b) => a.tick - b.tick)
    return { activity: events.at(-1)?.label ?? 'Placement preview',
      position: [0, 0, 0], actors: [], evidence: [],
      trace: events.map(event => ({ ...event, feed: event.label, result: event.intent })) }
  }
  return scene.version === 2 ? evaluateOffice(scene, scenario, tick) : {
    ...evaluateLegacy(scene, scenario, tick), actors: [], evidence: [],
  }
}

export function assetClips(asset: NonNullable<SceneObject['asset']>) {
  return 'clip' in asset ? [asset.clip] : 'clips' in asset ? Object.values(asset.clips ?? {}) : []
}

export function missingActivities(object: SceneObject) {
  if (!('requiredActivities' in object)) return []
  const asset = object.asset
  return (object.requiredActivities ?? []).filter(beat => !asset || !('clips' in asset) || !asset.clips?.[beat])
}

export function missingAsset(object: SceneObject) {
  return Boolean('requiresAsset' in object && object.requiresAsset && !object.asset) || missingActivities(object).length > 0
}
