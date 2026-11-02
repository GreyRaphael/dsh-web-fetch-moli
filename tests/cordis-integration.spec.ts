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

  /**
   * The budget is raised so the provider's own deadline always expires first
   * (`WEB_FETCH_TIMEOUT`), with the tool layer as a backstop. Equal budgets
   * would race and let `TOOL_TIMEOUT` mask the specific code.
   */
  it('aligns the web_fetch tool budget strictly above the provider deadline', async () => {
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
    expect(toolDef.timeoutMs).toBeGreaterThan(60000)
  })

  /**
   * The registry object is shared, so a mutation that outlives the plugin leaks
   * into whatever mounts next and into every other agent scope reading the same
   * definition. Unload must put it back.
   */
  it('restores the tool budget on dispose instead of leaving it raised', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'moli' })

    const toolDef: { name: string; timeoutMs?: number } = { name: 'web_fetch', timeoutMs: 30000 }
    ctx.provide('tools', { get: (name: string) => name === 'web_fetch' ? toolDef : undefined })

    // Mount through a real fiber so the plugin's effects have an owner to be
    // disposed with; `apply()` alone would register them on ctx and never run
    // the cleanup this test is about.
    const fiber = await ctx.plugin({ name: 'dsh-web-fetch-moli-under-test', inject: ['web'], apply },
      { backend: 'cdp', timeoutMs: 60000 } as Config)

    await (ctx as any).waterfall('tools/execute', { name: 'web_fetch' }, async () => ({ status: 200 }))
    expect(toolDef.timeoutMs).toBeGreaterThan(60000)

    await fiber.dispose()
    expect(toolDef.timeoutMs).toBe(30000)
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
      'challengeWaitMs', 'denoise', 'ignoreCertificateErrors', 'maxConcurrency', 'moliPath',
      'shareBrowserContext', 'timeoutMs',
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
    expect(toolDef.timeoutMs).toBeGreaterThan(60_000)
    const firstBudget = toolDef.timeoutMs

    live.current = Config({ backend: 'cdp', timeoutMs: 120_000 })
    await (ctx as any).waterfall('tools/execute', { name: 'web_fetch' }, async () => ({ status: 200 }))
    // The raised budget tracks the live value rather than sticking at the first
    // reading — a captured snapshot would leave it at `firstBudget` forever.
    expect(toolDef.timeoutMs).toBeGreaterThan(120_000)
    expect(toolDef.timeoutMs).not.toBe(firstBudget)
  })

  it('falls back to the documented defaults in a direct mount that omits fields', () => {
    const resolved: ResolvedConfig = resolveConfig({})
    expect(resolved.backend).toBe('local')
    expect(resolved.timeoutMs).toBe(90_000)
    expect(resolved.maxConcurrency).toBeUndefined()
  })
})
