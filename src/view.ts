export type Vec = [number, number, number]
export type View = { camera: Vec; target: Vec }
export type Pick = { object?: string; point: Vec }
export const defaultView: View = { camera: [8.5, 9.5, 11.5], target: [0, 0, 0] }
