import { describe, expect, it } from 'vitest'
import { checkCdpEndpointHealthy, getFreePort } from '../src/moli-process.ts'
import { runMoliFetch } from '../src/cli-runner.ts'
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

describe('cli-runner', () => {
  it('throws on non-existent binary', async () => {
    await expect(runMoliFetch({
      moliPath: '/non/existent/moli',
      url: 'http://127.0.0.1:1',
      timeoutMs: 1000,
    })).rejects.toThrow()
  })

  it('aborts on signal', async () => {
    const bin = await resolveMoliBinary()
    const controller = new AbortController()
    controller.abort()

    await expect(runMoliFetch({
      moliPath: bin,
      url: 'http://127.0.0.1:1',
      signal: controller.signal,
    })).rejects.toThrow('aborted')
  })
})
