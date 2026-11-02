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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
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
 * Extra headroom added to `web_fetch`'s tool budget on top of the provider's
 * own deadline.
 *
 * `timeoutMs` is declarative metadata (`ToolDefinition.timeoutMs`): the platform's
 * `timeout-policy` plugin reads it and arms its own `TOOL_TIMEOUT` deadline around
 * dispatch, while this provider arms its own deadline from the same config value.
 * If both were equal they would fire in the same tick and whichever timer ran
 * first would decide the code — `TOOL_TIMEOUT` would then replace the more
 * specific `WEB_FETCH_TIMEOUT`, and the caller would lose the reason the fetch
 * actually failed. Keeping the tool budget strictly larger guarantees the
 * provider's deadline expires first and owns the classification, while the tool
 * layer stays a backstop for a provider that never settles at all.
 */
const TOOL_BUDGET_HEADROOM_MS = 5_000

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

  // `web_fetch` is declared by `tool-web` with a 30s default budget, but this
  // provider's deadline is configurable up to MAX_TIMEOUT_MS. A moli fetch that
  // legitimately needs 90s would otherwise be killed by the tool layer at 30s.
  //
  // The budget has to be adjusted on the resolved per-agent tool definition
  // because that is the object `timeout-policy` reads, and it is a shared
  // registry object — so every write is recorded and undone on unload. Without
  // the restore, an unload or a lowered setting would leave the tool carrying a
  // raised budget forever, and a later remount would treat that as the baseline.
  const originalTimeouts = new Map<ToolDefinition, number | undefined>()
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.on('tools/execute', (exec, next) => {
      if (exec.name === 'web_fetch') {
        const tool = toolsCtx.tools.get('web_fetch', exec.agent)
        if (tool !== undefined) {
          const budget = effectiveTimeoutMs(current()) + TOOL_BUDGET_HEADROOM_MS
          if (typeof tool.timeoutMs !== 'number' || tool.timeoutMs < budget) {
            if (!originalTimeouts.has(tool)) originalTimeouts.set(tool, tool.timeoutMs)
            tool.timeoutMs = budget
          }
        }
      }
      return next()
    }, { prepend: true })

    toolsCtx.effect(() => () => {
      for (const [tool, timeoutMs] of originalTimeouts) {
        if (timeoutMs === undefined) delete tool.timeoutMs
        else tool.timeoutMs = timeoutMs
      }
      originalTimeouts.clear()
    }, 'dsh-web-fetch-moli: restore tool budgets')
  })

  const provider = new MoliFetchProvider(current)
  ctx.effect(() => () => {
    // Teardown is best-effort by contract (a disposer that rejects would abort
    // the rest of the unload), but a silent rejection leaves no trace at all.
    void provider.dispose().catch((error: unknown) => {
      console.warn('[dsh-web-fetch-moli] cleanup failed:', error)
    })
  }, 'dsh-web-fetch-moli: cleanup daemon and CDP')
  ctx.web.registerFetchProvider(provider)

  // Proactively warm up / download binary in background on plugin startup.
  // Read the resolved section, not the raw row: `config` may omit fields, while
  // the resolved section always carries the defaults.
  const initial = current()
  if (initial.backend !== 'cdp') {
    void resolveMoliBinary(initial.moliPath).catch(() => {})
  }
}
