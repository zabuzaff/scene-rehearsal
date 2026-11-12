import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
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

export const manifestSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(120),
  unit: z.literal('meter'),
  up: z.literal('Y'),
  duration: tick.min(1),
  room: roomSchema.optional(),
  objects: z.array(z.strictObject({
    id, label: z.string().min(1).max(80), position: point,
    kind: z.enum(['researcher', 'desk', 'chair', 'terminal']),
    asset: z.strictObject({ hash: sha, clip: z.string().min(1) }).optional(),
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
      const frame = evaluate(m, scenario.id, checkpoint.tick)
      if (checkpoint.tick > m.duration || frame.activity !== checkpoint.activity || frame.position.some((x, i) => Math.abs(x - checkpoint.position[i]) > 1e-6)) invalid('Scenario checkpoint does not match behavior.')
    }
  }
})
export type Manifest = z.infer<typeof manifestSchema>
export const ticksPerSecond = 10
export const noteSchema = z.strictObject({
  scenario: id, tick, end: tick.optional(), text: z.string().trim().min(1).max(2000),
  object: id.optional(), point: point.optional(), camera: point, target: point,
})

export function evaluate(m: Manifest, scenarioId: string, tick: number) {
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

export const fixture: Manifest = {
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
