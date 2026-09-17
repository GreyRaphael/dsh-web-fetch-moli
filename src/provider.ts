/**
 * Moli `WebFetchProvider`: renders pages using Moli (ultra-lightweight Rust headless browser)
 * via managed local CDP daemon, direct one-shot CLI, or remote CDP endpoint.
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
import { CHALLENGE_DOM_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
import type { ChallengeVerdict } from './challenge.ts'
import {
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_CLI,
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
import { forceLayoutMaterialization, scrollIntoViewNative, setupPageHooks } from './hooks.ts'
import { htmlToMarkdown } from './markdown.ts'
import { MoliProcessManager } from './moli-process.ts'
import { resolveCdpBackend, resolveMoliBinary } from './moli-resolve.ts'
import { runMoliFetch } from './cli-runner.ts'
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

/** Maximum rounds of sentinel trigger flips for infinite-scroll/lazy-load pages. */
const MAX_SENTINEL_ROUNDS = 2

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
  private timedOut = false

  constructor(outer: AbortSignal | undefined, timeoutMs: number) {
    this.signal = this.controller.signal
    this.expiresAt = Date.now() + timeoutMs
    const timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error('moli fetch deadline'))
    }, timeoutMs)
    if (outer !== undefined) {
      if (outer.aborted) this.controller.abort(outer.reason)
      else outer.addEventListener('abort', () => { this.controller.abort(outer.reason) }, { once: true })
    }
    this.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  }

  get isTimeout(): boolean {
    return this.timedOut
  }

  remainingMs(): number {
    return Math.max(1, this.expiresAt - Date.now())
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
    })
  }

  release(): void {
    const next = this.active <= this.limit ? this.queue.shift() : undefined
    if (next === undefined) {
      this.active = Math.max(0, this.active - 1)
      return
    }
    next.start()
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
   */
  async dispose(): Promise<void> {
    await this.cdpPool.dispose()
    await this.moliProcess.stop()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const config = this.configSource()
    const url = validateFetchUrl(request.url)
    const timeoutBudget = effectiveTimeoutMs(config)
    const deadline = new Deadline(signal, timeoutBudget)

    // Unified single concurrency gatekeeper across all backends (cdp, local, cli)
    this.semaphore.resize(effectiveMaxConcurrency(config))
    await this.semaphore.acquire(deadline.signal, Math.min(QUEUE_TIMEOUT_MS, deadline.remainingMs()))
    let acquired = true

    try {
      if (config.backend === 'cli') {
        return await this.fetchViaCli(url, config, deadline)
      }

      // CDP mode execution (local daemon or remote endpoint)
      let session: MoliBrowserSession | undefined
      try {
        session = await this.openSession(config, deadline)

        const held = session
        const onAbort = () => { void closeSession(held, this.cdpPool) }
        deadline.signal.addEventListener('abort', onAbort, { once: true })
        try {
          return await this.retrieve(session, url, config, deadline)
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
    }
  }

  /** One-shot CLI fetch via `moli fetch`. */
  private async fetchViaCli(url: URL, config: ResolvedConfig, deadline: Deadline): Promise<WebFetchResult> {
    const moliBin = await resolveMoliBinary(config.moliPath)
    try {
      const cliResult = await runMoliFetch({
        moliPath: moliBin,
        url: url.toString(),
        dump: 'html',
        timeoutMs: deadline.remainingMs(),
        signal: deadline.signal,
      })

      if (config.denoise === false) {
        return capResult(url.toString(), cliResult.statusCode, { kind: 'html', content: cliResult.content })
      }

      const bounded = cliResult.content.length > MAX_PIPELINE_INPUT_CHARS
        ? cliResult.content.slice(0, MAX_PIPELINE_INPUT_CHARS)
        : cliResult.content

      const { markdown } = htmlToMarkdown(bounded, url.toString())
      const result = capResult(url.toString(), cliResult.statusCode, { kind: 'text', content: markdown })
      return bounded !== cliResult.content ? { ...result, truncated: true } : result
    } catch (error: unknown) {
      throw translateError(error, deadline)
    }
  }

  /** Open a CDP browser session. */
  protected async openSession(config: ResolvedConfig, deadline: Deadline): Promise<MoliBrowserSession> {
    const timeout = Math.min(deadline.remainingMs(), 20_000)

    let endpoint: string
    if (config.backend === 'cdp') {
      endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
    } else {
      // Local managed Moli serve daemon (aligned with active concurrency capacity)
      const moliBin = await resolveMoliBinary(config.moliPath)
      endpoint = await this.moliProcess.ensure(moliBin, effectiveMaxConcurrency(config))
    }

    try {
      const lease = await this.cdpPool.acquire(endpoint, timeout, effectiveContextMode(config))
      await setupPageHooks(lease.page, {
        bypassCsp: config.bypassCsp,
      })
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
        response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
        tracker?.seed(response)
      }
    }

    // Wait for client-rendered SPA / micro-frontend to settle out of skeleton/spinner
    if (response === null || response.status() === 200) {
      await this.settleDynamicSpa(page, deadline)
    }

    // Dynamic SPA sentinel loading rounds (for infinite scroll / micro-frontend card lists)
    if (config.autoScrollSentinel !== false) {
      await this.runSentinelRounds(page, deadline)
    }

    const finalResponse = (challengeWaitMs > 0 ? tracker?.last() : undefined) ?? response
    const kind = classifyContentType(finalResponse?.headers()['content-type'])
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${finalResponse?.headers()['content-type'] ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const finalUrl = page.url()
    const clearedWithoutNavigation = challengeEntryResponse !== null && finalResponse === challengeEntryResponse
    const statusCode = finalResponse !== null && !clearedWithoutNavigation ? finalResponse.status() : 200

    if (kind === 'text') {
      const text = finalResponse !== null ? await finalResponse.text() : await page.content()
      return capResult(finalUrl, statusCode, { kind: 'text', content: text })
    }

    // Best-effort short settle for client-rendered scripts
    await page.waitForLoadState?.('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})

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
   */
  private async settleDynamicSpa(page: CdpPage, deadline: Deadline): Promise<void> {
    if (typeof page.evaluate !== 'function') return
    const maxWaitMs = Math.min(25_000, Math.max(10_000, deadline.remainingMs() - 15_000))
    if (maxWaitMs <= 0) return
    const start = Date.now()

    while (Date.now() - start < maxWaitMs && deadline.remainingMs() > 4_000) {
      let isUnsettled = false
      try {
        isUnsettled = Boolean(await page.evaluate(`
          (() => {
            const body = document.body;
            if (!body) return true;

            const root = document.querySelector('#root, #app, [id*="root"]');
            const cards = document.querySelectorAll('[role="feed"] > *, [class*="grid" i] > *, [class*="card" i], [class*="item" i], [class*="model" i]').length;
            const sentinel = Boolean(document.querySelector('[class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i]'));

            // Settled if cards or sentinels have mounted into DOM
            if (cards >= 5 || sentinel) return false;

            const hasSpinner = Boolean(document.querySelector('.ant-spin, .anticon-spin, [class*="spin"], [class*="skeleton"], [class*="loading"]'));
            if (hasSpinner) return true;

            // In SPA root containers (#root, #app), require root-internal content rather than outer navbars
            if (root) {
              const rootText = (root.innerText || root.textContent || '').trim();
              const hasContent = cards > 0 || Boolean(root.querySelector('table, article, .markdown-body, [class*="content"]'));
              if (rootText.length > 300 && hasContent) return false;
              return true;
            }

            // If main/article container exists, wait until main-internal content has mounted
            const main = document.querySelector('main, article, [role="main"], .markdown-body, .docs-content');
            if (main) {
              const mainText = (main.innerText || main.textContent || '').trim();
              if (mainText.length > 200 || main.querySelectorAll('table, p, li').length >= 2) return false;
              return true;
            }

            // Static or document page fallback
            const text = (body.innerText || body.textContent || '').trim();
            const hasArticle = Boolean(document.querySelector('article, main, tr, table'));
            if (hasArticle && text.length > 300) return false;
            if (text.length > 600) return false;

            return true;
          })()
        `))
      } catch {
        isUnsettled = false
      }

      if (!isUnsettled) {
        break
      }
      await sleep(Math.min(250, deadline.remainingMs()))
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
        const hasDocArticle = Boolean(document.querySelector('article, .markdown-body, .docs-content, table'));
        return textLen > 1500 && hasDocArticle;
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

      // 1. Force layout materialization so Moli computes physical bounding boxes
      await forceLayoutMaterialization(page)

      // 2. Perform native scrollIntoView on sentinel or trailing card
      const res = await scrollIntoViewNative(page)

      // If nothing was scrolled, this page has no scrollable target
      if (!res.scrolled) break

      if (res.hasSentinel) {
        everHadSentinel = true
      }

      // 3. Termination check
      const hasContentChanged = res.cardsCount > 0
        ? res.cardsCount !== lastCount
        : res.htmlLength > lastHtmlLen

      if (!hasContentChanged) {
        unchangedRounds++
        // Stop if content stopped growing for 2 consecutive rounds
        if (unchangedRounds >= 2) {
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

      // 4. Wait for network response and DOM render of new batch
      await sleep(Math.min(1200, Math.max(300, deadline.remainingMs() - 4000)))
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
