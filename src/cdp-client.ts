/**
 * Ultra-lightweight native CDP (Chrome DevTools Protocol) client.
 *
 * Implements CdpBrowser, CdpContext, CdpPage, and CdpResponse using Node.js
 * native fetch and WebSocket — zero third-party dependencies.
 *
 * @module dsh-web-fetch-moli/cdp-client
 */

import type {
  CdpBrowser,
  CdpContext,
  CdpPage,
  CdpRequest,
  CdpResponse,
  CdpRoute,
  CdpSession,
} from './types.ts'

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: NodeJS.Timeout
}

/**
 * Connect to a browser over CDP via native WebSocket.
 *
 * @param endpoint - HTTP or WS endpoint (e.g. '127.0.0.1:9222', 'http://127.0.0.1:9222', 'ws://...')
 * @param timeoutMs - connection timeout in milliseconds
 * @returns CdpBrowser instance
 */
export async function connectCdp(endpoint: string, timeoutMs = 30000): Promise<CdpBrowser> {
  let wsUrl = endpoint.trim()

  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    const httpOrigin = wsUrl.startsWith('http://') || wsUrl.startsWith('https://')
      ? wsUrl
      : `http://${wsUrl}`

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)

    try {
      const versionRes = await fetch(`${httpOrigin}/json/version`, { signal: controller.signal })
      if (!versionRes.ok) {
        throw new Error(`HTTP ${versionRes.status}: ${versionRes.statusText}`)
      }
      const data = await versionRes.json() as { webSocketDebuggerUrl?: string }
      if (!data.webSocketDebuggerUrl) {
        throw new Error('endpoint returned no webSocketDebuggerUrl')
      }
      wsUrl = data.webSocketDebuggerUrl
    } catch (err: unknown) {
      clearTimeout(timer)
      throw new Error(`cannot connect to CDP endpoint at "${endpoint}": ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  const browser = new NativeCdpBrowser(wsUrl, endpoint)
  await browser.init(timeoutMs)
  return browser
}

export class NativeCdpBrowser implements CdpBrowser {
  private ws!: WebSocket
  private seq = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly sessions = new Map<string, NativeCdpPage>()
  private readonly targetToPage = new Map<string, NativeCdpPage>()
  private readonly defaultCtx: NativeCdpContext
  private isClosed = false

  constructor(
    private readonly wsUrl: string,
    public readonly endpoint: string,
  ) {
    this.defaultCtx = new NativeCdpContext(this, undefined)
  }

  async init(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.ws.close() } catch {}
        reject(new Error(`cannot connect to CDP endpoint at "${this.endpoint}": connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      try {
        this.ws = new WebSocket(this.wsUrl)
      } catch (err) {
        clearTimeout(timer)
        reject(new Error(`cannot connect to CDP endpoint at "${this.endpoint}": ${err instanceof Error ? err.message : String(err)}`))
        return
      }

      this.ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }

      this.ws.onerror = (err) => {
        clearTimeout(timer)
        reject(new Error(`cannot connect to CDP endpoint at "${this.endpoint}": WebSocket error ${String(err)}`))
      }

      this.ws.onclose = () => {
        this.handleDisconnect()
      }

      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as CdpMessage
          this.handleMessage(msg)
        } catch {
          // ignore malformed frame
        }
      }
    })

    // Enable Target domain on browser level to discover popups and targets
    await this.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.isClosed) {
      throw new Error('Target closed')
    }

    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 60000)

      this.pending.set(id, { resolve, reject, timer })

      const payload: Record<string, unknown> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId

      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  registerSession(sessionId: string, page: NativeCdpPage): void {
    this.sessions.set(sessionId, page)
    this.targetToPage.set(page.targetId, page)
  }

  unregisterSession(sessionId: string, targetId: string): void {
    this.sessions.delete(sessionId)
    this.targetToPage.delete(targetId)
  }

  private handleMessage(msg: CdpMessage): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)!
      clearTimeout(timer)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
      return
    }

    // Event routing
    if (msg.sessionId) {
      const session = this.sessions.get(msg.sessionId)
      if (session) {
        session.handleEvent(msg.method ?? '', msg.params ?? {})
      }
      return
    }

    // Browser-level events
    if (msg.method === 'Target.targetCreated') {
      const targetInfo = msg.params?.targetInfo as { targetId?: string; openerId?: string; type?: string } | undefined
      if (targetInfo?.openerId && targetInfo.targetId) {
        const parentPage = this.targetToPage.get(targetInfo.openerId)
        if (parentPage) {
          parentPage.handlePopupCreated(targetInfo.targetId)
        }
      }
    }
  }

  private readonly disconnectListeners = new Set<() => void>()

  isConnected(): boolean {
    return !this.isClosed
  }

  on(event: 'disconnected', listener: () => void): void {
    if (event === 'disconnected') {
      this.disconnectListeners.add(listener)
    }
  }

  private handleDisconnect(): void {
    this.isClosed = true
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer)
      reject(new Error('Target closed'))
    }
    this.pending.clear()
    for (const listener of this.disconnectListeners) {
      try { listener() } catch {}
    }
  }

  async newContext(): Promise<CdpContext> {
    if (this.isClosed) throw new Error('Target closed')
    const res = await this.send('Target.createBrowserContext') as { browserContextId?: string }
    return new NativeCdpContext(this, res.browserContextId)
  }

  contexts(): CdpContext[] {
    return [this.defaultCtx]
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    try {
      this.ws.close()
    } catch {}
  }
}

export class NativeCdpContext implements CdpContext {
  private isClosed = false
  private readonly routeHandlers: Array<{ pattern: RegExp; handler: (route: CdpRoute) => Promise<void> }> = []

  constructor(
    public readonly browser: NativeCdpBrowser,
    public readonly browserContextId?: string,
  ) {}

  async newPage(): Promise<CdpPage> {
    if (this.isClosed) throw new Error('Target closed')

    const createParams: Record<string, unknown> = { url: 'about:blank' }
    if (this.browserContextId) createParams.browserContextId = this.browserContextId

    const targetRes = await this.browser.send('Target.createTarget', createParams) as { targetId: string }
    const targetId = targetRes.targetId

    const attachRes = await this.browser.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }
    const sessionId = attachRes.sessionId

    const page = new NativeCdpPage(this, targetId, sessionId)
    this.browser.registerSession(sessionId, page)

    await page.init()

    // Apply context route handlers if any
    for (const { pattern, handler } of this.routeHandlers) {
      await page.addRoute(pattern, handler)
    }

    return page
  }

  async route(glob: string, handler: (route: CdpRoute) => Promise<void>): Promise<void> {
    const pattern = globToRegExp(glob)
    this.routeHandlers.push({ pattern, handler })
  }

  async newCDPSession(page: CdpPage): Promise<CdpSession> {
    if (this.isClosed) throw new Error('Target closed')
    const nativePage = page as NativeCdpPage
    return {
      send: (method: string, params?: Record<string, unknown>) => nativePage.send(method, params),
      detach: async () => {},
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    if (this.browserContextId) {
      await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }).catch(() => {})
    }
  }
}

export class NativeCdpPage implements CdpPage {
  private isClosed = false
  private currentUrl = 'about:blank'
  private mainFrameId = ''
  private readonly responseListeners = new Set<(response: CdpResponse) => void>()
  private readonly popupListeners = new Set<(page: CdpPage) => void>()
  private readonly routeHandlers: Array<{ pattern: RegExp; handler: (route: CdpRoute) => Promise<void> }> = []
  private fetchEnabled = false

  // Lifecycle waiters
  private domContentLoaded = false
  private domContentWaiters: Array<() => void> = []
  private loadFired = false
  private loadWaiters: Array<() => void> = []
  private inFlightRequests = new Set<string>()
  private networkIdleWaiters: Array<() => void> = []
  private networkIdleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly ctx: NativeCdpContext,
    public readonly targetId: string,
    public readonly sessionId: string,
  ) {}

  private triggerDomContentLoaded(): void {
    if (this.domContentLoaded) return
    this.domContentLoaded = true
    const waiters = this.domContentWaiters.splice(0)
    for (const w of waiters) w()
  }

  private triggerLoadFired(): void {
    this.triggerDomContentLoaded()
    if (this.loadFired) return
    this.loadFired = true
    const waiters = this.loadWaiters.splice(0)
    for (const w of waiters) w()
  }

  async init(): Promise<void> {
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Network.enable'),
    ])

    const tree = await this.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string; url?: string } } }
    if (tree?.frameTree?.frame?.id) {
      this.mainFrameId = tree.frameTree.frame.id
      if (tree.frameTree.frame.url) {
        this.currentUrl = tree.frameTree.frame.url
      }
    }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.isClosed) throw new Error('Target closed')
    return this.ctx.browser.send(method, params, this.sessionId)
  }

  url(): string {
    return this.currentUrl
  }

  context(): CdpContext {
    return this.ctx
  }

  mainFrame(): unknown {
    return this.mainFrameId
  }

  async goto(
    url: string,
    options?: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number },
  ): Promise<CdpResponse | null> {
    if (this.isClosed) throw new Error('Target closed')

    const timeout = options?.timeout ?? 30000
    const waitUntil = options?.waitUntil ?? 'domcontentloaded'

    this.domContentLoaded = false
    this.loadFired = false
    this.inFlightRequests.clear()
    if (this.networkIdleTimer) {
      clearTimeout(this.networkIdleTimer)
      this.networkIdleTimer = null
    }

    let targetResponse: CdpResponse | null = null
    const responseHandler = (res: CdpResponse) => {
      const resUrl = typeof res.url === 'function' ? res.url() : ''
      const resType = res.request?.()?.resourceType?.()
      const isNav = res.request?.()?.isNavigationRequest?.()
      if ((resType === 'document' || !resType) && (resUrl === url || isNav)) {
        targetResponse = res
      }
    }
    this.responseListeners.add(responseHandler)

    let pollTimer: NodeJS.Timeout | null = null

    try {
      const waitPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pollTimer) clearInterval(pollTimer)
          reject(new Error(`Navigation timeout of ${timeout}ms exceeded: ${url}`))
        }, timeout)

        const onDone = () => {
          clearTimeout(timer)
          if (pollTimer) clearInterval(pollTimer)
          resolve()
        }

        if (waitUntil === 'domcontentloaded') {
          if (this.domContentLoaded) onDone()
          else this.domContentWaiters.push(onDone)
        } else {
          if (this.loadFired) onDone()
          else this.loadWaiters.push(onDone)
        }
      })

      const navRes = await this.send('Page.navigate', { url }) as { frameId?: string; errorText?: string }
      if (navRes?.errorText) {
        throw new Error(`cannot navigate to ${url}: ${navRes.errorText}`)
      }

      // Active readyState polling fallback in case browser engine (e.g. Moli)
      // delays or misses emitting Page.domContentEventFired / Page.loadEventFired.
      let inFlight = false
      pollTimer = setInterval(async () => {
        if (inFlight || this.isClosed) return
        inFlight = true
        try {
          const evalRes = await Promise.race([
            this.send('Runtime.evaluate', {
              expression: `(() => {
                const body = document.body;
                const textLen = (body ? (body.innerText || body.textContent || '') : '').trim().length;
                const title = document.title || '';
                return {
                  state: document.readyState,
                  href: location.href,
                  hasSubstantialDom: Boolean(body && (textLen > 300 || body.children.length > 5 || (title.length > 3 && textLen > 50)))
                };
              })()`,
              returnByValue: true,
              awaitPromise: false,
            }) as Promise<{ result?: { value?: { state?: string; href?: string; hasSubstantialDom?: boolean } } }>,
            new Promise<null>((r) => setTimeout(() => r(null), 500)),
          ]).catch(() => null)

          const info = evalRes?.result?.value
          if (info && typeof info.state === 'string') {
            const hasNavigated = Boolean(info.href && !info.href.startsWith('about:blank'))
            if (hasNavigated) {
              if (info.state === 'interactive' || info.state === 'complete' || info.hasSubstantialDom) {
                this.triggerDomContentLoaded()
              }
              if (info.state === 'complete') {
                this.triggerLoadFired()
              }
            }
          }
        } catch {
          // Best effort
        } finally {
          inFlight = false
        }
      }, 200)

      await waitPromise
      this.currentUrl = url
      return targetResponse
    } finally {
      if (pollTimer) clearInterval(pollTimer)
      this.responseListeners.delete(responseHandler)
    }
  }

  async waitForLoadState(state: 'domcontentloaded' | 'load' | 'networkidle', options?: { timeout?: number }): Promise<void> {
    if (this.isClosed) throw new Error('Target closed')
    if (state === 'domcontentloaded' && this.domContentLoaded) return
    if (state === 'load' && this.loadFired) return

    const timeout = options?.timeout ?? 30000
    let pollTimer: NodeJS.Timeout | null = null

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pollTimer) clearInterval(pollTimer)
        if (state === 'domcontentloaded') {
          const idx = this.domContentWaiters.indexOf(onDone)
          if (idx !== -1) this.domContentWaiters.splice(idx, 1)
        } else if (state === 'load') {
          const idx = this.loadWaiters.indexOf(onDone)
          if (idx !== -1) this.loadWaiters.splice(idx, 1)
        } else if (state === 'networkidle') {
          const idx = this.networkIdleWaiters.indexOf(onDone)
          if (idx !== -1) this.networkIdleWaiters.splice(idx, 1)
        }
        reject(new Error(`Timeout of ${timeout}ms exceeded waiting for "${state}"`))
      }, timeout)

      const onDone = () => {
        clearTimeout(timer)
        if (pollTimer) clearInterval(pollTimer)
        resolve()
      }

      let inFlight = false
      if (state === 'domcontentloaded') {
        this.domContentWaiters.push(onDone)
        pollTimer = setInterval(async () => {
          if (inFlight || this.isClosed) return
          inFlight = true
          try {
            const evalPromise = this.evaluate(`
              (() => {
                const body = document.body;
                const textLen = (body ? (body.innerText || body.textContent || '') : '').trim().length;
                const children = body ? body.children.length : 0;
                return {
                  state: document.readyState,
                  hasSubstantialDom: Boolean(body && (textLen > 500 || children > 10))
                };
              })()
            `)
            const rs = await Promise.race([
              evalPromise,
              new Promise<null>((r) => setTimeout(() => r(null), 800)),
            ]).catch(() => null) as { state?: string; hasSubstantialDom?: boolean } | null
            if (rs && (rs.state === 'interactive' || rs.state === 'complete' || rs.hasSubstantialDom)) {
              this.triggerDomContentLoaded()
            }
          } catch {} finally {
            inFlight = false
          }
        }, 250)
      } else if (state === 'load') {
        this.loadWaiters.push(onDone)
        pollTimer = setInterval(async () => {
          if (inFlight || this.isClosed) return
          inFlight = true
          try {
            const evalPromise = this.evaluate('document.readyState')
            const rs = await Promise.race([
              evalPromise,
              new Promise<null>((r) => setTimeout(() => r(null), 800)),
            ]).catch(() => null)
            if (rs === 'complete') {
              this.triggerLoadFired()
            }
          } catch {} finally {
            inFlight = false
          }
        }, 250)
      } else if (state === 'networkidle') {
        this.networkIdleWaiters.push(onDone)
        this.checkNetworkIdle()
      }
    })
  }

  private checkNetworkIdle(): void {
    if (this.inFlightRequests.size <= 2 && this.networkIdleWaiters.length > 0) {
      if (!this.networkIdleTimer) {
        this.networkIdleTimer = setTimeout(() => {
          this.networkIdleTimer = null
          if (this.inFlightRequests.size <= 2) {
            const waiters = this.networkIdleWaiters.splice(0)
            for (const w of waiters) w()
          }
        }, 500)
      }
    }
  }

  async content(): Promise<string> {
    if (this.isClosed) throw new Error('Target closed')
    const res = await this.send('Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    return typeof res?.result?.value === 'string' ? res.result.value : ''
  }

  async evaluate(pageFunction: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<unknown> {
    if (this.isClosed) throw new Error('Target closed')

    const expression = typeof pageFunction === 'string'
      ? pageFunction
      : `(${pageFunction.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`

    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown }

    if (res?.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(res.exceptionDetails)}`)
    }

    return res?.result?.value
  }

  async addInitScript(script: string): Promise<void> {
    if (this.isClosed) throw new Error('Target closed')
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: script })
  }

  async route(glob: string, handler: (route: CdpRoute) => Promise<void>): Promise<void> {
    const pattern = globToRegExp(glob)
    await this.addRoute(pattern, handler)
  }

  async addRoute(pattern: RegExp, handler: (route: CdpRoute) => Promise<void>): Promise<void> {
    this.routeHandlers.push({ pattern, handler })
    if (!this.fetchEnabled) {
      this.fetchEnabled = true
      await this.send('Fetch.enable', {}).catch(() => {})
    }
  }

  on(event: 'popup' | 'response', listener: ((page: CdpPage) => void) | ((response: CdpResponse) => void)): void {
    if (event === 'popup') {
      this.popupListeners.add(listener as (page: CdpPage) => void)
    } else if (event === 'response') {
      this.responseListeners.add(listener as (response: CdpResponse) => void)
    }
  }

  async handlePopupCreated(popupTargetId: string): Promise<void> {
    if (this.popupListeners.size === 0) return
    try {
      const attachRes = await this.ctx.browser.send('Target.attachToTarget', {
        targetId: popupTargetId,
        flatten: true,
      }) as { sessionId: string }

      const popupPage = new NativeCdpPage(this.ctx, popupTargetId, attachRes.sessionId)
      this.ctx.browser.registerSession(attachRes.sessionId, popupPage)
      await popupPage.init()

      for (const listener of this.popupListeners) {
        try { listener(popupPage) } catch {}
      }
    } catch {
      // Best effort
    }
  }

  handleEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.domContentEventFired') {
      this.triggerDomContentLoaded()
    } else if (method === 'Page.loadEventFired') {
      this.triggerLoadFired()
    } else if (method === 'Page.frameStoppedLoading') {
      const frameId = params.frameId as string | undefined
      if (!frameId || frameId === this.mainFrameId) {
        this.triggerDomContentLoaded()
      }
    } else if (method === 'Page.navigatedWithinDocument') {
      this.triggerDomContentLoaded()
    } else if (method === 'Page.frameNavigated') {
      const frame = params.frame as { id?: string; url?: string } | undefined
      if (frame?.id === this.mainFrameId && frame.url) {
        this.currentUrl = frame.url
      }
    } else if (method === 'Network.responseReceived') {
      const responseData = params.response as {
        status?: number
        headers?: Record<string, string>
        url?: string
      } | undefined
      const frameId = params.frameId as string | undefined
      const resourceType = typeof params.type === 'string' ? params.type.toLowerCase() : undefined
      const isNav = (resourceType === 'document' || resourceType === undefined) && (!frameId || frameId === this.mainFrameId)

      if (responseData) {
        const headers: Record<string, string> = {}
        if (responseData.headers) {
          for (const [k, v] of Object.entries(responseData.headers)) {
            headers[k.toLowerCase()] = String(v)
          }
        }
        const resp = new NativeCdpResponse(
          responseData.status ?? 200,
          headers,
          responseData.url ?? this.currentUrl,
          resourceType,
          isNav,
          this.mainFrameId,
          async () => {
            try {
              const res = await this.send('Network.getResponseBody', { requestId: params.requestId }) as { body?: string; base64Encoded?: boolean }
              return res?.body ?? ''
            } catch {
              return ''
            }
          },
        )

        for (const listener of this.responseListeners) {
          try { listener(resp) } catch {}
        }
      }
    } else if (method === 'Fetch.requestPaused') {
      const requestId = params.requestId as string
      const request = params.request as { url?: string; method?: string; headers?: Record<string, string> } | undefined
      const reqUrl = request?.url ?? ''
      const resourceType = (params.resourceType as string ?? '').toLowerCase()

      const routeObj: CdpRoute = {
        request: () => ({
          url: () => reqUrl,
          resourceType: () => resourceType,
        }),
        abort: async () => {
          await this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {})
        },
        continue: async () => {
          await this.send('Fetch.continueRequest', { requestId }).catch(() => {})
        },
      }

      const matchedHandler = this.routeHandlers.find(({ pattern }) => pattern.test(reqUrl))
      if (matchedHandler) {
        Promise.resolve(matchedHandler.handler(routeObj)).catch(() => {
          void routeObj.continue()
        })
      } else {
        void routeObj.continue()
      }
    } else if (method === 'Network.requestWillBeSent') {
      const reqId = params.requestId as string | undefined
      if (reqId) {
        this.inFlightRequests.add(reqId)
        if (this.networkIdleTimer) {
          clearTimeout(this.networkIdleTimer)
          this.networkIdleTimer = null
        }
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const reqId = params.requestId as string | undefined
      if (reqId) {
        this.inFlightRequests.delete(reqId)
        this.checkNetworkIdle()
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    if (this.networkIdleTimer) {
      clearTimeout(this.networkIdleTimer)
      this.networkIdleTimer = null
    }
    this.networkIdleWaiters = []
    this.inFlightRequests.clear()
    this.ctx.browser.unregisterSession(this.sessionId, this.targetId)
    await this.ctx.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

export class NativeCdpResponse implements CdpResponse {
  constructor(
    private readonly _status: number,
    private readonly _headers: Record<string, string>,
    private readonly _url: string,
    private readonly _resourceType: string | undefined,
    private readonly _isNav: boolean,
    private readonly _mainFrameId: string,
    private readonly _bodyFetcher: () => Promise<string>,
  ) {}

  status(): number {
    return this._status
  }

  headers(): Record<string, string> {
    return this._headers
  }

  url(): string {
    return this._url
  }

  async text(): Promise<string> {
    return this._bodyFetcher()
  }

  request(): CdpRequest {
    return {
      resourceType: () => this._resourceType ?? 'document',
      isNavigationRequest: () => this._isNav,
      frame: () => this._mainFrameId,
    }
  }
}

/** Convert a simple glob (*, **) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}
