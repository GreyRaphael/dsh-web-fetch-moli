/**
 * Unit & integration tests for the native WebSocket CDP client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectCdp, NativeCdpBrowser, NativeCdpContext, NativeCdpPage } from '../src/cdp-client.ts'
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

describe('Native CDP client failure cleanup', () => {
  function fakeBrowser(send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>): {
    browser: NativeCdpBrowser
    registerSession: ReturnType<typeof vi.fn>
    unregisterSession: ReturnType<typeof vi.fn>
  } {
    const registerSession = vi.fn()
    const unregisterSession = vi.fn()
    const browser = {
      send: vi.fn(send),
      registerSession,
      unregisterSession,
    } as unknown as NativeCdpBrowser
    return { browser, registerSession, unregisterSession }
  }

  it('closes and unregisters a target when page initialization fails', async () => {
    const calls: string[] = []
    const { browser, registerSession, unregisterSession } = fakeBrowser(async (method) => {
      calls.push(method)
      if (method === 'Target.createTarget') return { targetId: 'target-1' }
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' }
      if (method === 'Runtime.enable') throw new Error('runtime unavailable')
      return {}
    })
    const context = new NativeCdpContext(browser)

    await expect(context.newPage()).rejects.toThrow('runtime unavailable')
    expect(registerSession).toHaveBeenCalledOnce()
    expect(unregisterSession).toHaveBeenCalledWith('session-1', 'target-1')
    expect(calls).toContain('Target.closeTarget')
  })

  it('does not leave a navigation timeout rejection behind when Page.navigate fails early', async () => {
    const { browser } = fakeBrowser(async (method) => {
      if (method === 'Page.navigate') return { errorText: 'blocked by client' }
      return {}
    })
    const context = new NativeCdpContext(browser)
    const page = new NativeCdpPage(context, 'target-2', 'session-2')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(page.goto('https://example.com', { timeout: 10 })).rejects.toThrow('blocked by client')
      await new Promise(resolve => { setTimeout(resolve, 30) })
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('preserves the final frame URL after an HTTP redirect', async () => {
    let page!: NativeCdpPage
    const { browser } = fakeBrowser(async (method) => {
      if (method === 'Page.navigate') {
        page.handleEvent('Page.frameNavigated', {
          frame: { id: 'main-frame', url: 'https://final.example.com/article' },
        })
        page.handleEvent('Page.domContentEventFired', {})
        return { frameId: 'main-frame' }
      }
      return {}
    })
    const context = new NativeCdpContext(browser)
    page = new NativeCdpPage(context, 'target-3', 'session-3')

    await page.goto('https://origin.example.com/redirect', { timeout: 100 })
    expect(page.url()).toBe('https://final.example.com/article')
  })
})
