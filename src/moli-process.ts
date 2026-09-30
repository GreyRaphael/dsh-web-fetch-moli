/**
 * Manages the lifecycle of a local `moli serve` child process daemon.
 *
 * Automatically allocates a free port, launches `moli serve`, awaits protocol readiness,
 * and cleanly disposes of the process on plugin unload or failure.
 *
 * @module dsh-web-fetch-moli/moli-process
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'

/** Get an ephemeral free port from the OS network stack. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 9222
      srv.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
    })
    srv.on('error', reject)
  })
}

/** Check whether a CDP server responds on `/json/version`. */
export async function checkCdpEndpointHealthy(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const url = new URL('/json/version', endpoint.startsWith('http') ? endpoint : `http://${endpoint}`)
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Manages the local Moli CDP daemon process (`moli serve`).
 */
export class MoliProcessManager {
  private child: ChildProcess | undefined
  private endpoint: string | undefined
  private starting: Promise<string> | undefined
  private startGeneration = 0
  private stderrBuffer: string[] = []
  private disposed = false

  /** Get the current live endpoint if running. */
  get currentEndpoint(): string | undefined {
    return this.endpoint
  }

  /**
   * Ensure a local Moli serve daemon is running and healthy.
   *
   * @param moliPath - executable binary path.
   * @returns CDP endpoint URL (e.g. `http://127.0.0.1:9222`).
   * @throws after {@link stop} was called — a disposed manager must never
   *   spawn a new daemon nothing will own afterwards (orphan leak).
   */
  async ensure(moliPath: string, maxConcurrency?: number): Promise<string> {
    if (this.disposed) {
      throw new Error('moli process manager is disposed; cannot start a new daemon')
    }

    if (this.child && this.endpoint) {
      const isLive = await checkCdpEndpointHealthy(this.endpoint, 500)
      if (isLive) return this.endpoint
      // Stale or dead process. Stop only this child; the manager remains
      // reusable so ensure() can recover by starting a fresh daemon.
      await this.stop()
      // A concurrent dispose may have raced the recoverable stop.
      if (this.disposed) {
        throw new Error('moli process manager is disposed; cannot start a new daemon')
      }
    }

    if (this.starting) return this.starting

    const generation = ++this.startGeneration
    const startAttempt = (async () => {
      try {
        const port = await getFreePort()
        const endpoint = `http://127.0.0.1:${port}`
        this.stderrBuffer = []

        const args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--layout', '--resource']
        if (typeof maxConcurrency === 'number' && maxConcurrency > 0) {
          args.push('--http-max-concurrent', String(maxConcurrency))
          args.push('--http-max-host-connections', String(maxConcurrency))
        }

        const child = this.spawnDaemon(moliPath, args)
        this.child = child

        // Drain stdout: a piped-but-unread stdout fills the OS pipe buffer
        // (~64KB) and the daemon wedges inside a write() call — the exact
        // "healthy socket, unresponsive engine" failure this guards against.
        child.stdout?.on('data', () => {})

        child.stderr?.on('data', (chunk: Buffer) => {
          this.stderrBuffer.push(chunk.toString('utf-8'))
          if (this.stderrBuffer.length > 50) this.stderrBuffer.shift()
        })

        child.on('error', () => {
          // Ownership check: this child may have been replaced already (a
          // stop() that timed out, then a fresh ensure()); a stale child's
          // late error must not deregister its replacement.
          if (this.child === child) {
            this.child = undefined
            this.endpoint = undefined
          }
        })

        child.on('exit', () => {
          if (this.child === child) {
            this.child = undefined
            this.endpoint = undefined
          }
        })

        // A dispose that raced us between getFreePort() and spawn() must not
        // leave this fresh daemon unowned: kill it here and fail the caller.
        if (this.disposed) {
          this.killTree(child)
          throw new Error('moli process manager is disposed; cannot start a new daemon')
        }

        // Poll /json/version until ready or timeout
        const deadline = Date.now() + 5000
        let ready = false
        while (Date.now() < deadline) {
          // A concurrent stop()/dispose() kills the daemon mid-start; fail
          // with the disposed reason instead of a confusing "not ready".
          if (this.disposed) {
            throw new Error('moli process manager is disposed; cannot start a new daemon')
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            const code = child.exitCode ?? child.signalCode
            const errOutput = this.stderrBuffer.join('')
            throw new Error(`moli serve exited prematurely with code ${code}: ${errOutput}`)
          }
          if (await checkCdpEndpointHealthy(endpoint, 200)) {
            ready = true
            break
          }
          await new Promise(r => setTimeout(r, 50))
        }

        if (!ready) {
          // Ownership check: if a replacement ensure() took over this.child,
          // calling stop() would kill the replacement daemon instead of this one.
          if (this.child === child) {
            await this.stop()
          } else {
            this.killTree(child)
          }
          const errOutput = this.stderrBuffer.join('')
          throw new Error(`moli serve failed to become ready within 5s at ${endpoint}: ${errOutput}`)
        }

        if (this.child !== child) {
          // Ownership check: a stop() or replacement ensure() took over while
          // this attempt was in flight, so this daemon was never registered —
          // no later stop() would ever kill it. Kill it here and fail the
          // caller; a retry joins the live replacement through dedup instead
          // of leaving an orphan daemon next to it.
          this.killTree(child)
          throw new Error('moli serve start was superseded by a stop() or a replacement; retry ensure() to join the live daemon')
        }
        this.endpoint = endpoint
        return endpoint
      } finally {
        // Ownership check for the dedup slot: stop() clears `starting` while
        // this attempt is still winding down, and a later ensure() may have
        // registered its own attempt since — only the latest attempt may
        // clear the slot, or that ensure()'s dedup would be lost and a third
        // daemon could be spawned alongside a live one.
        if (this.startGeneration === generation) this.starting = undefined
      }
    })()

    this.starting = startAttempt
    return startAttempt
  }

  /**
   * Stop the current local Moli daemon while keeping this manager reusable.
   * A later {@link ensure} may start a replacement (for crash recovery).
   */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.endpoint = undefined
    this.starting = undefined

    if (!child) return

    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
        }, 1500)
        await new Promise<void>((resolve) => {
          const exitTimer = setTimeout(resolve, 5_000)
          child.once('exit', () => {
            clearTimeout(killTimer)
            clearTimeout(exitTimer)
            resolve()
          })
        })
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Permanently dispose this manager. Unlike {@link stop}, later ensure calls
   * fail fast so an in-flight plugin teardown cannot resurrect an orphan.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /**
   * Spawn the daemon child process. Protected seam: tests substitute a fake
   * executable on platforms where script-file fakes cannot be spawned
   * (Node's Windows security patch rejects .cmd/.bat without `shell: true`).
   */
  protected spawnDaemon(moliPath: string, args: string[]): ChildProcess {
    return spawn(moliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
  }

  /** Fire-and-forget kill used when a raced spawn must be cleaned up. */
  private killTree(child: ChildProcess): void {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1500)
      }
    } catch {
      // Best-effort
    }
  }
}
