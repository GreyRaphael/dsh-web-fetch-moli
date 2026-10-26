import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { apply, MOLI_FETCH_PROVIDER_ID, WEB_FETCH_MOLI_SETTINGS_NAMESPACE } from '../src/index.ts'
import { Config, effectiveTimeoutMs, resolveConfig, type ResolvedConfig } from '../src/config.ts'

describe('dsh-web-fetch-moli Cordis integration', () => {
  it('registers moli fetch provider into ctx.web', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, { backend: 'cdp' } as Config)

    const web = ctx.web as any
    expect(web.fetchProviders.has(MOLI_FETCH_PROVIDER_ID)).toBe(true)
    const moliProvider = web.fetchProviders.get(MOLI_FETCH_PROVIDER_ID)
    expect(moliProvider.available()).toBe(true)
  })

  it('resolves moli when fetchProvider is configured to moli', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, { backend: 'cdp' } as Config)

    const provider = (ctx.web as any).fetchProviders.get('moli')
    expect(provider.id).toBe('moli')
    expect(provider.available()).toBe(true)
  })

  it('dynamically aligns web_fetch tool timeout with moli budget on tools/execute', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })

    const toolDef: { name: string; timeoutMs?: number } = { name: 'web_fetch', timeoutMs: 30000 }
    const toolsService = {
      get: (name: string, _agent?: unknown) => {
        if (name === 'web_fetch') return toolDef
        return undefined
      },
    }
    ctx.provide('tools', toolsService)

    apply(ctx, { backend: 'cdp', timeoutMs: 60000 } as Config)
    await Promise.resolve()

    expect(toolDef.timeoutMs).toBe(30000)

    let executed = false
    await (ctx as any).waterfall('tools/execute', { name: 'web_fetch' }, async () => {
      executed = true
      return { status: 200 }
    })

    expect(executed).toBe(true)
    expect(toolDef.timeoutMs).toBe(60000)
  })

  it('serves the settings form for its own row, with every field volatile', async () => {
    // What the settings domain serves is derived from the schema alone: a
    // field without `.volatile()` would be missing from the form, and a schema
    // with no volatile field would not be served at all.
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    apply(ctx, Config({ backend: 'cdp' }) as Config)

    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict
    expect(Object.keys(dict).sort()).toEqual([
      'autoScrollSentinel', 'backend', 'bypassCsp', 'cdpEndpoint', 'challengeRetries',
      'challengeWaitMs', 'denoise', 'maxConcurrency', 'moliPath', 'shareBrowserContext', 'timeoutMs',
    ].sort())
    for (const field of Object.keys(dict)) expect(dict[field]?.meta?.volatile).toBe(true)
    expect(WEB_FETCH_MOLI_SETTINGS_NAMESPACE).toBe('web-fetch-moli')
  })

  it('reads a live edit at the next operation without re-registering the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })
    const toolDef: { name: string; timeoutMs?: number } = { name: 'web_fetch' }
    ctx.provide('tools', { get: (name: string) => name === 'web_fetch' ? toolDef : undefined })

    // Stands in for the Loader: the row keeps the same Config-shaped fields and
    // a committed edit swaps in a freshly resolved reference. A reader that
    // captured the section once would keep reporting 60s below.
    const live: { current: Config } = { current: Config({ backend: 'cdp', timeoutMs: 60_000 }) }
    apply(ctx, {
      get backend() { return live.current.backend },
      get timeoutMs() { return live.current.timeoutMs },
    })
    await Promise.resolve()

    await (ctx as any).waterfall('tools/execute', { name: 'web_fetch' }, async () => ({ status: 200 }))
    expect(toolDef.timeoutMs).toBe(60_000)

    live.current = Config({ backend: 'cdp', timeoutMs: 120_000 })
    await (ctx as any).waterfall('tools/execute', { name: 'web_fetch' }, async () => ({ status: 200 }))
    expect(toolDef.timeoutMs).toBe(120_000)
  })

  it('falls back to the documented defaults in a direct mount that omits fields', () => {
    const resolved: ResolvedConfig = resolveConfig({})
    expect(resolved.backend).toBe('local')
    expect(resolved.timeoutMs).toBe(90_000)
    expect(resolved.maxConcurrency).toBeUndefined()
  })
})
