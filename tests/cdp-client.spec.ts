/**
 * Unit & integration tests for the native WebSocket CDP client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectCdp, NativeCdpBrowser, NativeCdpPage } from '../src/cdp-client.ts'
import { resolveMoliBinary } from '../src/moli-resolve.ts'
import { MoliProcessManager } from '../src/moli-process.ts'

describe('Native CDP Client', () => {
  let moliPath = ''
  let processManager: MoliProcessManager | undefined

  beforeAll(async () => {
    try {
      moliPath = await resolveMoliBinary()
    } catch {
      // Moli not available
    }
  })

  afterAll(async () => {
    if (processManager) {
      await processManager.stop()
    }
  })

  it('rejects with descriptive error on unreachable endpoint', async () => {
    await expect(connectCdp('127.0.0.1:1', 500)).rejects.toThrow(/127\.0\.0\.1:1/)
  })

  it('connects to real Moli CDP and performs browser/context/page operations', async () => {
    if (!moliPath) return

    processManager = new MoliProcessManager()
    const endpoint = await processManager.ensure(moliPath)

    const browser = await connectCdp(endpoint, 5000)
    expect(browser).toBeInstanceOf(NativeCdpBrowser)

    const context = await browser.newContext()
    expect(context).toBeDefined()

    const page = await context.newPage()
    expect(page).toBeInstanceOf(NativeCdpPage)
    expect(page.url()).toBe('about:blank')

    const evalRes = await page.evaluate!('1 + 1')
    expect(evalRes).toBe(2)

    const titleRes = await page.evaluate!('document.title = "Test Page"; document.title')
    expect(titleRes).toBe('Test Page')

    const content = await page.content()
    expect(content).toContain('<title>Test Page</title>')

    await page.close()
    await context.close()
    await browser.close()
  })
})
