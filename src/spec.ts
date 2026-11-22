import { z } from 'zod'
import { canonical, hash } from './handoff.ts'
import { point, sha, type Manifest } from './model.ts'

type Draft = Extract<Manifest, { version: 3 }>
type Vec = z.infer<typeof point>

const vec = point
const round = (n: number) => Math.round(n * 1e6) / 1e6
const rv = (v: Vec): Vec => [round(v[0]), round(v[1]), round(v[2])]
const clearance = z.strictObject({
  id: z.string(), label: z.string(), kind: z.enum(['authored', 'route']),
  center: vec, size: vec, rotationEuler: vec,
  cue: z.strictObject({ scenario: z.string(), event: z.string() }).optional(),
  intersectsPlaceholder: z.boolean(),
})
export const specSchema = z.strictObject({
  format: z.literal('scene-rehearsal-asset-spec'),
  version: z.literal(1),
  units: z.strictObject({ length: z.literal('meter'), up: z.literal('Y'), rotation: z.literal('euler-xyz-radians') }),
  source: z.strictObject({
    draftId: sha, storyboardId: z.string(), sceneId: z.string(), title: z.string(),
    draftRev: z.number().int().positive(), contentDigest: sha,
    approved: z.boolean(), approvedAt: z.string().nullable(), reviewChecked: z.string().nullable(),
  }),
  scaleReference: z.strictObject({ asset: z.string(), label: z.string().optional(), height: z.number().optional() }).nullable(),
  pieces: z.array(z.strictObject({
    id: z.string(), name: z.string(), kind: z.enum(['box', 'marker']),
    includes: z.array(z.string()),
    dimensions: vec,
    position: vec, rotationEuler: vec,
    pivot: z.strictObject({ anchor: z.enum(['base-center', 'center']), position: vec }),
    interactive: z.boolean(),
    animationClips: z.array(z.string()),
    clearance: z.array(clearance),
    cues: z.array(z.strictObject({ scenario: z.string(), event: z.string(), tick: z.number(), label: z.string(), intent: z.string() })),
    placementNotes: z.array(z.string()),
  })),
  warnings: z.array(z.string()),
  specDigest: sha,
})
export type AssetSpec = z.infer<typeof specSchema>

// Three.js Euler XYZ: v' = Rx(Ry(Rz(v))).
function rotate([x, y, z]: Vec, [a, b, c]: Vec): Vec {
  let [px, py, pz] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c), z]
  ;[px, pz] = [px * Math.cos(b) + pz * Math.sin(b), -px * Math.sin(b) + pz * Math.cos(b)]
  ;[py, pz] = [py * Math.cos(a) - pz * Math.sin(a), py * Math.sin(a) + pz * Math.cos(a)]
  return [px, py, pz]
}
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const corners = (position: Vec, dims: Vec, rotation: Vec) => {
  const out: Vec[] = []
  for (const sx of [-.5, .5]) for (const sy of [-.5, .5]) for (const sz of [-.5, .5]) {
    out.push(add(position, rotate([sx * dims[0], sy * dims[1], sz * dims[2]], rotation)))
  }
  return out
}

const walkerRadius = .5
const walkerHeight = 1.8
const stepHeight = .3
const nearMargin = 1.5

// Footprint overlap in plan (SAT) plus a vertical interval test. Exact for Y-rotated boxes, approximate for tilted ones.
function corridorHits(piece: Vec[], pieceAxes: [number, number][], from: Vec, to: Vec, margin: number) {
  const dx = to[0] - from[0]
  const dz = to[2] - from[2]
  const length = Math.hypot(dx, dz)
  const dir: [number, number] = length > 1e-9 ? [dx / length, dz / length] : [1, 0]
  const side: [number, number] = [-dir[1], dir[0]]
  const half = walkerRadius + margin
  const rect = [[-half, -half], [length + half, -half], [length + half, half], [-half, half]]
    .map(([u, v]) => [from[0] + dir[0] * u + side[0] * v, from[2] + dir[1] * u + side[1] * v] as [number, number])
  const poly = piece.map(p => [p[0], p[2]] as [number, number])
  for (const [ax, az] of [dir, side, ...pieceAxes]) {
    const span = (pts: [number, number][]) => pts.reduce<[number, number]>(([lo, hi], [x, z]) => [Math.min(lo, x * ax + z * az), Math.max(hi, x * ax + z * az)], [Infinity, -Infinity])
    const [a0, a1] = span(rect)
    const [b0, b1] = span(poly)
    if (a1 < b0 || b1 < a0) return false
  }
  const floor = Math.min(from[1], to[1]) + stepHeight
  const ceiling = Math.max(from[1], to[1]) + walkerHeight
  const ys = piece.map(p => p[1])
  return Math.max(...ys) > floor && Math.min(...ys) < ceiling
}

export function contentDigest(scene: Draft) {
  return hash(canonical(scene))
}

export function buildAssetSpec(input: {
  draftId: string; draftRev: number; scene: Draft; approvedAt: string | null; reviewChecked: string | null
}): AssetSpec {
  const { scene } = input
  const warnings: string[] = []
  const pieces = scene.objects.map(object => {
    const dims = rv(object.size.map((n, i) => n * object.scale[i]) as Vec)
    const anchor = object.build?.anchor ?? 'base-center'
    const pivot = anchor === 'center' ? object.position : add(object.position, rotate([0, -dims[1] / 2, 0], object.rotation))
    const footprint = corners(object.position, dims, object.rotation)
    const axes = ([[1, 0, 0], [0, 0, 1]] as Vec[]).map(a => rotate(a, object.rotation)).map(([x, , z]) => [x, z] as [number, number])
      .filter(([x, z]) => Math.hypot(x, z) > 1e-6).map(([x, z]) => [x / Math.hypot(x, z), z / Math.hypot(x, z)] as [number, number])
    const clips: string[] = []
    let interactive = false
    const cues: AssetSpec['pieces'][number]['cues'] = []
    const volumes: AssetSpec['pieces'][number]['clearance'] = (object.build?.clearance ?? []).map(c => {
      const center = add(object.position, rotate(c.offset ?? [0, 0, 0], object.rotation))
      return { id: c.id, label: c.label, kind: 'authored' as const, center: rv(center), size: rv(c.size), rotationEuler: rv(object.rotation), intersectsPlaceholder: false }
    })
    const notes = [
      'Build to fit inside ' + dims.join(' x ') + ' m (width x height x depth in the piece frame) with the pivot at the ' + (anchor === 'center' ? 'centre' : 'bottom centre') + '.',
    ]
    if (object.pieces?.length) notes.push('Represents ' + object.pieces.join(', ') + '.')
    if (object.build?.notes) notes.push(object.build.notes)
    for (const scenario of scene.scenarios) for (const event of scenario.events) {
      const target = event.targets?.find(t => t.object === object.id)
      if (target) {
        cues.push({ scenario: scenario.id, event: event.id, tick: event.tick, label: event.label, intent: event.intent })
        if (target.interact || target.clip) interactive = true
        if (target.clip && !clips.includes(target.clip)) clips.push(target.clip)
      }
      if (event.route && !object.build?.walkable) {
        for (let i = 1; i < event.route.length; i++) {
          const [from, to] = [event.route[i - 1], event.route[i]]
          if (!corridorHits(footprint, axes, from, to, nearMargin)) continue
          const hit = corridorHits(footprint, axes, from, to, 0)
          const dx = to[0] - from[0]
          const dz = to[2] - from[2]
          const length = Math.hypot(dx, dz)
          const floor = Math.min(from[1], to[1])
          volumes.push({
            id: scenario.id + '/' + event.id + '/' + i, label: 'Keep clear: ' + event.label + ' walk route', kind: 'route',
            center: rv([(from[0] + to[0]) / 2, floor + walkerHeight / 2, (from[2] + to[2]) / 2]),
            size: rv([length + 2 * walkerRadius, walkerHeight, 2 * walkerRadius]),
            rotationEuler: rv([0, Math.atan2(-dz, dx), 0]),
            cue: { scenario: scenario.id, event: event.id }, intersectsPlaceholder: hit,
          })
          if (hit) warnings.push(object.id + ' intersects the ' + event.label + ' walk route (' + scenario.id + '/' + event.id + ' segment ' + i + '). Move the placeholder, mark it build.walkable, or fix the route.')
        }
      }
    }
    return {
      id: object.id, name: object.label, kind: object.kind, includes: object.pieces ?? [],
      dimensions: dims, position: rv(object.position), rotationEuler: rv(object.rotation),
      pivot: { anchor, position: rv(pivot) },
      interactive, animationClips: clips, clearance: volumes, cues, placementNotes: notes,
    }
  })
  const body = {
    format: 'scene-rehearsal-asset-spec' as const, version: 1 as const,
    units: { length: 'meter' as const, up: 'Y' as const, rotation: 'euler-xyz-radians' as const },
    source: {
      draftId: input.draftId, storyboardId: scene.plan.storyboardId, sceneId: scene.plan.sceneId, title: scene.title,
      draftRev: input.draftRev, contentDigest: contentDigest(scene),
      approved: input.approvedAt !== null, approvedAt: input.approvedAt, reviewChecked: input.reviewChecked,
    },
    scaleReference: scene.scaleReference ?? null,
    pieces, warnings,
  }
  return specSchema.parse({ ...body, specDigest: hash(canonical(body)) })
}
