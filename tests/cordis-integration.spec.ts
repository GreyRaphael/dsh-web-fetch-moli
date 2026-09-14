import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { apply, MOLI_FETCH_PROVIDER_ID } from '../src/index.ts'
import type { Config } from '../src/config.ts'

describe('dsh-web-fetch-moli Cordis integration', () => {
  it('registers moli fetch provider into ctx.web', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const web = ctx.web as any
    expect(web.fetchProviders.has(MOLI_FETCH_PROVIDER_ID)).toBe(true)
    const moliProvider = web.fetchProviders.get(MOLI_FETCH_PROVIDER_ID)
    expect(moliProvider.available()).toBe(true)
  })

  it('resolves moli when fetchProvider is configured to moli', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, { backend: 'cdp' } as unknown as Config)

    const provider = (ctx.web as any).fetchProviders.get('moli')
    expect(provider.id).toBe('moli')
    expect(provider.available()).toBe(true)
  })
})
