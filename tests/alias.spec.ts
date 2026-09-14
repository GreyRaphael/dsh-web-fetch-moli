import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

describe('dsh-web-fetch-moli provider alias and Cordis integration', () => {
  it('registers both moli and playwright alias providers', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'playwright' })
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const web = ctx.web as any
    expect(web.fetchProviders.has('moli')).toBe(true)
    expect(web.fetchProviders.has('playwright')).toBe(true)
  })

  it('routes to Moli when configured fetchProvider is playwright', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'playwright' })
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const playwrightProvider = (ctx.web as any).fetchProviders.get('playwright')
    expect(playwrightProvider.available()).toBe(true)
  })

  it('routes to Moli when configured fetchProvider is moli', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const moliProvider = (ctx.web as any).fetchProviders.get('moli')
    expect(moliProvider.available()).toBe(true)

    // playwright alias should report unavailable when not configured
    const playwrightProvider = (ctx.web as any).fetchProviders.get('playwright')
    expect(playwrightProvider.available()).toBe(false)
  })

  it('playwright alias reports unavailable when unpinned (preventing WEB_PROVIDER_AMBIGUOUS)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const playwrightProvider = (ctx.web as any).fetchProviders.get('playwright')
    expect(playwrightProvider.available()).toBe(false)
  })

  it('recognizes process.env.DSH_WEB_FETCH_PROVIDER=playwright', async () => {
    const original = process.env.DSH_WEB_FETCH_PROVIDER
    try {
      process.env.DSH_WEB_FETCH_PROVIDER = 'playwright'
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      apply(ctx, { backend: 'cdp' } as unknown as Config)

      const playwrightProvider = (ctx.web as any).fetchProviders.get('playwright')
      expect(playwrightProvider.available()).toBe(true)
    } finally {
      if (original === undefined) {
        delete process.env.DSH_WEB_FETCH_PROVIDER
      } else {
        process.env.DSH_WEB_FETCH_PROVIDER = original
      }
    }
  })
})
