/**
 * Settings/config surface for the Moli fetch provider: the schemastery
 * schema the loader validates the row against, the live references a running
 * plugin reads per fetch, and the pure normalizers the provider applies.
 *
 * Every field is declared `.volatile()`, which is what the settings domain
 * enumerates: since DSH 0.1.7 it serves one form per profile entry and derives
 * that form from the volatile fields alone, so a schema without one is not
 * served at all and the bundle's configuration card never appears. Volatile
 * fields are also how a profile edit reaches the running instance without a
 * remount — the Loader patches the reference in place and emits
 * `loader/volatile-update`.
 *
 * @module dsh-web-fetch-moli/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CdpContextMode, MoliBackend } from './types.ts'

/** Default CDP endpoint when settings leaves it blank. */
export const DEFAULT_CDP_ENDPOINT = '127.0.0.1:9222'

/**
 * Default concurrency for the local Moli CDP backend: Moli consumes only ~60MB RAM
 * (over 10x lighter than standard Chromium), allowing a generous default concurrency.
 */
export const DEFAULT_MAX_CONCURRENCY_LOCAL = 20

/**
 * Default concurrency for the remote CDP backend: tabs inside an already running browser.
 */
export const DEFAULT_MAX_CONCURRENCY_CDP = 50

/** Ceiling the schema accepts for `maxConcurrency` (mirrored in src/client/controller.ts). */
export const MAX_CONCURRENCY_CEILING = 200

/**
 * Default bounded wait (ms) for a Cloudflare challenge to clear naturally.
 */
export const DEFAULT_CHALLENGE_WAIT_MS = 5_000

/** Ceiling the schema accepts for `challengeWaitMs` (mirrored in src/client/controller.ts). */
export const MAX_CHALLENGE_WAIT_MS = 60_000

/** Default same-page re-navigation attempts after a challenge wait runs out. */
export const DEFAULT_CHALLENGE_RETRIES = 0

/** Ceiling the schema accepts for `challengeRetries` (mirrored in src/client/controller.ts). */
export const MAX_CHALLENGE_RETRIES = 3

/**
 * Default per-fetch timeout budget (ms).
 * Provides generous headroom for complex micro-frontends and multi-round infinite scrolling (90,000ms).
 */
export const DEFAULT_TIMEOUT_MS = 90_000

/** Ceiling the schema accepts for `timeoutMs`, 5 minutes (mirrored in src/client/controller.ts). */
export const MAX_TIMEOUT_MS = 300_000

export type { CdpContextMode, MoliBackend } from './types.ts'

/**
 * One config field as the running plugin receives it: a volatile reference
 * under a Loader, or a plain value in a direct mount (tests, embedded use).
 */
export type LiveField<T> = Volatile<T> | T

/** Plugin config: everything optional — the schema fills the defaults. */
export interface Config {
  /** Backend selector: local Moli CDP daemon or remote CDP endpoint. */
  backend?: LiveField<MoliBackend>
  /**
   * Path to the Moli executable. Empty = auto-discover `moli` on `$PATH` or standard directories.
   */
  moliPath?: LiveField<string>
  /** CDP backend: `host:port`, `http(s)://...`, or `ws(s)://...`. Empty = default 127.0.0.1:9222. */
  cdpEndpoint?: LiveField<string>
  /**
   * CDP backend only. `true` (default): each fetch is a tab in the browser's default context,
   * retaining cookies/localStorage and persistent logins. `false`: isolated context per fetch.
   */
  shareBrowserContext?: LiveField<boolean>
  /**
   * Whether to bypass Content Security Policy (CSP) via CDP `Page.setBypassCSP`.
   * Defaults to true. Essential for micro-frontend frameworks (e.g. Alibaba Alfa / qiankun / single-spa)
   * that dynamically inject ES module scripts in sandboxed environments.
   */
  bypassCsp?: LiveField<boolean>
  /**
   * Whether to simulate IntersectionObserver sentinel visibility flips.
   * Defaults to true. Essential for Moli's structure-first geometry where scrollHeight is 0
   * and dynamic SPA card loading relies on load-more sentinels.
   */
  autoScrollSentinel?: LiveField<boolean>
  /** Whether the Readability + mdream denoise pipeline runs before markdown. */
  denoise?: LiveField<boolean>
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally.
   * `0` disables challenge waiting.
   */
  challengeWaitMs?: LiveField<number>
  /**
   * Same-page re-navigation attempts after a challenge wait window runs out.
   */
  challengeRetries?: LiveField<number>
  /**
   * Total deadline budget (ms) for a single fetch operation.
   * Defaults to 90,000ms when not configured.
   */
  timeoutMs?: LiveField<number>
  /**
   * How many fetches may render at once.
   * Blank = backend default (20 for local, 50 for remote CDP), which is why the
   * field has no schema default: an absent value is what selects that default.
   */
  maxConcurrency?: LiveField<number | undefined>
}

/**
 * The row's Config schema. Every field carries `.volatile()`: that is what
 * makes the settings domain serve this entry's form, and what lets a profile
 * edit land in the running plugin without remounting it.
 *
 * Left unannotated on purpose: the schema's own type is what the Loader infers
 * the row config from, and {@link Config} is the shape a direct mount hands in.
 */
export const Config = z.object({
  backend: z.union([z.const('local'), z.const('cdp')]).default('local').volatile(),
  moliPath: z.string().default('').volatile(),
  cdpEndpoint: z.string().default('').volatile(),
  shareBrowserContext: z.boolean().default(true).volatile(),
  bypassCsp: z.boolean().default(true).volatile(),
  autoScrollSentinel: z.boolean().default(true).volatile(),
  denoise: z.boolean().default(true).volatile(),
  timeoutMs: z.number().step(1000).min(1000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS).volatile(),
  maxConcurrency: z.number().step(1).min(1).max(MAX_CONCURRENCY_CEILING).volatile(),
  challengeWaitMs: z.number().step(100).min(0).max(MAX_CHALLENGE_WAIT_MS).default(DEFAULT_CHALLENGE_WAIT_MS).volatile(),
  challengeRetries: z.number().step(1).min(0).max(MAX_CHALLENGE_RETRIES).default(DEFAULT_CHALLENGE_RETRIES).volatile(),
})

/**
 * Complete config with every live reference read once: the plain section the
 * provider consumes, `maxConcurrency` and `timeoutMs` still optional when the
 * profile set neither.
 */
export interface ResolvedConfig {
  backend: MoliBackend
  moliPath: string
  cdpEndpoint: string
  shareBrowserContext: boolean
  bypassCsp: boolean
  autoScrollSentinel: boolean
  denoise: boolean
  timeoutMs?: number
  maxConcurrency?: number
  challengeWaitMs: number
  challengeRetries: number
}

/**
 * Read one live field: a volatile reference's current value, or the plain
 * value a direct mount handed in.
 * @param field - the field as the plugin received it, possibly absent.
 * @param fallback - value to use when the field carries none.
 * @returns the field's current value, or `fallback`.
 */
export function readLive<T>(field: LiveField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  const reference = field as { get?: () => T | undefined }
  return typeof reference.get === 'function' ? reference.get() ?? fallback : field as T
}

/**
 * Read the whole live config into the plain section the provider consumes.
 * Capture the result once per operation: a reference's value is a snapshot.
 * @param config - the plugin config as `apply` received it.
 * @returns every field's current value, with this module's defaults applied.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  return {
    backend: readLive(config?.backend, 'local'),
    moliPath: readLive(config?.moliPath, ''),
    cdpEndpoint: readLive(config?.cdpEndpoint, ''),
    shareBrowserContext: readLive(config?.shareBrowserContext, true),
    bypassCsp: readLive(config?.bypassCsp, true),
    autoScrollSentinel: readLive(config?.autoScrollSentinel, true),
    denoise: readLive(config?.denoise, true),
    timeoutMs: readLive(config?.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxConcurrency: readLive<number | undefined>(config?.maxConcurrency, undefined),
    challengeWaitMs: readLive(config?.challengeWaitMs, DEFAULT_CHALLENGE_WAIT_MS),
    challengeRetries: readLive(config?.challengeRetries, DEFAULT_CHALLENGE_RETRIES),
  }
}

/**
 * The effective timeout budget (ms) for a fetch operation.
 */
export function effectiveTimeoutMs(config: Pick<Config, 'timeoutMs'>): number {
  const timeoutMs = readLive<number | undefined>(config.timeoutMs, undefined)
  if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs
  return DEFAULT_TIMEOUT_MS
}

/**
 * The concurrency limit a fetch actually runs with.
 */
export function effectiveMaxConcurrency(config: Pick<Config, 'backend' | 'maxConcurrency'>): number {
  const maxConcurrency = readLive<number | undefined>(config.maxConcurrency, undefined)
  if (typeof maxConcurrency === 'number') return maxConcurrency
  if (readLive(config.backend, 'local') === 'cdp') return DEFAULT_MAX_CONCURRENCY_CDP
  return DEFAULT_MAX_CONCURRENCY_LOCAL
}

/**
 * The challenge wait budget a fetch actually runs with.
 */
export function effectiveChallengeWaitMs(config: Pick<Config, 'challengeWaitMs'>): number {
  const challengeWaitMs = readLive<number | undefined>(config.challengeWaitMs, undefined)
  if (typeof challengeWaitMs === 'number') return challengeWaitMs
  return DEFAULT_CHALLENGE_WAIT_MS
}

/**
 * The same-page retry count a challenge fetch actually runs with.
 */
export function effectiveChallengeRetries(config: Pick<Config, 'challengeRetries'>): number {
  const challengeRetries = readLive<number | undefined>(config.challengeRetries, undefined)
  if (typeof challengeRetries === 'number') return challengeRetries
  return DEFAULT_CHALLENGE_RETRIES
}

/**
 * The context mode a fetch runs with.
 */
export function effectiveContextMode(config: Pick<Config, 'backend' | 'shareBrowserContext'>): CdpContextMode {
  // Remote CDP connects to an existing browser profile where retaining logins is desirable.
  if (readLive(config.backend, 'local') === 'cdp' && readLive(config.shareBrowserContext, true) !== false) {
    return 'profile'
  }
  // Local managed daemon runs cleanly in isolated contexts to prevent cross-site
  // Service Worker collisions and cookie contamination between different domains/subdomains.
  return 'isolated'
}

/**
 * Normalize a configured CDP endpoint for `chromium.connectOverCDP`.
 */
export function normalizeCdpEndpoint(input: string): string {
  const trimmed = input.trim()
  const value = trimmed === '' ? DEFAULT_CDP_ENDPOINT : trimmed
  const candidate = /^wss?:\/\//i.test(value) || /^https?:\/\//i.test(value)
    ? value
    : `http://${value}`
  new URL(candidate)
  return candidate
}
