import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { checkCdpEndpointHealthy, getFreePort, MoliProcessManager } from '../src/moli-process.ts'
import { resolveMoliBinary } from '../src/moli-resolve.ts'

/**
 * A stay-alive daemon double that never serves CDP, so `ensure`'s readiness
 * poll keeps looping — the state the lifecycle races must interrupt. Its
 * SIGTERM trap turns `stop()`'s kill into a clean exit the poll can observe
 * via `exitCode !== null` (a signal-killed child leaves `exitCode` null).
 */
const FAKE_DAEMON_CODE = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'

/** The lingering variant: exits cleanly only 1.2s after its SIGTERM. */
const LINGERING_DAEMON_CODE = 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1200)); setInterval(() => {}, 1000)'

/** SIGKILL the survivors of `children` and resolve once every child is reaped. */
async function reap(children: ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  })))
}

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

  /**
   * A manager whose daemon is a real stay-alive node child (spawned from the
   * platform's own node binary — a real executable, never a .cmd/.bat script,
   * which Node's Windows security patch rejects without `shell: true` with
   * EINVAL). The child never serves CDP, so `ensure`'s readiness poll keeps
   * looping — exactly the state the dispose race must interrupt.
   */
  class FakeDaemonManager extends MoliProcessManager {
    children: ChildProcess[] = []

    /** The stay-alive script for the child about to be spawned. */
    protected daemonCode(_index: number): string {
      return FAKE_DAEMON_CODE
    }

    protected spawnDaemon(_moliPath: string, _args: string[]): ChildProcess {
      const child = spawn(process.execPath, ['-e', this.daemonCode(this.children.length)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.children.push(child)
      return child
    }

    /** The manager's live child reference (the private field under test). */
    get childRef(): ChildProcess | undefined {
      return (this as unknown as { child?: ChildProcess }).child
    }

    /** The manager's in-flight start attempt (the private field under test). */
    get startingRef(): Promise<string> | undefined {
      return (this as unknown as { starting?: Promise<string> }).starting
    }

    async killAll(): Promise<void> {
      await reap(this.children)
    }
  }

  /**
   * A manager whose FIRST daemon lingers: it traps SIGTERM and exits 1.2s
   * later — long enough for a replacement `ensure()` to take over the child
   * reference, so the first child's `exit` event lands while a newer child is
   * already registered (the stale-exit race).
   */
  class LingeringFirstDaemonManager extends FakeDaemonManager {
    protected override daemonCode(index: number): string {
      return index === 0 ? LINGERING_DAEMON_CODE : FAKE_DAEMON_CODE
    }
  }

  /** Poll until the manager has spawned `count` fake daemons. */
  async function waitForChildren(manager: FakeDaemonManager, count: number): Promise<void> {
    for (let i = 0; i < 200 && manager.children.length < count; i += 1) {
      await new Promise(resolve => { setTimeout(resolve, 20) })
    }
    expect(manager.children.length).toBeGreaterThanOrEqual(count)
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
    const manager = new FakeDaemonManager()
    try {
      // A dispose racing a start: the fake daemon stays alive (never ready),
      // so the start loop is still polling when stop() flips the flag.
      // Attach the rejection handler immediately: dispose waits for child
      // shutdown while the start loop may reject in parallel.
      const startPromise = manager.ensure('/fake/moli', 1).then(
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
      await manager.killAll()
    }
  })

  it('a superseded start attempt must not clear the replacement attempt\'s dedup slot', { timeout: 15_000 }, async () => {
    const manager = new FakeDaemonManager()
    const pending: Array<Promise<unknown>> = []
    try {
      const first = manager.ensure('/fake/moli', 1).catch((error: unknown) => error)
      pending.push(first)
      await waitForChildren(manager, 1)
      // Let the daemon boot so its SIGTERM trap is installed: the stop()
      // below must land as a clean exit the poll observes via
      // `exitCode !== null`, not a signal death that leaves the poll running
      // to its 5s deadline (whose recovery stop() would clobber the
      // replacement this test is about).
      await new Promise(resolve => { setTimeout(resolve, 300) })

      // stop() kills the daemon and clears the dedup slot while the first
      // attempt is still winding down; the replacement registers its own
      // attempt in the same tick.
      const stopping = manager.stop()
      pending.push(manager.ensure('/fake/moli', 1).catch((error: unknown) => error))
      expect(manager.startingRef).toBeDefined()

      await stopping
      const firstError = await first
      expect(firstError).toBeInstanceOf(Error)
      // The superseded attempt failed via its fast path (the daemon's clean
      // exit), so only its `finally` — the code under test — can touch the
      // replacement's dedup slot.
      expect((firstError as Error).message).toContain('exited prematurely')
      expect(manager.startingRef).toBeDefined()

      // Dedup still holds: a further ensure() joins the replacement attempt
      // instead of spawning a third daemon next to the live one.
      pending.push(manager.ensure('/fake/moli', 1).catch((error: unknown) => error))
      await new Promise(resolve => { setTimeout(resolve, 300) })
      expect(manager.children.length).toBe(2)
    } finally {
      await manager.stop()
      await Promise.allSettled(pending)
      await reap(manager.children)
    }
  })

  it('a stale daemon\'s late exit must not clear the replacement\'s child reference', { timeout: 15_000 }, async () => {
    const manager = new LingeringFirstDaemonManager()
    const pending: Array<Promise<unknown>> = []
    try {
      pending.push(manager.ensure('/fake/moli', 1).catch((error: unknown) => error))
      await waitForChildren(manager, 1)
      // Let the daemon boot so its delayed-exit SIGTERM trap is installed
      // before stop() fires; otherwise the signal would kill it outright and
      // its exit would land before — not after — the replacement registers.
      await new Promise(resolve => { setTimeout(resolve, 300) })

      // stop() lingers on the first child's delayed exit; the replacement
      // ensure() takes over the child reference long before that exit lands.
      const stopping = manager.stop()
      pending.push(manager.ensure('/fake/moli', 1).catch((error: unknown) => error))
      await waitForChildren(manager, 2)
      expect(manager.childRef).toBe(manager.children[1])

      // The first child has now exited — its stale handler must not
      // deregister the live replacement.
      await stopping
      expect(manager.children[0]?.exitCode).toBe(0)
      expect(manager.childRef).toBe(manager.children[1])
    } finally {
      await manager.stop()
      await Promise.allSettled(pending)
      await reap(manager.children)
    }
  })

  it('detects premature death from an untrapped signal immediately without waiting for timeout', { timeout: 10_000 }, async () => {
    class UntrappedDaemonManager extends FakeDaemonManager {
      protected override daemonCode(): string {
        return 'setInterval(() => {}, 1000)'
      }
    }
    const manager = new UntrappedDaemonManager()
    try {
      const starting = manager.ensure('/fake/moli', 1).catch((error: unknown) => error)
      await waitForChildren(manager, 1)
      const child = manager.children[0]
      expect(child).toBeDefined()

      // Kill the child with a signal (leaves exitCode null and signalCode non-null)
      const t0 = Date.now()
      child?.kill('SIGTERM')

      const error = await starting
      const elapsed = Date.now() - t0
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('exited prematurely with code SIGTERM')
      // Failed fast on the signal exit instead of polling for the full 5s timeout
      expect(elapsed).toBeLessThan(2_500)
    } finally {
      await manager.killAll()
    }
  })

  it('a superseded start attempt that times out must not kill the replacement daemon', { timeout: 15_000 }, async () => {
    const manager = new FakeDaemonManager()
    const pending: Array<Promise<unknown>> = []
    try {
      // First attempt: child never serves CDP and never becomes ready
      const first = manager.ensure('/fake/moli', 1).catch((error: unknown) => error)
      pending.push(first)
      await waitForChildren(manager, 1)
      const firstChild = manager.children[0]
      expect(firstChild).toBeDefined()

      // A replacement attempt takes over this.child while the first attempt is still polling
      const secondChild = manager['spawnDaemon']('/fake/moli', [])
      manager['child'] = secondChild
      manager['startGeneration']++

      // First attempt times out after 5s; its !ready handler must not kill secondChild!
      const firstError = await first
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toContain('failed to become ready')

      // Second child must still be alive and retained as the manager child!
      expect(manager.childRef).toBe(secondChild)
      expect(secondChild?.exitCode).toBeNull()
      expect(secondChild?.signalCode).toBeNull()
    } finally {
      await manager.killAll()
      await Promise.allSettled(pending)
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
