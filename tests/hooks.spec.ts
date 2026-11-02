/**
 * Tests for the native CDP page hooks.
 *
 * These hooks are entirely best-effort by design: every CDP exchange is
 * swallowed so a browser that does not implement an Moli extension command
 * still yields a fetchable page. That makes them easy to get wrong silently —
 * a swallowed error is indistinguishable from "the command worked" — and before
 * this file nothing in the suite touched them at all (the provider's fake page
 * defines no `send`/`captureScreenshot`, so every hook call in the provider
 * tests was a no-op).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CARD_ITEMS_SELECTOR,
  MICRO_CLIP_VIEWPORT,
  SENTINEL_SELECTOR,
  forceLayoutMaterialization,
  scrollIntoViewNative,
  setupPageHooks,
} from '../src/hooks.ts'
import type { CdpPage } from '../src/types.ts'

/** A page double that records every CDP command it receives. */
function recordingPage(): CdpPage & { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    calls,
    send: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return Promise.resolve({})
    },
  } as unknown as CdpPage & { calls: Array<{ method: string; params: Record<string, unknown> }> }
}

/** Look up the params a method was called with. */
function paramsOf(
  calls: Array<{ method: string; params: Record<string, unknown> }>,
  method: string,
): Record<string, unknown> | undefined {
  return calls.find(call => call.method === method)?.params
}

describe('setupPageHooks', () => {
  it('leaves certificate verification on when the option is absent', async () => {
    const page = recordingPage()
    await setupPageHooks(page)
    // The security-relevant assertion of this file: an omitted option must not
    // silently disable TLS verification. `ignore: true` here was the P1 finding.
    expect(paramsOf(page.calls, 'Security.setIgnoreCertificateErrors')).toEqual({ ignore: false })
  })

  it('leaves certificate verification on when the option is explicitly false', async () => {
    const page = recordingPage()
    await setupPageHooks(page, { ignoreCertificateErrors: false })
    expect(paramsOf(page.calls, 'Security.setIgnoreCertificateErrors')).toEqual({ ignore: false })
  })

  it('disables certificate verification only when explicitly requested', async () => {
    const page = recordingPage()
    await setupPageHooks(page, { ignoreCertificateErrors: true })
    expect(paramsOf(page.calls, 'Security.setIgnoreCertificateErrors')).toEqual({ ignore: true })
  })

  it('enables the CSP bypass by default', async () => {
    const page = recordingPage()
    await setupPageHooks(page)
    expect(paramsOf(page.calls, 'Page.setBypassCSP')).toEqual({ enabled: true })
  })

  it('disables the CSP bypass only when explicitly false', async () => {
    const page = recordingPage()
    await setupPageHooks(page, { bypassCsp: false })
    expect(paramsOf(page.calls, 'Page.setBypassCSP')).toEqual({ enabled: false })
  })

  it('always bypasses the Service Worker cache', async () => {
    const page = recordingPage()
    await setupPageHooks(page, { bypassCsp: false, ignoreCertificateErrors: false })
    // Stale-SW reads would defeat the point of a live fetch, so this one is not
    // configurable and must survive regardless of the other options.
    expect(paramsOf(page.calls, 'Network.setBypassServiceWorker')).toEqual({ bypass: true })
  })

  it('keeps the two toggles independent', async () => {
    const page = recordingPage()
    await setupPageHooks(page, { bypassCsp: false, ignoreCertificateErrors: true })
    expect(paramsOf(page.calls, 'Page.setBypassCSP')).toEqual({ enabled: false })
    expect(paramsOf(page.calls, 'Security.setIgnoreCertificateErrors')).toEqual({ ignore: true })
  })

  it('resolves even when every CDP command rejects', async () => {
    const page = {
      send: () => Promise.reject(new Error('method not found')),
    } as unknown as CdpPage
    // Cross-engine compatibility: a CDP implementation without these commands
    // (or a detached target) must not fail the fetch before navigation.
    await expect(setupPageHooks(page)).resolves.toBeUndefined()
  })

  it('resolves on a page double with no send method at all', async () => {
    await expect(setupPageHooks({} as CdpPage)).resolves.toBeUndefined()
  })
})

describe('forceLayoutMaterialization', () => {
  it('uses the 1x1 micro-clip so no full frame crosses the wire', async () => {
    const captureScreenshot = vi.fn().mockResolvedValue({ data: '' })
    const page = { captureScreenshot } as unknown as CdpPage
    await forceLayoutMaterialization(page)
    expect(captureScreenshot).toHaveBeenCalledWith({ clip: MICRO_CLIP_VIEWPORT })
    // The clip is what keeps the response at ~96 bytes instead of a 400KB+ frame.
    expect(MICRO_CLIP_VIEWPORT).toEqual({ x: 0, y: 0, width: 1, height: 1, scale: 1 })
  })

  it('falls back to the raw CDP command without captureScreenshot', async () => {
    const page = recordingPage()
    await forceLayoutMaterialization(page)
    expect(paramsOf(page.calls, 'Page.captureScreenshot')).toEqual({ clip: MICRO_CLIP_VIEWPORT })
  })

  it('swallows a rejected screenshot', async () => {
    const page = {
      captureScreenshot: () => Promise.reject(new Error('capture failed')),
    } as unknown as CdpPage
    await expect(forceLayoutMaterialization(page)).resolves.toBeUndefined()
  })
})

describe('scrollIntoViewNative', () => {
  it('returns the evaluated counters on success', async () => {
    const result = { cardsCount: 42, hasSentinel: true, scrolled: true, htmlLength: 9000 }
    const page = { evaluate: vi.fn().mockResolvedValue(result) } as unknown as CdpPage
    await expect(scrollIntoViewNative(page)).resolves.toEqual(result)
  })

  it('returns zeroed counters when evaluate throws', async () => {
    const page = { evaluate: () => Promise.reject(new Error('detached')) } as unknown as CdpPage
    // A zeroed result makes the caller stop scrolling rather than loop; it must
    // not throw, because the caller has already loaded the content it wants.
    await expect(scrollIntoViewNative(page)).resolves.toEqual({
      cardsCount: 0,
      hasSentinel: false,
      scrolled: false,
      htmlLength: 0,
    })
  })

  it('returns zeroed counters when evaluate yields a non-object', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('not an object') } as unknown as CdpPage
    await expect(scrollIntoViewNative(page)).resolves.toEqual({
      cardsCount: 0,
      hasSentinel: false,
      scrolled: false,
      htmlLength: 0,
    })
  })

  it('returns zeroed counters on a page double with no evaluate', async () => {
    await expect(scrollIntoViewNative({} as CdpPage)).resolves.toEqual({
      cardsCount: 0,
      hasSentinel: false,
      scrolled: false,
      htmlLength: 0,
    })
  })

  it('interpolates both selectors into the evaluated script', async () => {
    const evaluate = vi.fn().mockResolvedValue({ cardsCount: 0, hasSentinel: false, scrolled: false, htmlLength: 0 })
    const page = { evaluate } as unknown as CdpPage
    await scrollIntoViewNative(page)
    const script = evaluate.mock.calls[0]?.[0] as string
    // The selectors are string-interpolated into the in-page script, so a quote
    // inside either constant would break the evaluation. Pin that they land
    // verbatim and that the script stays syntactically valid JavaScript.
    expect(script).toContain(SENTINEL_SELECTOR)
    expect(script).toContain(CARD_ITEMS_SELECTOR)
    expect(() => new Function(`return ${script}`)).not.toThrow()
  })
})

describe('shared selectors', () => {
  it('excludes header and nav chrome from card counting', () => {
    // Category navbars reuse card classes; counting them would make every page
    // look like an infinite feed and keep the scroll loop alive.
    expect(CARD_ITEMS_SELECTOR).toContain(':not(header *)')
    expect(CARD_ITEMS_SELECTOR).toContain(':not(nav *)')
  })

  it('keeps the sentinel selector permissive on purpose', () => {
    // Over-matching a sentinel only adds one scrollIntoView candidate, so the
    // documented trade-off is breadth rather than precision.
    expect(SENTINEL_SELECTOR).toContain('[class*="sentinel" i]')
    expect(SENTINEL_SELECTOR).toContain('[class*="loading" i]')
  })
})
