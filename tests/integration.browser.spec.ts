/**
 * Integration smoke: real local HTTP server through the REAL Moli provider
 * (real moli resolution, real Moli daemon/CLI, real denoise pipeline).
 */
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { MoliFetchProvider, WEB_FETCH_CHALLENGE_CODE } from '../src/provider.ts'
import { resolveMoliBinary } from '../src/moli-resolve.ts'
import { MoliProcessManager } from '../src/moli-process.ts'

const PAGE = `<!doctype html><html><head><title>Smoke page</title></head><body>
<nav><a href="/x">nav link</a></nav>
<main><article><h1>Smoke heading</h1><p>The rendered body text.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

const COOKIE_PAGE_SEEN = `<!doctype html><html><head><title>Probe</title></head><body>
<main><article><h1>Cookie probe COOKIE-SEEN</h1><p>The shared context carried the cookie this far.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
</body></html>`

const COOKIE_PAGE_BLANK = `<!doctype html><html><head><title>Probe</title></head><body>
<main><article><h1>Cookie probe</h1><p>No cookie rode along with this request.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
</body></html>`

const GUARDED_ARTICLE = `<!doctype html><html><head><title>Simulated protected article</title></head><body>
<main><article><h1>Real protected content</h1>
<p>This paragraph only renders once the simulated Cloudflare challenge has cleared inside the browser itself, and there is enough prose for the article extractor to lock onto the main content region.</p>
<p>A second paragraph of real body text.</p>
</article></main>
</body></html>`

const GUARDED_ARTICLE_BODY = `<main><article><h1>Real protected content</h1>
<p>This paragraph only renders once the simulated Cloudflare challenge has cleared inside the browser itself, and there is enough prose for the article extractor to lock onto the main content region.</p>
<p>A second paragraph of real body text.</p>
</article></main>`

function challengePage(clearAfterMs: number | null, spa: boolean): string {
  const clearScript = clearAfterMs === null
    ? 'setTimeout(function () {}, 1000);'
    : spa
      ? `setTimeout(function () {
        document.title = 'Simulated protected article';
        document.body.innerHTML = ${JSON.stringify(GUARDED_ARTICLE_BODY)};
        history.replaceState(null, '', '/guarded/spa?cleared=1');
      }, ${String(clearAfterMs)});`
      : `setTimeout(function () {
        document.cookie = 'cf_clearance=sim; path=/';
        location.reload();
      }, ${String(clearAfterMs)});`
  return `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><div class="main-content">
<div id="challenge-stage"><div id="challenge-running"><span class="spinner"></span>Verifying you are human. This may take a few seconds.</div></div>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: SIMULATED012345</span></div></div>
</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/simulated" async></script>
<script>window._cf_chl_opt = { cvId: 3 };
${clearScript}</script>
</body></html>`
}

const CHALLENGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cf-mitigated': 'challenge',
  'server': 'cloudflare',
} as const

const challengeState = { challengesServed: 0 }

let server: ReturnType<typeof createServer>
let baseUrl: string
let moliAvailable = false
let moliPath = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/cdn-cgi/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('// simulated challenge platform script')
      return
    }
    if (url.startsWith('/guarded/')) {
      const cleared = (req.headers.cookie ?? '').includes('cf_clearance=')
      if (url.startsWith('/guarded/spa')) {
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(2_000, true))
        return
      }
      if (url.startsWith('/guarded/hard')) {
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(null, false))
        return
      }
      const fast = url.startsWith('/guarded/fast')
      if (!cleared) {
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(fast ? 1_000 : 3_000, false))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(GUARDED_ARTICLE)
      return
    }
    if (url.startsWith('/cookie')) {
      if ((req.headers.cookie ?? '').includes('dsh-profile-probe=')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(COOKIE_PAGE_SEEN)
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'dsh-profile-probe=1; Path=/' })
        res.end(COOKIE_PAGE_BLANK)
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  baseUrl = `http://127.0.0.1:${String(address.port)}/`

  try {
    moliPath = await resolveMoliBinary()
    moliAvailable = true
  } catch (error) {
    console.warn(`skipping Moli smoke: ${String(error instanceof Error ? error.message : error)}`)
  }
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})

describe('MoliFetchProvider CLI integration', () => {
  it('fetches a local page via one-shot CLI and denoises it', { timeout: 30_000 }, async () => {
    if (!moliAvailable) return

    const provider = new MoliFetchProvider(() => ({
      backend: 'cli',
      moliPath,
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.statusCode).toBe(200)
    expect(result.url).toBe(baseUrl)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    expect(content).toMatch(/^# (Smoke page|Smoke heading)\b/m)
    expect(content).toContain('The rendered body text.')
    expect(content).not.toContain('nav link')
    expect(content).not.toContain('footer noise')
  })

  it('returns raw html via CLI with denoise off', { timeout: 30_000 }, async () => {
    if (!moliAvailable) return

    const provider = new MoliFetchProvider(() => ({
      backend: 'cli',
      moliPath,
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: false,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') expect(result.body.content).toContain('<article>')
  })
})

describe('MoliFetchProvider Local CDP integration', () => {
  it('fetches through managed local Moli daemon over CDP and denoises it', { timeout: 60_000 }, async () => {
    if (!moliAvailable) return

    const provider = new MoliFetchProvider(() => ({
      backend: 'local',
      moliPath,
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    try {
      const result = await provider.fetch({ url: baseUrl })
      expect(result.statusCode).toBe(200)
      expect(result.body.kind).toBe('text')
      const content = result.body.kind === 'text' ? result.body.content : ''
      expect(content).toMatch(/^# (Smoke page|Smoke heading)\b/m)
      expect(content).toContain('The rendered body text.')
    } finally {
      await provider.dispose()
    }
  })

  it('serves a concurrent burst as tabs over the managed Moli daemon', { timeout: 60_000 }, async () => {
    if (!moliAvailable) return

    const provider = new MoliFetchProvider(() => ({
      backend: 'local',
      moliPath,
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: true,
      maxConcurrency: 10,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
        provider.fetch({ url: `${baseUrl}?tab=${String(i)}` })))
      const ok = results.filter(entry => entry.status === 'fulfilled').length
      expect(ok).toBe(6)
    } finally {
      await provider.dispose()
    }
  })

  it('maps an unreachable page to a structured WebError', { timeout: 30_000 }, async () => {
    if (!moliAvailable) return

    const provider = new MoliFetchProvider(() => ({
      backend: 'local',
      moliPath,
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    try {
      const error = await provider.fetch({ url: 'http://127.0.0.1:1/' })
        .then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    } finally {
      await provider.dispose()
    }
  })
})
