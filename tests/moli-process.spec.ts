import { describe, expect, it } from 'vitest'
import { checkCdpEndpointHealthy, getFreePort } from '../src/moli-process.ts'

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
