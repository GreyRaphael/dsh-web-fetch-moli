/**
 * Config schema defaults, CDP endpoint normalizer, and concurrency limits for Moli.
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_CLI,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  MAX_CHALLENGE_RETRIES,
  MAX_CHALLENGE_WAIT_MS,
  MAX_CONCURRENCY_CEILING,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveMaxConcurrency,
  normalizeCdpEndpoint,
} from '../src/config.ts'

describe('Config', () => {
  it('fills every field default it owns (maxConcurrency stays optional)', () => {
    const resolved = Config({})
    expect(resolved).toEqual({
      backend: 'local',
      moliPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      bypassCsp: true,
      autoScrollSentinel: true,
      denoise: true,
      challengeWaitMs: DEFAULT_CHALLENGE_WAIT_MS,
      challengeRetries: DEFAULT_CHALLENGE_RETRIES,
    })
  })

  it('accepts a full CDP section unchanged', () => {
    const resolved = Config({
      backend: 'cdp',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      bypassCsp: false,
      autoScrollSentinel: false,
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
    })
    expect(resolved).toEqual({
      backend: 'cdp',
      moliPath: '',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      bypassCsp: false,
      autoScrollSentinel: false,
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
    })
  })

  it('accepts maxConcurrency across its whole integer range and rejects outside it', () => {
    expect(Config({ maxConcurrency: 1 }).maxConcurrency).toBe(1)
    expect(Config({ maxConcurrency: MAX_CONCURRENCY_CEILING }).maxConcurrency).toBe(MAX_CONCURRENCY_CEILING)
    expect(() => Config({ maxConcurrency: 0 })).toThrow()
    expect(() => Config({ maxConcurrency: MAX_CONCURRENCY_CEILING + 1 })).toThrow()
    expect(() => Config({ maxConcurrency: 2.5 })).toThrow()
  })

  it('accepts the challenge knobs across their ranges, rejects outside them', () => {
    expect(Config({ challengeWaitMs: 0 }).challengeWaitMs).toBe(0)
    expect(Config({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS }).challengeWaitMs).toBe(MAX_CHALLENGE_WAIT_MS)
    expect(() => Config({ challengeWaitMs: -1 })).toThrow()
    expect(() => Config({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS + 1 })).toThrow()
    expect(Config({ challengeRetries: 0 }).challengeRetries).toBe(0)
    expect(Config({ challengeRetries: MAX_CHALLENGE_RETRIES }).challengeRetries).toBe(MAX_CHALLENGE_RETRIES)
    expect(() => Config({ challengeRetries: -1 })).toThrow()
    expect(() => Config({ challengeRetries: MAX_CHALLENGE_RETRIES + 1 })).toThrow()
  })
})

describe('effective challenge knobs', () => {
  it('an explicit wait wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 0 })).toBe(0)
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 7_500 })).toBe(7_500)
    expect(effectiveChallengeWaitMs({})).toBe(DEFAULT_CHALLENGE_WAIT_MS)
  })

  it('an explicit retry count wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeRetries({ challengeRetries: 0 })).toBe(0)
    expect(effectiveChallengeRetries({ challengeRetries: 3 })).toBe(3)
    expect(effectiveChallengeRetries({})).toBe(DEFAULT_CHALLENGE_RETRIES)
  })
})

describe('effectiveMaxConcurrency', () => {
  it('defaults per backend: local Moli, remote CDP, and CLI', () => {
    expect(effectiveMaxConcurrency({ backend: 'local' })).toBe(DEFAULT_MAX_CONCURRENCY_LOCAL)
    expect(effectiveMaxConcurrency({ backend: 'cdp' })).toBe(DEFAULT_MAX_CONCURRENCY_CDP)
    expect(effectiveMaxConcurrency({ backend: 'cli' })).toBe(DEFAULT_MAX_CONCURRENCY_CLI)
    expect(DEFAULT_MAX_CONCURRENCY_CDP).toBeGreaterThan(DEFAULT_MAX_CONCURRENCY_LOCAL)
    expect(DEFAULT_MAX_CONCURRENCY_LOCAL).toBeGreaterThan(DEFAULT_MAX_CONCURRENCY_CLI)
  })

  it('an explicit setting wins over all backend defaults', () => {
    expect(effectiveMaxConcurrency({ backend: 'local', maxConcurrency: 50 })).toBe(50)
    expect(effectiveMaxConcurrency({ backend: 'cdp', maxConcurrency: 2 })).toBe(2)
    expect(effectiveMaxConcurrency({ backend: 'cli', maxConcurrency: 15 })).toBe(15)
  })
})

describe('effectiveContextMode', () => {
  it('shares the profile by default; an explicit opt-out isolates', () => {
    expect(effectiveContextMode({ backend: 'cdp' })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: true })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: false })).toBe('isolated')
    expect(effectiveContextMode({ backend: 'local' })).toBe('profile')
    expect(effectiveContextMode({ backend: 'local', shareBrowserContext: false })).toBe('isolated')
  })
})

describe('normalizeCdpEndpoint', () => {
  it('defaults a blank endpoint to the loopback address', () => {
    expect(normalizeCdpEndpoint('')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
    expect(normalizeCdpEndpoint('   ')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
  })

  it('prefixes bare host:port with the http scheme', () => {
    expect(normalizeCdpEndpoint('127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('browser.internal:9222')).toBe('http://browser.internal:9222')
  })

  it('passes http(s)/ws(s) endpoints through', () => {
    expect(normalizeCdpEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('https://browser.corp:9222')).toBe('https://browser.corp:9222')
    expect(normalizeCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc')).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
  })

  it('rejects unparseable values', () => {
    expect(() => normalizeCdpEndpoint('http://')).toThrow()
    expect(() => normalizeCdpEndpoint('://missing-host')).toThrow()
  })
})
