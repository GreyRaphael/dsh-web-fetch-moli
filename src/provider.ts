/**
 * Moli `WebFetchProvider`: renders pages using Moli (ultra-lightweight Rust headless browser)
 * via a managed local CDP daemon or a remote CDP endpoint.
 *
 * Provides:
 * - Ultra-lightweight footprint (~60MB RAM per daemon, compared to ~1GB for standard Chromium).
 * - Full micro-frontend and SPA support via CDP `Page.setBypassCSP` and `IntersectionObserver` sentinel triggers.
 * - Robust Cloudflare challenge wait and LinkeDOM + Readability + mdream denoise markdown pipeline.
 * - Strict URL hygiene and error taxonomy parity with DeepSeek Harness specifications.
 *
 * @module dsh-web-fetch-moli/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { CHALLENGE_DOM_PROBE, CHALLENGE_DOM_VERDICT_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
import type { ChallengeVerdict } from './challenge.ts'
import {
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  DEFAULT_TIMEOUT_MS,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveMaxConcurrency,
  effectiveTimeoutMs,
  normalizeCdpEndpoint,
} from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { CdpConnectionPool } from './cdp-pool.ts'
import type { CdpConnect, CdpLease } from './cdp-pool.ts'
import { CARD_ITEMS_SELECTOR, forceLayoutMaterialization, scrollIntoViewNative, setupPageHooks } from './hooks.ts'
import { htmlToMarkdown } from './markdown.ts'
import { MoliProcessManager } from './moli-process.ts'
import { resolveCdpBackend, resolveMoliBinary } from './moli-resolve.ts'
import type { CdpBrowser, CdpContext, CdpPage, CdpResponse } from './types.ts'

/** Stable id this provider registers under in ctx.web. */
export const MOLI_FETCH_PROVIDER_ID = 'moli'

/** Error code for an un-cleared Cloudflare challenge. */
export const WEB_FETCH_CHALLENGE_CODE = 'WEB_FETCH_CHALLENGE'

/** Maximum accepted request URL length. */
const MAX_URL_LENGTH = 2048

/** Cap on the decoded markdown/HTML body this provider returns. */
const MAX_BODY_CHARS = 100_000

/** Cap on rendered HTML fed into the synchronous denoise pipeline. */
const MAX_PIPELINE_INPUT_CHARS = 2_000_000

/** How long a fetch may sit in the concurrency queue before failing fast. */
const QUEUE_TIMEOUT_MS = 20_000

/** Post-DOM settle wait (ms) so dynamic micro-frontend modules settle. */
const SETTLE_MS = 500

/** Grace period (ms) for page/context close operations. */
const CLOSE_GRACE_MS = 1_500

/** Render session for one CDP fetch. */
export interface MoliBrowserSession {
  browser: CdpBrowser
  context: CdpContext
  page: CdpPage
  lease?: CdpLease
}

/** Deadline controller with timeout / abort segregation. */
class Deadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private readonly timer: NodeJS.Timeout
  private readonly outer?: AbortSignal
  private readonly onOuterAbort: () => void
  private readonly onAbort: () => void
  private timedOut = false
  private disposed = false

  constructor(outer: AbortSignal | undefined, timeoutMs: number) {
    this.signal = this.controller.signal
    this.outer = outer
    this.expiresAt = Date.now() + timeoutMs
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error('moli fetch deadline'))
    }, timeoutMs)
    this.onOuterAbort = () => { this.controller.abort(outer?.reason) }
    this.onAbort = () => { clearTimeout(this.timer) }
    if (outer !== undefined) {
      if (outer.aborted) this.controller.abort(outer.reason)
      else outer.addEventListener('abort', this.onOuterAbort, { once: true })
    }
    this.signal.addEventListener('abort', this.onAbort, { once: true })
  }

  get isTimeout(): boolean {
    return this.timedOut
  }

  remainingMs(): number {
    return Math.max(1, this.expiresAt - Date.now())
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) return
    throw this.signal.reason instanceof Error ? this.signal.reason : new Error('moli fetch aborted')
  }

  /**
   * Await an operation under this deadline. If the deadline wins, reject
   * immediately while still observing the operation so a value produced late
   * can be cleaned up without an unhandled rejection.
   */
  async race<T>(operation: Promise<T>, onLateValue?: (value: T) => void | Promise<void>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let finished = false
      const cleanup = () => { this.signal.removeEventListener('abort', onAbort) }
      const disposeLate = (value: T) => {
        if (onLateValue !== undefined) void Promise.resolve(onLateValue(value)).catch(() => {})
      }
      const onAbort = () => {
        if (finished) return
        finished = true
        cleanup()
        reject(this.signal.reason instanceof Error ? this.signal.reason : new Error('moli fetch aborted'))
      }

      this.signal.addEventListener('abort', onAbort, { once: true })
      // Adding a listener to an already-aborted signal does not dispatch it.
      if (this.signal.aborted) onAbort()

      void operation.then(
        (value) => {
          if (finished) {
            disposeLate(value)
            return
          }
          finished = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (finished) return
          finished = true
          cleanup()
          reject(error)
        },
      )
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.outer?.removeEventListener('abort', this.onOuterAbort)
    this.signal.removeEventListener('abort', this.onAbort)
  }
}

/** Async semaphore for concurrency management. */
class Semaphore {
  private active = 0
  private limit: number
  private readonly queue: Array<{ start: () => void; fail: (error: WebError) => void }> = []

  constructor(limit: number) {
    this.limit = limit
  }

  resize(limit: number): void {
    this.limit = limit
    this.drain()
  }

  acquire(signal: AbortSignal, queueTimeoutMs: number): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new WebError('web fetch aborted while waiting for a free rendering slot', 'WEB_ABORTED'))
    }
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const waiter = {
        start: () => {
          cleanup()
          this.active++
          resolve()
        },
        fail: (error: WebError) => {
          const index = this.queue.indexOf(waiter)
          if (index !== -1) this.queue.splice(index, 1)
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        waiter.fail(new WebError(
          `all ${String(this.limit)} rendering slots stayed busy for ${String(queueTimeoutMs)}ms; retry shortly, or raise the maxConcurrency setting`,
          'WEB_FETCH_TIMEOUT',
        ))
      }, queueTimeoutMs)
      const onAbort = () => {
        waiter.fail(new WebError('web fetch aborted while waiting for a free rendering slot', 'WEB_ABORTED'))
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      // Close the race between the initial check and listener registration.
      if (signal.aborted) onAbort()
    })
  }

  release(): void {
    // The holder always gives its slot back first; the promotion below then
    // hands that freed slot to the next waiter. Doing it in the other order
    // (start the waiter, never decrementing the holder) double-counts every
    // handoff: `active` grows by 1 per queued release until every slot is a
    // phantom and later fetches queue-timeout forever.
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.queue.shift()
      if (next === undefined) return
      next.start()
    }
  }
}

/** Validate request URL according to DeepSeek Harness specifications. */
function validateFetchUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${String(MAX_URL_LENGTH)}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

type DecodableKind = 'html' | 'text'

function classifyContentType(header: string | undefined): DecodableKind | undefined {
  if (header === undefined) return 'html'
  const bare = header.split(';')[0]?.trim().toLowerCase() ?? ''
  if (bare === 'text/html' || bare === 'application/xhtml+xml') return 'html'
  if (bare === 'text/plain' || bare === 'text/markdown' || bare === 'application/json' || bare.startsWith('text/')) {
    return 'text'
  }
  return undefined
}

function withDefaults(config: ResolvedConfig | undefined): ResolvedConfig {
  return {
    backend: config?.backend ?? 'local',
    moliPath: config?.moliPath ?? '',
    cdpEndpoint: config?.cdpEndpoint ?? '',
    shareBrowserContext: config?.shareBrowserContext !== false,
    bypassCsp: config?.bypassCsp !== false,
    autoScrollSentinel: config?.autoScrollSentinel !== false,
    denoise: config?.denoise !== false,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    challengeWaitMs: config?.challengeWaitMs ?? DEFAULT_CHALLENGE_WAIT_MS,
    challengeRetries: config?.challengeRetries ?? DEFAULT_CHALLENGE_RETRIES,
    maxConcurrency: config?.maxConcurrency,
  }
}

export class MoliFetchProvider implements WebFetchProvider {
  readonly id = MOLI_FETCH_PROVIDER_ID

  available(): boolean {
    return true
  }

  private readonly configSource: () => ResolvedConfig
  private readonly semaphore: Semaphore
  private readonly cdpPool: CdpConnectionPool
  private readonly moliProcess = new MoliProcessManager()

  constructor(
    configSource: () => ResolvedConfig,
    cdpPoolOrConnect: CdpConnectionPool | CdpConnect = defaultCdpConnect,
  ) {
    this.configSource = () => withDefaults(configSource())
    const initial = this.configSource()
    this.semaphore = new Semaphore(effectiveMaxConcurrency(initial))
    this.cdpPool = cdpPoolOrConnect instanceof CdpConnectionPool
      ? cdpPoolOrConnect
      : new CdpConnectionPool(cdpPoolOrConnect)
  }

  /**
   * Graceful cleanup of daemon processes and shared CDP connections.
   *
   * moliProcess.dispose() runs first: it flips the manager's disposed flag, so an
   * in-flight fetch that is still inside openSession cannot spawn a fresh
   * daemon AFTER cleanup completes (a daemon nobody would ever stop again —
   * the orphan leak). cdpPool.dispose() then tears down connections knowing
   * the daemon is going away.
   */
  async dispose(): Promise<void> {
    await this.moliProcess.dispose()
    await this.cdpPool.dispose()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const config = this.configSource()
    const url = validateFetchUrl(request.url)
    const timeoutBudget = effectiveTimeoutMs(config)
    const deadline = new Deadline(signal, timeoutBudget)

    let acquired = false
    try {
      // Unified single concurrency gatekeeper across all backends (cdp, local)
      this.semaphore.resize(effectiveMaxConcurrency(config))
      await this.semaphore.acquire(deadline.signal, Math.min(QUEUE_TIMEOUT_MS, deadline.remainingMs()))
      acquired = true

      // CDP mode execution (local daemon or remote endpoint)
      let session: MoliBrowserSession | undefined
      try {
        session = await deadline.race(
          this.openSession(config, deadline),
          async lateSession => { await closeSession(lateSession, this.cdpPool) },
        )

        const held = session
        const onAbort = () => { void closeSession(held, this.cdpPool) }
        deadline.signal.addEventListener('abort', onAbort, { once: true })
        // Adding to an already-aborted signal is inert; close explicitly if the
        // deadline won in the tiny window after openSession returned.
        if (deadline.signal.aborted) onAbort()
        try {
          return await deadline.race(this.retrieve(session, url, config, deadline))
        } finally {
          deadline.signal.removeEventListener('abort', onAbort)
        }
      } finally {
        await closeSession(session, this.cdpPool)
      }
    } catch (error: unknown) {
      throw translateError(error, deadline)
    } finally {
      if (acquired) this.semaphore.release()
      deadline.dispose()
    }
  }

  /** Open a CDP browser session. */
  protected async openSession(config: ResolvedConfig, deadline: Deadline): Promise<MoliBrowserSession> {
    const timeout = Math.min(deadline.remainingMs(), 20_000)

    deadline.throwIfAborted()
    let endpoint: string
    if (config.backend === 'cdp') {
      endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
    } else {
      // Local managed Moli serve daemon (aligned with active concurrency capacity)
      const moliBin = await resolveMoliBinary(config.moliPath)
      deadline.throwIfAborted()
      endpoint = await this.moliProcess.ensure(moliBin, effectiveMaxConcurrency(config))
      deadline.throwIfAborted()
    }

    try {
      deadline.throwIfAborted()
      const lease = await this.cdpPool.acquire(endpoint, timeout, effectiveContextMode(config))
      let released = false
      const release = async () => {
        if (released) return
        released = true
        await this.cdpPool.release(lease)
      }
      const onAbort = () => { void release() }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      if (deadline.signal.aborted) onAbort()
      try {
        await setupPageHooks(lease.page, {
          bypassCsp: config.bypassCsp,
        })
        if (deadline.signal.aborted) {
          await release()
          throw new Error('moli fetch deadline elapsed while opening a page')
        }
      } catch (error: unknown) {
        await release()
        throw error
      } finally {
        deadline.signal.removeEventListener('abort', onAbort)
      }
      guardPopups(lease.page)
      return {
        browser: lease.browser,
        context: lease.context,
        page: lease.page,
        lease,
      }
    } catch (error: unknown) {
      throw new WebError(
        `cannot connect to Moli CDP endpoint ${endpoint}; ${String(error instanceof Error ? error.message : error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }

  /**
   * Navigate, handle challenges, trigger sentinels, settle, and denoise.
   */
  private async retrieve(
    session: MoliBrowserSession,
    url: URL,
    config: ResolvedConfig,
    deadline: Deadline,
  ): Promise<WebFetchResult> {
    const page = session.page
    const challengeWaitMs = effectiveChallengeWaitMs(config)
    const tracker = challengeWaitMs > 0 ? trackMainFrameResponses(page) : undefined

    let response = await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: deadline.remainingMs(),
    })
    tracker?.seed(response)

    let challengeEntryResponse: CdpResponse | null = null
    if (challengeWaitMs > 0) {
      let attemptsLeft = effectiveChallengeRetries(config) + 1
      for (;;) {
        const verdict = await this.verdictAfterLoad(page, tracker?.last() ?? response)
        if (verdict === 'blocked') {
          throw new WebError(
            `the site hard-blocked this fetch at its Cloudflare edge: ${page.url()}`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        if (verdict !== 'challenge') break
        challengeEntryResponse = tracker?.last() ?? response
        const cleared = await this.waitForChallengeClear(page, deadline, challengeWaitMs)
        if (cleared) {
          let chained = false
          try { chained = classifyChallengeHtml(await page.content()) === 'challenge' } catch { chained = false }
          if (!chained) break
        }
        if (--attemptsLeft <= 0) {
          const lastStatus = (tracker?.last() ?? response)?.status()
          throw new WebError(
            `the site kept serving a Cloudflare challenge (last status ${lastStatus === undefined ? 'unknown' : String(lastStatus)}); the browser did not clear it naturally`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        challengeEntryResponse = null
        response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
        tracker?.seed(response)
      }
    }

    const finalResponse = (challengeWaitMs > 0 ? tracker?.last() : undefined) ?? response
    const clearedWithoutNavigation = challengeEntryResponse !== null && finalResponse === challengeEntryResponse
    const statusCode = finalResponse !== null && !clearedWithoutNavigation ? finalResponse.status() : 200

    // Wait for client-rendered SPA / micro-frontend to settle out of skeleton/spinner.
    // A challenge that cleared in place (no navigation) keeps the 403 goto
    // response while the live document is the cleared page — settle it too, or
    // exactly the SPA interstitials that need the settle most would skip it.
    if (response === null || statusCode === 200) {
      await this.settleDynamicSpa(page, deadline)
    }

    // Dynamic SPA sentinel loading rounds (for infinite scroll / micro-frontend card lists)
    if (config.autoScrollSentinel !== false) {
      await this.runSentinelRounds(page, deadline)
    }

    const kind = classifyContentType(finalResponse?.headers()['content-type'])
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${finalResponse?.headers()['content-type'] ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const finalUrl = page.url()

    if (kind === 'text') {
      const text = finalResponse !== null ? await finalResponse.text() : await page.content()
      return capResult(finalUrl, statusCode, { kind: 'text', content: text })
    }

    // Best-effort short settle for client-rendered scripts:
    // Only wait networkidle if the live document is sparse (less than 500 chars of text),
    // avoiding the flat 500ms timeout on already settled/scrolled rich SPAs and static docs.
    if (typeof page.waitForLoadState === 'function') {
      const isSparse = typeof page.evaluate === 'function'
        ? await page.evaluate(`
            Boolean(!document.body || (document.body.innerText || document.body.textContent || '').trim().length < 500)
          `).catch(() => true)
        : true
      if (isSparse) {
        await page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})
      }
    }

    const html = await page.content()
    if (config.denoise === false) {
      return capResult(finalUrl, statusCode, { kind: 'html', content: html })
    }
    const bounded = html.length > MAX_PIPELINE_INPUT_CHARS ? html.slice(0, MAX_PIPELINE_INPUT_CHARS) : html
    const { markdown } = htmlToMarkdown(bounded, finalUrl)

    const result = capResult(finalUrl, statusCode, { kind: 'text', content: markdown })
    return bounded !== html ? { ...result, truncated: true } : result
  }

  /**
   * Settle client-rendered SPAs and micro-frontends before extracting content.
   * - Static, server-rendered, or unit-test fake pages return immediately.
   * - Skeleton shells / loading spinners wait until content cards/text have mounted into the DOM.
   * - Uses in-page MutationObserver for sub-100ms event-driven response, with fallback polling.
   */
  private async settleDynamicSpa(page: CdpPage, deadline: Deadline): Promise<void> {
    if (typeof page.evaluate !== 'function') return
    // Hold 15s back for the sentinel rounds, the content read, and the denoise
    // pipeline; within what remains, cap the settle itself at 25s.
    const maxWaitMs = Math.min(25_000, deadline.remainingMs() - 15_000)
    if (maxWaitMs <= 0) return

    try {
      await page.evaluate(`
        ((maxWait) => {
          return new Promise((resolve) => {
            const isSettled = () => {
              const body = document.body;
              if (!body) return false;

              // Exclude header and navigation chrome to prevent false positives (e.g. category navbars)
              const cards = document.querySelectorAll(
                '${CARD_ITEMS_SELECTOR}'
              ).length;
              const sentinel = Boolean(document.querySelector(
                '[class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i]'
              ));

              // 1. Settled if feed/cards or infinite sentinels have mounted into DOM
              if (cards >= 5 || sentinel) return true;

              const getMeaningfulText = (el) => {
                if (!el) return 0;
                const paragraphs = el.querySelectorAll('p, li, article, h1, h2, h3, tr, td');
                if (paragraphs.length >= 2) {
                  let sum = 0;
                  for (let i = 0; i < paragraphs.length; i++) sum += (paragraphs[i].textContent || '').trim().length;
                  return sum;
                }
                return (el.innerText || el.textContent || '').trim().length;
              };

              // 2. In SPA root containers (#root, #app), require root-internal meaningful content
              const root = document.querySelector('#root, #app, [id*="root"]');
              if (root) {
                const rootTextLen = getMeaningfulText(root);
                const hasContent = cards > 0 || Boolean(root.querySelector('table, article, .markdown-body, [class*="content" i]'));
                if (rootTextLen > 300 && hasContent) return true;
                return false;
              }

              // 3. In main/article containers, require meaningful prose/table text
              const main = document.querySelector('main, article, [role="main"], .markdown-body, .docs-content');
              if (main) {
                const mainTextLen = getMeaningfulText(main);
                if (mainTextLen > 180 || main.querySelectorAll('table, p, li').length >= 2 || main.querySelector('article')) return true;
              }

              // 4. Static or document page fallback
              const text = (body.innerText || body.textContent || '').trim();
              const hasArticle = Boolean(document.querySelector('article, main, tr, table'));
              if (hasArticle && text.length > 300) return true;
              if (text.length > 600) return true;

              // 5. If none of the content criteria are satisfied, check if active spinner/skeleton is present
              const spinners = document.querySelectorAll(
                '.ant-spin, .anticon-spin, [class*="spin" i], [class*="skeleton" i], [class*="loading" i]'
              );
              for (let i = 0; i < spinners.length; i++) {
                const s = spinners[i];
                if (s.closest('header, nav')) continue;
                if (s.offsetWidth > 0 || s.offsetHeight > 0 || s.getClientRects().length > 0) return false;
              }

              return false;
            };

            if (isSettled()) return resolve(true);

            let debounceTimer = null;
            let observer = null;
            let fallbackPoll = null;
            let safetyTimer = null;
            let resolved = false;

            const finish = () => {
              if (resolved) return;
              resolved = true;
              if (observer) observer.disconnect();
              if (fallbackPoll) clearInterval(fallbackPoll);
              if (safetyTimer) clearTimeout(safetyTimer);
              if (debounceTimer) clearTimeout(debounceTimer);
              resolve(true);
            };

            const check = () => {
              if (isSettled()) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(finish, 60);
              }
            };

            const target = document.body || document.documentElement;
            if (typeof MutationObserver !== 'undefined' && target) {
              observer = new MutationObserver(check);
              observer.observe(target, { childList: true, subtree: true });
            }

            fallbackPoll = setInterval(check, 100);
            safetyTimer = setTimeout(finish, maxWait);
          });
        })(${maxWaitMs})
      `)
    } catch {
      // Best-effort settle
    }
  }

  /**
   * Native scroll rounds for dynamic SPA / infinite lists via Moli layout materialization
   * and W3C standard scrollIntoView (moli_scroll scheme).
   */
  private async runSentinelRounds(page: CdpPage, deadline: Deadline): Promise<void> {
    if (typeof page.evaluate !== 'function') return

    // Quick check: if the page is a large static article or documentation without sentinels,
    // skip scrolling to save latency.
    const skipScroll = await page.evaluate(`
      (() => {
        const hasSentinel = Boolean(document.querySelector(
          '[class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i], [class*="loading" i], [id*="sentinel" i], [id*="loadmore" i]'
        ));
        if (hasSentinel) return false;
        const hasGridOrFeed = Boolean(document.querySelector('[role="feed"], [class*="grid" i]'));
        if (hasGridOrFeed) return false;
        const textLen = (document.body?.innerText || document.body?.textContent || '').trim().length;
        const article = document.querySelector('article, main, .markdown-body, .docs-content');
        const articleTextLen = article ? (article.innerText || article.textContent || '').trim().length : 0;
        return textLen > 600 && articleTextLen > 300;
      })()
    `).catch(() => false)
    if (skipScroll) return

    const maxRounds = 12
    let everHadSentinel = false
    let lastCount = 0
    let lastHtmlLen = 0
    let unchangedRounds = 0

    for (let round = 1; round <= maxRounds; round++) {
      if (deadline.remainingMs() < 4_000) break

      // 1. Layout materialization on demand: materialize on round 1 to ensure initial layout tree;
      // on subsequent rounds only trigger if scrolling did not take effect.
      if (round === 1) {
        await forceLayoutMaterialization(page)
      }

      // 2. Perform native scrollIntoView on sentinel or trailing card
      let res = await scrollIntoViewNative(page)

      // Fallback layout materialization if first attempt couldn't scroll
      if (!res.scrolled && round > 1) {
        await forceLayoutMaterialization(page)
        res = await scrollIntoViewNative(page)
      }

      // If nothing was scrolled, this page has no scrollable target
      if (!res.scrolled) break

      if (res.hasSentinel) {
        everHadSentinel = true
      }

      // Stop after 4 rounds for unstructured infinite streams that lack discrete cards
      // (prevents runaway scrolling on open news portals like Tencent News where "load more" never ends)
      if (round >= 4 && res.cardsCount === 0) break

      // 3. Termination check
      const hasContentChanged = res.cardsCount > 0
        ? res.cardsCount !== lastCount
        : res.htmlLength > lastHtmlLen

      if (!hasContentChanged) {
        unchangedRounds++
        // Stop if content stopped growing for 2 consecutive rounds,
        // or if sentinel was destroyed and content ceased changing.
        if (unchangedRounds >= 2 || (everHadSentinel && !res.hasSentinel)) {
          break
        }
      } else {
        unchangedRounds = 0
        lastCount = res.cardsCount
        lastHtmlLen = res.htmlLength

        // 优化：识别 Sentinel 销毁（此前曾有 Sentinel，现 hasSentinel === false）且卡片已有增量，
        // 说明触底全量加载完毕，直接快速收敛退出，消除尾部的无效空转轮次
        if (everHadSentinel && !res.hasSentinel) {
          break
        }
      }

      // 4. Adaptive event-driven wait for new batch to load and settle into DOM
      const maxWait = Math.min(800, Math.max(250, deadline.remainingMs() - 4000))
      await this.waitForSentinelBatch(page, res.cardsCount, res.htmlLength, maxWait)
    }
  }

  /**
   * Adaptive event-driven wait: listens for DOM mutations and card/content growth
   * with a short debounce (80ms) rather than a blind static sleep.
   */
  private async waitForSentinelBatch(
    page: CdpPage,
    prevCards: number,
    prevHtmlLen: number,
    maxWaitMs: number,
  ): Promise<void> {
    if (typeof page.evaluate !== 'function' || maxWaitMs <= 50) {
      await sleep(Math.min(maxWaitMs, 250))
      return
    }

    try {
      await page.evaluate(`
        ((prevCards, prevLen, maxWait) => {
          return new Promise((resolve) => {
            const getCards = () => document.querySelectorAll(
              '${CARD_ITEMS_SELECTOR}'
            ).length;
            const getLen = () => (document.documentElement ? document.documentElement.outerHTML.length : 0);

            let debounceTimer = null;
            let pollInterval = null;
            let safetyTimer = null;
            let observer = null;
            let settled = false;
            let growthDetected = false;

            const finish = () => {
              if (settled) return;
              settled = true;
              if (observer) observer.disconnect();
              if (pollInterval) clearInterval(pollInterval);
              if (safetyTimer) clearTimeout(safetyTimer);
              if (debounceTimer) clearTimeout(debounceTimer);
              resolve(true);
            };

            const check = () => {
              if (settled) return;
              const curCards = getCards();
              const curLen = getLen();
              if (curCards > prevCards || curLen > prevLen + 80) {
                // Batch growth detected: debounce 80ms to allow current batch render to settle
                if (!growthDetected) {
                  growthDetected = true;
                  debounceTimer = setTimeout(finish, 80);
                }
              }
            };

            const target = document.body || document.documentElement;
            if (typeof MutationObserver !== 'undefined' && target) {
              observer = new MutationObserver(check);
              observer.observe(target, { childList: true, subtree: true });
            }

            pollInterval = setInterval(check, 25);
            safetyTimer = setTimeout(finish, maxWait);
          });
        })(${prevCards}, ${prevHtmlLen}, ${maxWaitMs})
      `)
    } catch {
      await sleep(Math.min(maxWaitMs, 250))
    }
  }

  private async verdictAfterLoad(page: CdpPage, response: CdpResponse | null): Promise<ChallengeVerdict> {
    if (response !== null && classifyChallengeResponse(response.status(), response.headers()) === 'challenge') {
      return 'challenge'
    }
    if (response !== null && !isChallengeCompatibleResponse(response.status(), response.headers())) {
      return 'none'
    }
    if (response === null || classifyContentType(response.headers()['content-type']) === 'html') {
      // Classify the LIVE document in-page first: only the verdict string
      // crosses CDP, so a plain 200 behind a Cloudflare edge (most protected
      // zones) no longer ships the whole document just to hear `none`. Pages
      // that cannot run the probe — no evaluate, an unexpected result, a
      // throw — fall back to the content round trip.
      if (typeof page.evaluate === 'function') {
        try {
          const verdict = await page.evaluate(CHALLENGE_DOM_VERDICT_PROBE)
          if (verdict === 'none' || verdict === 'challenge' || verdict === 'blocked') return verdict
        } catch {
          // Fall through to the content-based classification
        }
      }
      try {
        return classifyChallengeHtml(await page.content())
      } catch {
        return 'none'
      }
    }
    return 'none'
  }

  private async waitForChallengeClear(page: CdpPage, deadline: Deadline, challengeWaitMs: number): Promise<boolean> {
    const budget = Math.min(challengeWaitMs, deadline.remainingMs() - CHALLENGE_FINISH_RESERVE_MS)
    if (budget <= 0) return false
    const until = Date.now() + budget
    for (;;) {
      if (deadline.signal.aborted) throw new Error('challenge wait aborted')
      if (await probeStillOnChallenge(page)) {
        const remaining = until - Date.now()
        if (remaining <= 0) return false
        await sleep(Math.min(CHALLENGE_POLL_INTERVAL_MS, remaining))
        continue
      }
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(deadline.remainingMs(), 2_000) }).catch(() => {})
      return true
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function isMainFrameDocument(response: CdpResponse, page: CdpPage): boolean {
  const request = response.request?.()
  if (request === undefined) return true
  if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) return false
  const resourceType = typeof request.resourceType === 'function' ? request.resourceType() : undefined
  if (resourceType !== undefined && resourceType !== 'document') return false
  if (typeof request.frame === 'function' && typeof page.mainFrame === 'function') {
    return request.frame() === page.mainFrame()
  }
  return true
}

interface MainFrameTracker {
  last(): CdpResponse | null
  seed(response: CdpResponse | null): void
}

function trackMainFrameResponses(page: CdpPage): MainFrameTracker {
  let last: CdpResponse | null = null
  try {
    page.on?.('response', (response) => {
      if (isMainFrameDocument(response, page)) last = response
    })
  } catch {
    // Keep going without response tracking
  }
  return {
    last: () => last,
    seed: (response) => { if (response !== null) last = response },
  }
}

async function probeStillOnChallenge(page: CdpPage): Promise<boolean> {
  if (typeof page.evaluate === 'function') {
    try {
      const verdict = await page.evaluate(CHALLENGE_DOM_PROBE)
      if (typeof verdict === 'boolean') return verdict
    } catch {
      // Fall through to content check
    }
  }
  try {
    return classifyChallengeHtml(await page.content()) !== 'none'
  } catch {
    return true
  }
}

function capResult(url: string, statusCode: number, body: { kind: 'html' | 'text'; content: string }): WebFetchResult {
  const truncated = body.content.length > MAX_BODY_CHARS
  return {
    url,
    statusCode,
    body: { kind: body.kind, content: truncated ? body.content.slice(0, MAX_BODY_CHARS) : body.content },
    truncated,
  }
}

async function closeSession(session: MoliBrowserSession | undefined, pool: CdpConnectionPool): Promise<void> {
  if (session === undefined) return
  if (session.lease !== undefined) {
    await pool.release(session.lease)
    return
  }
  await closeWithGrace(session.page)
  await closeWithGrace(session.context)
  await closeWithGrace(session.browser)
}

async function closeWithGrace(closeable: { close(): Promise<void> } | undefined): Promise<void> {
  if (!closeable || typeof closeable.close !== 'function') return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CLOSE_GRACE_MS)
    void closeable.close().then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

async function defaultCdpConnect(endpoint: string, timeoutMs: number): Promise<CdpBrowser> {
  const { chromium } = await resolveCdpBackend()
  return await chromium.connectOverCDP(endpoint, { timeout: timeoutMs })
}


function guardPopups(page: CdpPage): void {
  try {
    page.on?.('popup', popup => { void popup.close().catch(() => {}) })
  } catch {
    // Keep going without guard
  }
}

function translateError(error: unknown, deadline: Deadline): WebError {
  if (error instanceof WebError) return error

  if (deadline.isTimeout) {
    return new WebError('moli fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  }
  if (deadline.signal.aborted) {
    return new WebError('moli fetch aborted', 'WEB_ABORTED', { cause: error })
  }

  const message = error instanceof Error ? error.message : String(error)
  return new WebError(message, 'WEB_PROVIDER_ERROR', { cause: error })
}
