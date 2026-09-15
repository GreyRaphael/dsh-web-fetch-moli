/**
 * Settings/config surface for the Moli fetch provider: the schemastery
 * schema the loader validates the row against, the settings namespace's
 * resolved shape, and pure normalizers the provider applies per fetch.
 *
 * @module dsh-web-fetch-moli/config
 */

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

/** Default concurrency for one-shot CLI execution. */
export const DEFAULT_MAX_CONCURRENCY_CLI = 8

/** Ceiling the schema accepts for `maxConcurrency`. */
export const MAX_CONCURRENCY_CEILING = 200

/**
 * Default bounded wait (ms) for a Cloudflare challenge to clear naturally.
 */
export const DEFAULT_CHALLENGE_WAIT_MS = 15_000

/** Ceiling the schema accepts for `challengeWaitMs`. */
export const MAX_CHALLENGE_WAIT_MS = 60_000

/** Default same-page re-navigation attempts after a challenge wait runs out. */
export const DEFAULT_CHALLENGE_RETRIES = 1

/** Ceiling the schema accepts for `challengeRetries`. */
export const MAX_CHALLENGE_RETRIES = 3

export type { CdpContextMode, MoliBackend } from './types.ts'

/** Plugin config: everything optional — the schema fills the defaults. */
export interface Config {
  /** Backend selector: local Moli CDP daemon, remote CDP endpoint, or one-shot CLI. */
  backend?: MoliBackend
  /**
   * Path to the Moli executable. Empty = auto-discover `moli` on `$PATH` or standard directories.
   */
  moliPath?: string
  /** CDP backend: `host:port`, `http(s)://...`, or `ws(s)://...`. Empty = default 127.0.0.1:9222. */
  cdpEndpoint?: string
  /**
   * CDP backend only. `true` (default): each fetch is a tab in the browser's default context,
   * retaining cookies/localStorage and persistent logins. `false`: isolated context per fetch.
   */
  shareBrowserContext?: boolean
  /**
   * Whether to bypass Content Security Policy (CSP) via CDP `Page.setBypassCSP`.
   * Defaults to true. Essential for micro-frontend frameworks (e.g. Alibaba Alfa / qiankun / single-spa)
   * that dynamically inject ES module scripts in sandboxed environments.
   */
  bypassCsp?: boolean
  /**
   * Whether to simulate IntersectionObserver sentinel visibility flips.
   * Defaults to true. Essential for Moli's structure-first geometry where scrollHeight is 0
   * and dynamic SPA card loading relies on load-more sentinels.
   */
  autoScrollSentinel?: boolean
  /** Whether the Readability + mdream denoise pipeline runs before markdown. */
  denoise?: boolean
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally.
   * `0` disables challenge waiting.
   */
  challengeWaitMs?: number
  /**
   * Same-page re-navigation attempts after a challenge wait window runs out.
   */
  challengeRetries?: number
  /**
   * How many fetches may render at once.
   * Blank = backend default (20 for local, 50 for remote CDP, 8 for CLI).
   */
  maxConcurrency?: number
}

export const Config: z<Config> = z.object({
  backend: z.union([z.const('local'), z.const('cdp'), z.const('cli')]).default('local'),
  moliPath: z.string().default(''),
  cdpEndpoint: z.string().default(''),
  shareBrowserContext: z.boolean().default(true),
  bypassCsp: z.boolean().default(true),
  autoScrollSentinel: z.boolean().default(true),
  denoise: z.boolean().default(true),
  maxConcurrency: z.number().step(1).min(1).max(MAX_CONCURRENCY_CEILING),
  challengeWaitMs: z.number().step(100).min(0).max(MAX_CHALLENGE_WAIT_MS).default(DEFAULT_CHALLENGE_WAIT_MS),
  challengeRetries: z.number().step(1).min(0).max(MAX_CHALLENGE_RETRIES).default(DEFAULT_CHALLENGE_RETRIES),
})

/**
 * Complete config after schemastery applies the field defaults it owns.
 */
export type ResolvedConfig = Omit<Required<Config>, 'maxConcurrency'> & { maxConcurrency?: number }

/**
 * The concurrency limit a fetch actually runs with.
 */
export function effectiveMaxConcurrency(config: Pick<Config, 'backend' | 'maxConcurrency'>): number {
  if (typeof config.maxConcurrency === 'number') return config.maxConcurrency
  if (config.backend === 'cdp') return DEFAULT_MAX_CONCURRENCY_CDP
  if (config.backend === 'cli') return DEFAULT_MAX_CONCURRENCY_CLI
  return DEFAULT_MAX_CONCURRENCY_LOCAL
}

/**
 * The challenge wait budget a fetch actually runs with.
 */
export function effectiveChallengeWaitMs(config: Pick<Config, 'challengeWaitMs'>): number {
  if (typeof config.challengeWaitMs === 'number') return config.challengeWaitMs
  return DEFAULT_CHALLENGE_WAIT_MS
}

/**
 * The same-page retry count a challenge fetch actually runs with.
 */
export function effectiveChallengeRetries(config: Pick<Config, 'challengeRetries'>): number {
  if (typeof config.challengeRetries === 'number') return config.challengeRetries
  return DEFAULT_CHALLENGE_RETRIES
}

/**
 * The context mode a fetch runs with.
 */
export function effectiveContextMode(config: Pick<Config, 'backend' | 'shareBrowserContext'>): CdpContextMode {
  if ((config.backend === 'cdp' || config.backend === 'local') && config.shareBrowserContext !== false) {
    return 'profile'
  }
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
