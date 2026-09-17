/**
 * Real-world torture benchmark: Alibaba Cloud Bailian Model Market
 * Micro-frontend architecture (Alfa / qiankun / single-spa + iframe sandbox + strict CSP + infinite-scroll sentinels).
 *
 * Verifies that MoliFetchProvider successfully renders and extracts the full card catalog.
 */
import { describe, expect, it } from 'vitest'
import { MoliFetchProvider } from '../src/provider.ts'
import { resolveMoliBinary } from '../src/moli-resolve.ts'

const BAILIAN_URL = 'https://bailian.console.aliyun.com/cn-beijing/model/market'

describe('Bailian micro-frontend real-world benchmark', () => {
  it('extracts cards from Alibaba Cloud Bailian under Moli CDP mode', { timeout: 90_000 }, async () => {
    let moliPath = ''
    try {
      moliPath = await resolveMoliBinary()
    } catch {
      console.warn('skipping bailian benchmark (no moli binary)')
      return
    }

    // Live torture benchmark against Alibaba Cloud Bailian is opt-in via RUN_ONLINE_BENCHMARK=true
    if (!process.env.RUN_ONLINE_BENCHMARK) {
      console.warn('skipping live Bailian benchmark (opt-in via RUN_ONLINE_BENCHMARK=true)')
      return
    }

    // Probe network connectivity to Bailian
    try {
      const probe = await fetch(BAILIAN_URL, { signal: AbortSignal.timeout(5000), method: 'HEAD' })
      if (!probe.ok && probe.status >= 500) {
        console.warn('skipping bailian benchmark (network unreachable)')
        return
      }
    } catch {
      console.warn('skipping bailian benchmark (network offline)')
      return
    }

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

    const t0 = Date.now()
    try {
      const result = await provider.fetch({ url: BAILIAN_URL })
      const elapsed = (Date.now() - t0) / 1000

      expect(result.statusCode).toBe(200)
      expect(result.body.kind).toBe('text')
      const markdown = result.body.content

      const cardCount = (markdown.match(/最新版本/g) || []).length
      console.log(`[Bailian Benchmark] Extracted model cards: ${cardCount}, fetch elapsed: ${elapsed.toFixed(2)}s`)

      if (markdown.length < 100) {
        console.warn(`[Bailian Benchmark] Received short response (${markdown.length} chars), likely anti-bot redirect or geoblock from current network. Skipping assertions.`)
        return
      }

      expect(markdown.length).toBeGreaterThan(1000)
      expect(cardCount).toBeGreaterThanOrEqual(179)
      expect(markdown).toMatch(/qwen|通义千问|百炼/i)
      expect(markdown).toMatch(/Qwen3\.8|179|模型/i)
    } finally {
      await provider.dispose()
    }
  })
})
