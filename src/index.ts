/**
 * `dsh-web-fetch-moli`: registers the Moli {@link MoliFetchProvider} with `ctx.web`.
 *
 * The plugin has no settings document of its own: every configurable value is
 * a volatile field of this row's Config, so the settings domain serves the
 * `web-fetch-moli` form from the profile entry and a committed edit reaches
 * the running provider through the same references.
 *
 * @module dsh-web-fetch-moli
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import { Config, effectiveTimeoutMs, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { MoliFetchProvider } from './provider.ts'
import { resolveMoliBinary } from './moli-resolve.ts'

export {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveMaxConcurrency,
  effectiveTimeoutMs,
  normalizeCdpEndpoint,
  readLive,
  resolveConfig,
} from './config.ts'
export type {
  Config as MoliFetchConfig,
  CdpContextMode,
  LiveField,
  MoliBackend,
  ResolvedConfig,
} from './config.ts'
export { CdpConnectionPool } from './cdp-pool.ts'
export type { CdpAcquireMode, CdpConnect, CdpLease } from './cdp-pool.ts'
export { MoliProcessManager, getFreePort, checkCdpEndpointHealthy } from './moli-process.ts'
export {
  CARD_ITEMS_SELECTOR,
  forceLayoutMaterialization,
  MICRO_CLIP_VIEWPORT,
  scrollIntoViewNative,
  SENTINEL_SELECTOR,
  setupPageHooks,
} from './hooks.ts'
export type { NativeScrollResult } from './hooks.ts'
export {
  DEFAULT_MOLI_CHECK_INTERVAL_MS,
  downloadLatestMoliBinary,
  fetchLatestMoliReleaseTag,
  findOnPath,
  getLocalMoliVersion,
  getMoliReleaseAsset,
  getPluginPackageVersion,
  isNewerVersion,
  MOLI_RELEASES_URL,
  MOLI_REPO_SLUG,
  parseSemVer,
  resolveCdpBackend,
  resolveMoliBinary,
  syncLatestMoliBinary,
  withFsLockRetry,
} from './moli-resolve.ts'
export type { SyncMoliOptions } from './moli-resolve.ts'
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

/**
 * Register the Moli fetch provider with `ctx.web`.
 *
 * `config` arrives with every field as a volatile reference when a Loader
 * composed this row, so the provider re-reads the section per fetch and a
 * profile edit lands without a remount. A direct mount (tests, embedding) may
 * hand in plain values instead; {@link resolveConfig} accepts both.
 * @param ctx - the plugin context that provides `ctx.web`.
 * @param config - the row's Config as the Loader resolved it.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const current = (): ResolvedConfig => resolveConfig(config)

  // Hook into tools/execute to dynamically align session/preset-scoped web_fetch.timeoutMs with Moli's configured budget
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.on('tools/execute', (exec, next) => {
      if (exec.name === 'web_fetch') {
        const tool = toolsCtx.tools.get('web_fetch', exec.agent)
        const budget = effectiveTimeoutMs(current())
        if (tool !== undefined && (typeof tool.timeoutMs !== 'number' || tool.timeoutMs < budget)) {
          tool.timeoutMs = budget
        }
      }
      return next()
    }, { prepend: true })
  })

  const provider = new MoliFetchProvider(current)
  ctx.effect(() => () => { void provider.dispose() }, 'dsh-web-fetch-moli: cleanup daemon and CDP')
  ctx.web.registerFetchProvider(provider)

  // Proactively warm up / download binary in background on plugin startup.
  // Read the resolved section, not the raw row: `config` may omit fields, while
  // the resolved section always carries the defaults.
  const initial = current()
  if (initial.backend !== 'cdp') {
    void resolveMoliBinary(initial.moliPath).catch(() => {})
  }
}
