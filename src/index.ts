/**
 * `dsh-web-fetch-moli`: registers the Moli {@link MoliFetchProvider} with `ctx.web`
 * and exposes its settings section ('web-fetch-moli') for client configuration.
 *
 * @module dsh-web-fetch-moli
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'
import { Config } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { MoliFetchProvider } from './provider.ts'
import { resolveMoliBinary } from './moli-resolve.ts'

export {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_CLI,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveMaxConcurrency,
  normalizeCdpEndpoint,
} from './config.ts'
export type { Config as MoliFetchConfig, CdpContextMode, MoliBackend, ResolvedConfig } from './config.ts'
export { CdpConnectionPool } from './cdp-pool.ts'
export type { CdpAcquireMode, CdpConnect, CdpLease } from './cdp-pool.ts'
export { MoliProcessManager, getFreePort, checkCdpEndpointHealthy } from './moli-process.ts'
export { runMoliFetch } from './cli-runner.ts'
export { setupPageHooks, triggerSentinels } from './hooks.ts'
export { resolveCdpBackend, resolveMoliBinary, findOnPath } from './moli-resolve.ts'
export {
  CHALLENGE_DOM_PROBE,
  CHALLENGE_FINISH_RESERVE_MS,
  CHALLENGE_POLL_INTERVAL_MS,
  CHALLENGE_TITLE_RE,
  classifyChallengeHtml,
  classifyChallengeResponse,
  isChallengeCompatibleResponse,
} from './challenge.ts'
export type { ChallengeVerdict } from './challenge.ts'
export { MOLI_FETCH_PROVIDER_ID, MoliFetchProvider, WEB_FETCH_CHALLENGE_CODE } from './provider.ts'
export { htmlToMarkdown } from './markdown.ts'
export type { DenoiseMode, DenoiseResult } from './markdown.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-web-fetch-moli'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying this provider's configuration card. */
export const WEB_FETCH_MOLI_SETTINGS_NAMESPACE = 'web-fetch-moli'

/** Register the Moli fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => ResolvedConfig = () => config as ResolvedConfig
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_FETCH_MOLI_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source as () => ResolvedConfig
      },
      onChange: () => {},
    })
  })

  const provider = new MoliFetchProvider(() => current())
  ctx.effect(() => () => { void provider.dispose() }, 'dsh-web-fetch-moli: cleanup daemon and CDP')
  ctx.web.registerFetchProvider(provider)

  // Backward compatibility alias: if 'playwright' is configured as fetchProvider
  // (e.g. from existing profile cordis.patch.yml, env DSH_WEB_FETCH_PROVIDER=playwright,
  // or migration from dsh-web-fetch-playwright), route it to Moli seamlessly.
  const webRuntime = ctx.web as unknown as { fetchProviders?: Map<string, unknown> } | undefined
  if (!webRuntime?.fetchProviders?.has?.('playwright')) {
    const aliasProvider: WebFetchProvider = {
      id: 'playwright',
      available: () => {
        const configuredId = (ctx.web as unknown as { fetchProviderId?: string })?.fetchProviderId ?? process.env.DSH_WEB_FETCH_PROVIDER
        return configuredId === 'playwright' && provider.available()
      },
      fetch: (req, signal) => provider.fetch(req, signal),
    }
    ctx.web.registerFetchProvider(aliasProvider)
  }

  // Proactively warm up / download binary in background on plugin startup
  if (config.backend !== 'cdp') {
    void resolveMoliBinary(config.moliPath).catch(() => {})
  }
}
