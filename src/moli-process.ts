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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  private stderrBuffer: string[] = []

  /** Get the current live endpoint if running. */
  get currentEndpoint(): string | undefined {
    return this.endpoint
  }

  /**
   * Ensure a local Moli serve daemon is running and healthy.
   *
   * @param moliPath - executable binary path.
   * @returns CDP endpoint URL (e.g. `http://127.0.0.1:9222`).
   */
  async ensure(moliPath: string): Promise<string> {
    if (this.child && this.endpoint) {
      const isLive = await checkCdpEndpointHealthy(this.endpoint, 500)
      if (isLive) return this.endpoint
      // Stale or dead process
      await this.stop()
    }

    if (this.starting) return this.starting

    const startAttempt = (async () => {
      try {
        const port = await getFreePort()
        const endpoint = `http://127.0.0.1:${port}`
        this.stderrBuffer = []

        const cacheDir = path.join(os.homedir(), '.cache', 'moli', 'http-cache')
        try { fs.mkdirSync(cacheDir, { recursive: true }) } catch {}

        const child = spawn(
          moliPath,
          ['serve', '--host', '127.0.0.1', '--port', String(port), '--layout', '--resource', '--http-cache-dir', cacheDir],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          },
        )
        this.child = child

        child.stderr?.on('data', (chunk: Buffer) => {
          this.stderrBuffer.push(chunk.toString('utf-8'))
          if (this.stderrBuffer.length > 50) this.stderrBuffer.shift()
        })

        child.on('error', (err) => {
          this.child = undefined
          this.endpoint = undefined
        })

        child.on('exit', (code, sig) => {
          this.child = undefined
          this.endpoint = undefined
        })

        // Poll /json/version until ready or timeout
        const deadline = Date.now() + 5000
        let ready = false
        while (Date.now() < deadline) {
          if (child.exitCode !== null) {
            const errOutput = this.stderrBuffer.join('')
            throw new Error(`moli serve exited prematurely with code ${child.exitCode}: ${errOutput}`)
          }
          if (await checkCdpEndpointHealthy(endpoint, 200)) {
            ready = true
            break
          }
          await new Promise(r => setTimeout(r, 50))
        }

        if (!ready) {
          await this.stop()
          const errOutput = this.stderrBuffer.join('')
          throw new Error(`moli serve failed to become ready within 5s at ${endpoint}: ${errOutput}`)
        }

        this.endpoint = endpoint
        return endpoint
      } finally {
        this.starting = undefined
      }
    })()

    this.starting = startAttempt
    return startAttempt
  }

  /**
   * Stop the local Moli serve daemon.
   */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.endpoint = undefined
    this.starting = undefined

    if (!child) return

    try {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL')
          }
        }, 1500)
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            clearTimeout(killTimer)
            resolve()
          })
        })
      }
    } catch {
      // Best-effort
    }
  }
}
