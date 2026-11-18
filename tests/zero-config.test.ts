import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('the CLI starts and finds the service from the data directory alone', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rehearsal-zero-'))
  const env = { ...process.env, SCENE_REHEARSAL_DATA_DIR: root }
  delete env.SCENE_REHEARSAL_PORT
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['cli.ts', ...args], { env })).stdout)
  let pid: number | undefined
  try {
    // Simultaneous first calls must end up with one service.
    const fresh = await mkdtemp(join(await realpath(tmpdir()), 'rehearsal-race-'))
    const raceEnv = { ...env, SCENE_REHEARSAL_DATA_DIR: fresh }
    const run = () => promisify(execFile)(process.execPath, ['cli.ts', 'list'], { env: raceEnv })
    try {
      await Promise.all([run(), run(), run()])
      const raced = JSON.parse(await readFile(join(fresh, 'runtime.json'), 'utf8')) as { pid: number }
      await run()
      assert.equal(JSON.parse(await readFile(join(fresh, 'runtime.json'), 'utf8')).pid, raced.pid)
      process.kill(raced.pid)
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
    assert.deepEqual((await cli('list')).drafts, [])
    const info = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as { url: string; pid: number }
    pid = info.pid
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual((await cli('list')).drafts, [])
    const again = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
    assert.equal(again.pid, info.pid)
  } finally {
    if (pid) process.kill(pid)
    await new Promise(resolve => setTimeout(resolve, 300))
    await rm(root, { recursive: true, force: true })
  }
})
