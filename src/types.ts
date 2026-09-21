/**
 * Structural types for Moli web-fetch provider:
 * - CDP structural interfaces for driving Moli over Chrome DevTools Protocol.
 * - Moli-specific execution modes and sessions.
 *
 * Declared locally without hard-depending on runtime protocol packages so that
 * the plugin remains dynamically adaptive to bundled drivers and lightweight fakes.
 *
 * @module dsh-web-fetch-moli/types
 */

/** Which Moli backend serves a fetch. */
export type MoliBackend = 'local' | 'cdp'

/**
 * How the CDP backend scopes a fetch: a throwaway isolated context, or a tab
 * in the remote browser's real profile (default context).
 */
export type CdpContextMode = 'isolated' | 'profile'

/** A navigation response, as `page.goto` returns it. */
export interface CdpResponse {
  status(): number
  headers(): Record<string, string>
  text(): Promise<string>
  /** This response's URL; absent on minimal fakes. */
  url?(): string
  /**
   * The request this response answers — used to recognize main-frame
   * navigation responses while the challenge wait runs. Absent on fakes.
   */
  request?(): CdpRequest
}

/** The request side of a response, for main-frame filtering. */
export interface CdpRequest {
  /** True for navigations (document loads and their redirect hops). */
  isNavigationRequest?(): boolean
  /** `'document'` for frame navigations; absent on minimal fakes. */
  resourceType?(): string
  /** The frame that issued the request; compare with `page.mainFrame()`. */
  frame?(): unknown
}

/** A page inside a context. */
export interface CdpPage {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<CdpResponse | null>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  url(): string
  content(): Promise<string>
  close(): Promise<void>
  /** Popup notification; the fetch closes whatever its page spawns. */
  on?(event: 'popup', listener: (page: CdpPage) => void): unknown
  /**
   * Response notification — the challenge wait uses it to track the LAST
   * main-frame navigation response (challenge pages reload into the real
   * document). Absent on minimal fakes (content polling covers them).
   */
  on?(event: 'response', listener: (response: CdpResponse) => void): unknown
  /**
   * Evaluate an expression in the page.
   */
  evaluate?(script: string | ((...args: any[]) => any), arg?: unknown): Promise<unknown>
  /** Context reference. */
  context?(): CdpContext
  /** The main frame handle; compare with `request.frame()` for filtering. */
  mainFrame?(): unknown
  /** Send a raw CDP command directly to the page target session. */
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Capture a micro-clip screenshot over CDP to trigger on-demand layout materialization in Moli. */
  captureScreenshot?(options?: {
    clip?: { x: number; y: number; width: number; height: number; scale: number }
  }): Promise<string>
}

/**
 * A browser context: fetch-owned and isolated (local backend, or CDP
 * `isolated` mode), or the remote browser's default context carrying its
 * real profile (CDP `profile` mode — never closed by a fetch).
 */
export interface CdpContext {
  newPage(): Promise<CdpPage>
  close(): Promise<void>
}

/** A browser instance (launched locally or connected over CDP). */
export interface CdpBrowser {
  newContext(): Promise<CdpContext>
  close(): Promise<void>
  /**
   * Contexts visible to this connection. Over CDP the default context — the
   * remote browser's real profile — is always dispatched first, so `[0]` is
   * it; absent on minimal fakes (isolated mode never calls this).
   */
  contexts?(): CdpContext[]
  /** Liveness probe; absent on minimal fakes (assumed live). */
  isConnected?(): boolean
  /** Optional disconnect notification used to drop a stale shared CDP connection. */
  on?(event: 'disconnected', listener: () => void): unknown
}

/** The `chromium` namespace of whichever protocol driver serves a fetch. */
export interface CdpChromium {
  connectOverCDP(endpointURL: string, options?: { timeout?: number }): Promise<CdpBrowser>
}
