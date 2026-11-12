declare module 'gltf-validator' {
  export default {
    validateBytes(bytes: Uint8Array, options: { maxIssues: number }): Promise<{ issues: { numErrors: number } }>
  }
}
