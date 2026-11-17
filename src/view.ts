export type Vec = [number, number, number]
export type View = { camera: Vec; target: Vec }
export type Pick = { object?: string; point: Vec }
export const defaultView: View = { camera: [8.5, 9.5, 11.5], target: [0, 0, 0] }

export function draftOverview(objects: { position: Vec; size: Vec; scale: Vec }[]): View {
  const min: Vec = [Infinity, Infinity, Infinity]
  const max: Vec = [-Infinity, -Infinity, -Infinity]
  for (const { position, size, scale } of objects) {
    // A bounding sphere encloses the proxy at any authored orientation.
    const radius = Math.hypot(...size.map((length, axis) => length * scale[axis])) / 2
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], position[axis] - radius)
      max[axis] = Math.max(max[axis], position[axis] + radius)
    }
  }
  const target = min.map((value, axis) => (value + max[axis]) / 2) as Vec
  const distance = Math.max(1, Math.hypot(...max.map((value, axis) => value - min[axis])))
  return { target, camera: target.map((value, axis) => value + [.8, .65, 1][axis] * distance) as Vec }
}
