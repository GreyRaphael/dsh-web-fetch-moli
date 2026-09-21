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

describe('Native CDP client heartbeat', () => {
  /**
   * A NativeCdpBrowser wired to a scripted fake WebSocket. The heartbeat's
   * send() goes through the browser's own pending-request machinery, so the
   * fake answers (or hangs on) probes by method name.
   */
  function browserOverFakeWs(options: {
    respondTo?: (method: string) => boolean
    respondWithError?: (method: string) => boolean
    fireCloseEvent?: boolean
  }): {
    browser: NativeCdpBrowser
    sent: string[]
    disconnectListener: Promise<void>
    disconnectCount: () => number
  } {
    const sent: string[] = []
    const fakeWs = {
      close: () => {
        if (options.fireCloseEvent === true) fakeWs.onclose?.()
      },
      send: (payload: string) => {
        const msg = JSON.parse(payload) as { id: number; method: string }
        sent.push(msg.method)
        if (options.respondTo?.(msg.method) === true || options.respondWithError?.(msg.method) === true) {
          const response = JSON.stringify(options.respondWithError?.(msg.method) === true
            ? { id: msg.id, error: { code: -32601, message: 'Method not found' } }
            : { id: msg.id, result: {} })
          setTimeout(() => fakeWs.onmessage?.({ data: response }), 0)
        }
      },
      onopen: null as null | (() => void),
      onerror: null as null | ((err: unknown) => void),
      onclose: null as null | (() => void),
      onmessage: null as null | ((evt: { data: string }) => void),
    }
    const browser = new NativeCdpBrowser('ws://fake', 'ws://fake')
    ;(browser as unknown as { ws: unknown }).ws = fakeWs
    // init() normally binds onmessage -> handleMessage; do it directly (with
    // `this` bound to the browser) so the fake's probe responses resolve the
    // browser's pending requests.
    const handleMessage = (browser as unknown as { handleMessage: (msg: unknown) => void }).handleMessage.bind(browser)
    fakeWs.onmessage = (evt: { data: string }) => {
      try { handleMessage(JSON.parse(evt.data)) } catch {}
    }
    let notifyDisconnect!: () => void
    let disconnected = 0
    const disconnectListener = new Promise<void>(resolve => { notifyDisconnect = resolve })
    browser.on('disconnected', () => {
      disconnected++
      notifyDisconnect()
    })
    return { browser, sent, disconnectListener, disconnectCount: () => disconnected }
  }

  it('declares a half-open connection dead after consecutive unanswered heartbeats', async () => {
    // Peer never answers anything (half-open): probes stay pending.
    const { browser, sent, disconnectListener } = browserOverFakeWs({ respondTo: () => false })
    const tick = () => (browser as unknown as { heartbeatTick: () => void }).heartbeatTick()

    tick() // probe #1 sent, pending
    expect(sent).toContain('Target.getTargets')
    expect(browser.isConnected()).toBe(true)

    tick() // #1 unanswered: 1 miss (< max)
    expect(browser.isConnected()).toBe(true)

    tick() // #2 unanswered: 2 misses (>= max) -> declared dead
    expect(browser.isConnected()).toBe(false)
    await disconnectListener
  })

  it('treats a CDP method error as a live heartbeat response', async () => {
    const { browser } = browserOverFakeWs({ respondWithError: () => true })
    const tick = () => (browser as unknown as { heartbeatTick: () => void }).heartbeatTick()

    for (let i = 0; i < 4; i++) {
      tick()
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    expect(browser.isConnected()).toBe(true)
    ;(browser as unknown as { stopHeartbeat: () => void }).stopHeartbeat()
  })

  it('notifies disconnected listeners once when close synchronously fires onclose', async () => {
    const { browser, disconnectCount } = browserOverFakeWs({ fireCloseEvent: true })
    await browser.close()
    expect(browser.isConnected()).toBe(false)
    expect(disconnectCount()).toBe(1)
    await browser.close()
    expect(disconnectCount()).toBe(1)
  })

  it('resets the miss counter when the peer answers, staying connected', async () => {
    const { browser, sent } = browserOverFakeWs({ respondTo: () => true })
    const tick = () => (browser as unknown as { heartbeatTick: () => void }).heartbeatTick()

    for (let i = 0; i < 5; i++) {
      tick()
      // Let the fake's queued setTimeout(0) response arrive and reset the
      // pending flag before the next tick (setImmediate would fire first).
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    expect(sent.filter(m => m === 'Target.getTargets').length).toBeGreaterThanOrEqual(5)
    expect(browser.isConnected()).toBe(true)
    ;(browser as unknown as { stopHeartbeat: () => void }).stopHeartbeat()
  })
})
