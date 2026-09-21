import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCdpEndpointHealthy, getFreePort, MoliProcessManager } from '../src/moli-process.ts'
import { resolveMoliBinary } from '../src/moli-resolve.ts'

describe('moli-process', () => {
  it('getFreePort returns an ephemeral port > 1024', async () => {
    const port = await getFreePort()
    expect(port).toBeGreaterThan(1024)
    expect(port).toBeLessThan(65536)
  })

  it('checkCdpEndpointHealthy returns false for dead endpoint', async () => {
    const port = await getFreePort()
    const healthy = await checkCdpEndpointHealthy(`http://127.0.0.1:${port}`, 200)
    expect(healthy).toBe(false)
  })
})

describe('MoliProcessManager disposal and cleanup', () => {
  afterAll(() => {
    vi.restoreAllMocks()
  })

  /** A fake moli executable: stays alive but never serves CDP. */
  function fakeMoliBin(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'moli-fake-'))
    const isWindows = process.platform === 'win32'
    const path = join(dir, isWindows ? 'moli.cmd' : 'moli')
    if (isWindows) {
      writeFileSync(path, `@echo off\n"${process.execPath}" -e "setInterval(() => {}, 1000)"\n`)
    } else {
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`)
      chmodSync(path, 0o755)
    }
    return { path, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
  }

  it('stop() keeps the manager reusable while dispose() permanently rejects ensure()', async () => {
    const manager = new MoliProcessManager()
    await manager.stop()
    // A recoverable stop must not trip the orphan guard. This invalid binary
    // may fail to spawn, but specifically must not fail as disposed.
    const afterStop = await manager.ensure('/definitely/missing/moli', 1).catch(error => error)
    expect(afterStop).toBeInstanceOf(Error)
    expect((afterStop as Error).message).not.toContain('disposed')

    await manager.dispose()
    await expect(manager.ensure('/usr/bin/env', 1)).rejects.toThrow('disposed')
  })

  it('ensure() fails with the disposed reason when dispose() races a start', { timeout: 15_000 }, async () => {
    const { path, cleanup } = fakeMoliBin()
    const manager = new MoliProcessManager()
    try {
      // A dispose racing a start: the fake daemon stays alive (never ready),
      // so the start loop is still polling when stop() flips the flag.
      // Attach the rejection handler immediately: dispose waits for child
      // shutdown while the start loop may reject in parallel.
      const startPromise = manager.ensure(path, 1).then(
        () => { throw new Error('expected start to reject') },
        (error: unknown) => error,
      )
      // Let the start path advance past spawn into its readiness poll.
      await new Promise(resolve => { setTimeout(resolve, 150) })
      await manager.dispose()
      const startError = await startPromise
      expect(startError).toBeInstanceOf(Error)
      expect((startError as Error).message).toContain('disposed')

      // Nothing left registered after the raced start failed.
      await new Promise(resolve => { setTimeout(resolve, 100) })
      expect(manager.currentEndpoint).toBeUndefined()
    } finally {
      await manager.stop().catch(() => {})
      cleanup()
    }
  })

  it('drains daemon stdout so a chatty child cannot wedge on a full pipe', { timeout: 20_000 }, async () => {
    const bin = await resolveMoliBinary().catch(() => null)
    if (bin === null) return // binary unavailable in this environment

    const manager = new MoliProcessManager()
    try {
      // A healthy daemon start exercises the piped stdout drain: if stdout
      // were undrained the daemon could wedge once it prints >64KB.
      const endpoint = await manager.ensure(bin, 2)
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const healthy = await checkCdpEndpointHealthy(endpoint, 1_000)
      expect(healthy).toBe(true)
    } finally {
      await manager.stop()
    }
  })

  it('stop() resolves even when the child ignores SIGTERM and the exit event never fires', { timeout: 10_000 }, async () => {
    // A child that traps SIGTERM and stays alive: stop()'s exit-race promise
    // must still resolve within its hard cap instead of hanging forever.
    const manager = new MoliProcessManager()
    const stubborn = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Let the child install its SIGTERM trap before we try to stop it.
    await new Promise(resolve => { setTimeout(resolve, 300) })
    // Sneak the child in through the same fields the manager owns.
    ;(manager as unknown as { child: typeof stubborn }).child = stubborn
    ;(manager as unknown as { endpoint: string }).endpoint = 'http://127.0.0.1:1'

    const start = Date.now()
    await manager.stop()
    expect(Date.now() - start).toBeLessThan(8_000)

    // Reap the corpse: a signal-killed child has exitCode null but a signal.
    if (stubborn.exitCode === null && !stubborn.killed) stubborn.kill('SIGKILL')
    await new Promise<void>(resolve => {
      if (stubborn.exitCode !== null || stubborn.signalCode !== null) return resolve()
      stubborn.once('exit', () => resolve())
    })
  })
})
