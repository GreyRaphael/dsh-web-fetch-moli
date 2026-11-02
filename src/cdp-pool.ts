/**
 * Shared CDP connection pool for Moli:
 * Maintains a persistent `connectOverCDP` session reused across fetches.
 * Each fetch leases an isolated page/tab and releases it upon completion.
 *
 * @module dsh-web-fetch-moli/cdp-pool
 */

import type { CdpBrowser, CdpContext, CdpPage } from './types.ts'

/** Opens the shared connection; injected so tests can substitute a fake. */
export type CdpConnect = (endpoint: string, timeoutMs: number) => Promise<CdpBrowser>

/** How a lease scopes its fetch: throwaway context or the browser profile. */
export type CdpAcquireMode = 'isolated' | 'profile'

/** One fetch's lease: the shared browser, a context, and the tab it owns. */
export interface CdpLease {
  /** The shared connection — close only what the lease owns, never this. */
  browser: CdpBrowser
  /**
   * The context the page lives in: fetch-owned (`isolated`) or the remote
   * browser's default context (`profile`). NEVER close the latter — closing
   * it tears down the whole shared connection.
   */
  context: CdpContext
  /** The fetch-owned tab; release always closes it. */
  page: CdpPage
  /** True when context is the remote default context: release must not close it. */
  persistent: boolean
}

/** A reusable `connectOverCDP` session handing out per-fetch pages. */
export class CdpConnectionPool {
  private browser: CdpBrowser | undefined
  private endpoint = ''
  private connecting: Promise<CdpBrowser> | undefined
  private connectingEndpoint = ''
  /** Bumped by dispose/replace so a settling connect knows it was abandoned. */
  private generation = 0
  /**
   * Terminal flag: `dispose()` means the plugin is unloading, so a later
   * `acquire()` must fail rather than reconnect. Without it, a fetch racing
   * teardown reopens a connection (and, in profile mode, a tab in the user's
   * real browser) that nobody is left to close — an orphan the unload path
   * cannot see. `MoliProcessManager` guards the same race for the daemon; the
   * two halves of teardown need the same guarantee.
   */
  private disposed = false

  /**
   * @param connect - opens a connection to an endpoint.
   */
  constructor(private readonly connect: CdpConnect) {}

  /**
   * Lease a fetch's page on the shared connection, connecting (or
   * reconnecting) first if needed.
   *
   * @param endpoint - normalized CDP endpoint URL.
   * @param timeoutMs - connect timeout budget.
   * @param mode - `isolated` (default) or `profile`.
   * @returns lease containing browser, context, and page.
   */
  async acquire(endpoint: string, timeoutMs: number, mode: CdpAcquireMode = 'isolated'): Promise<CdpLease> {
    this.throwIfDisposed()
    const browser = await this.ensure(endpoint, timeoutMs)
    try {
      return await this.openLease(browser, mode)
    } catch (error: unknown) {
      // The connection may have died between ensure() and opening the lease;
      // one fresh connection attempt, then the error propagates as-is.
      if (this.isLive(browser)) throw error
      this.drop(browser)
      const fresh = await this.ensure(endpoint, timeoutMs)
      return await this.openLease(fresh, mode)
    }
  }

  /**
   * Reject work that arrives after teardown started. Mirrors
   * `MoliProcessManager.ensure`, so both halves of the plugin fail the same way
   * instead of one resurrecting silently.
   */
  private throwIfDisposed(): void {
    if (this.disposed) throw new Error('cdp connection pool is disposed; cannot open a new lease')
  }

  /**
   * Open one lease's page on a live connection.
   */
  private async openLease(browser: CdpBrowser, mode: CdpAcquireMode): Promise<CdpLease> {
    if (mode === 'profile') {
      const context = browser.contexts?.()[0]
      if (context === undefined) {
        throw new Error('the CDP endpoint exposed no default browser context (profile mode requires a real browser profile)')
      }
      return { browser, context, page: await context.newPage(), persistent: true }
    }
    const context = await browser.newContext()
    try {
      return { browser, context, page: await context.newPage(), persistent: false }
    } catch (error: unknown) {
      await context.close().catch(() => {})
      throw error
    }
  }

  /**
   * Close a fetch-owned page, plus its context when the lease owns one.
   *
   * @param lease - the lease whose page (and context if isolated) goes away.
   */
  async release(lease: CdpLease): Promise<void> {
    await lease.page.close().catch(() => {})
    if (!lease.persistent) await lease.context.close().catch(() => {})
  }

  /**
   * Drop the shared connection and make disposal terminal: later acquires fail
   * instead of reconnecting. Idempotent, so a second call (unload racing an
   * explicit dispose) is a no-op rather than a second close.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const browser = this.browser
    this.browser = undefined
    this.endpoint = ''
    this.connecting = undefined
    this.connectingEndpoint = ''
    this.generation++
    await browser?.close().catch(() => {})
  }

  /** The shared connection for `endpoint`, connecting or reconnecting as needed. */
  private async ensure(endpoint: string, timeoutMs: number): Promise<CdpBrowser> {
    this.throwIfDisposed()
    if (this.browser !== undefined && this.endpoint === endpoint && this.isLive(this.browser)) return this.browser
    if (this.connecting !== undefined && this.connectingEndpoint === endpoint) return this.connecting
    return await this.connectFresh(endpoint, timeoutMs)
  }

  /** Start a connection to `endpoint`, superseding whatever was there. */
  private connectFresh(endpoint: string, timeoutMs: number): Promise<CdpBrowser> {
    this.throwIfDisposed()
    const stale = this.browser
    this.browser = undefined
    this.endpoint = ''
    const generation = ++this.generation
    const attempt = (async () => {
      const browser = await this.connect(endpoint, timeoutMs)
      // Disposal during the dial is the one window the entry check cannot cover:
      // adopt nothing and close what we just opened, so unload stays final.
      if (this.disposed) {
        await browser.close().catch(() => {})
        throw new Error('cdp connection pool was disposed while connecting')
      }
      if (generation !== this.generation) {
        await browser.close().catch(() => {})
        throw new Error('cdp connection abandoned before it attached')
      }
      this.browser = browser
      this.endpoint = endpoint
      this.watch(browser)
      return browser
    })()
    this.connecting = attempt
    this.connectingEndpoint = endpoint
    void attempt.then(
      () => { if (this.connecting === attempt) this.connecting = undefined },
      () => { if (this.connecting === attempt) this.connecting = undefined },
    )
    void stale?.close().catch(() => {})
    return attempt
  }

  /** Clear the reference when this connection reports it went away. */
  private watch(browser: CdpBrowser): void {
    try {
      browser.on?.('disconnected', () => {
        if (this.browser === browser) {
          this.browser = undefined
          this.endpoint = ''
        }
      })
    } catch {
      // Backend that refuses listeners loses proactive detection
    }
  }

  /** Forget a connection known to be dead. */
  private drop(browser: CdpBrowser): void {
    if (this.browser === browser) {
      this.browser = undefined
      this.endpoint = ''
    }
  }

  private isLive(browser: CdpBrowser): boolean {
    return browser.isConnected?.() !== false
  }
}
