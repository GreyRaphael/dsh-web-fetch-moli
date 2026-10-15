/**
 * Native CDP and layout hooks for Moli:
 * 1. Content Security Policy (CSP) bypass over CDP for micro-frontend sandboxes (Page.setBypassCSP).
 * 2. On-demand layout materialization (Page.captureScreenshot) and W3C standard scrollIntoView.
 *
 * Fully zero-user-script: no Monkey-Patching, no IntersectionObserver hijacking,
 * and no client-side proxy required.
 *
 * @module dsh-web-fetch-moli/hooks
 */

import type { CdpPage } from './types.ts'

/**
 * Helper to dispatch CDP command to a page or via its CDP session.
 */
async function sendCdp(page: CdpPage, method: string, params: Record<string, unknown> = {}): Promise<void> {
  try {
    if (typeof page.send === 'function') {
      await page.send(method, params)
    }
  } catch {
    // Best-effort for cross-CDP engine compatibility
  }
}

/**
 * Configure page-level CDP settings on a freshly opened page before navigation.
 * Applies the 3 essential non-default CDP configurations:
 * 1. Page.setBypassCSP: { enabled } — micro-frontend sandboxes injecting ES
 *    modules (gated by the bypassCsp setting, default true).
 * 2. Security.setIgnoreCertificateErrors: { ignore: true } — intranet /
 *    self-signed / MITM-proxy certificates must not abort the fetch.
 * 3. Network.setBypassServiceWorker: { bypass: true } — always read live
 *    content, never a stale Service Worker cache.
 *
 * (Page/Runtime/Network.enable are already sent by the CDP client's page
 * init; Emulation.setDeviceMetricsOverride [1920x1080] and
 * navigator.webdriver=false are native defaults in Moli's profile.)
 *
 * @param page - CDP page.
 * @param options - hook options (bypassCsp).
 */
export async function setupPageHooks(
  page: CdpPage,
  options: { bypassCsp?: boolean } = {},
): Promise<void> {
  const bypassCsp = options.bypassCsp !== false
  await Promise.all([
    sendCdp(page, 'Page.setBypassCSP', { enabled: bypassCsp }),
    sendCdp(page, 'Security.setIgnoreCertificateErrors', { ignore: true }),
    sendCdp(page, 'Network.setBypassServiceWorker', { bypass: true }),
  ])
}

export const MICRO_CLIP_VIEWPORT = { x: 0, y: 0, width: 1, height: 1, scale: 1 } as const

/**
 * Force Moli layout engine to materialize the layout tree and bounding boxes
 * via CDP Page.captureScreenshot.
 *
 * Micro-clip optimization: passing a 1x1 micro-clip forces Moli's Rust layout pipeline
 * to compute the full document layout tree while avoiding full-viewport rasterization
 * and transmitting 400KB+ base64 payloads over WebSocket, reducing payload to 96 bytes.
 */
export async function forceLayoutMaterialization(page: CdpPage): Promise<void> {
  const clipOpts = { clip: MICRO_CLIP_VIEWPORT }
  if (typeof page.captureScreenshot === 'function') {
    await page.captureScreenshot(clipOpts).catch(() => {})
  } else {
    await sendCdp(page, 'Page.captureScreenshot', clipOpts)
  }
}

export interface NativeScrollResult {
  cardsCount: number
  hasSentinel: boolean
  scrolled: boolean
  htmlLength: number
}

/**
 * The card/item selector shared by the scroll rounds ({@link scrollIntoViewNative}),
 * the SPA settle, and the sentinel batch wait — one constant so every site
 * counts the same elements and round-over-round growth comparisons stay
 * meaningful. Header/nav chrome is excluded so category navbars cannot pose
 * as content cards.
 */
export const CARD_ITEMS_SELECTOR = '[role="feed"] > article, [role="feed"] > div, [class*="grid" i] > div, [class*="card" i]:not(header *):not(nav *), [class*="model" i], [class*="entry" i]:not(header *):not(nav *)'

/**
 * The lazy-load sentinel selector shared by the scroll rounds
 * ({@link scrollIntoViewNative}) and the skip-scroll precheck — one constant
 * so both look for the same trigger elements. Kept permissive (class AND id,
 * including `[class*="loading"]`): for scroll targeting, over-matching only
 * means an extra scrollIntoView candidate. The SPA settle uses a deliberately
 * narrower variant (see provider.settleDynamicSpa).
 */
export const SENTINEL_SELECTOR = '[class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i], [class*="loading" i], [id*="sentinel" i], [id*="loadmore" i]'

/**
 * Execute native W3C standard scrollIntoView({ block: 'end', inline: 'nearest' })
 * on infinite scroll sentinels or trailing cards.
 */
export async function scrollIntoViewNative(page: CdpPage): Promise<NativeScrollResult> {
  if (typeof page.evaluate !== 'function') {
    return { cardsCount: 0, hasSentinel: false, scrolled: false, htmlLength: 0 }
  }
  try {
    const res = await page.evaluate(`
      (() => {
        const sentinel = document.querySelector('${SENTINEL_SELECTOR}');
        const cards = document.querySelectorAll(
          '${CARD_ITEMS_SELECTOR}'
        );
        let target = sentinel || (cards.length > 0 ? cards[cards.length - 1] : null);
        if (!target) {
          const main = document.querySelector('main, article, [role="main"]') || document.body;
          if (main && main.lastElementChild) {
            target = main.lastElementChild;
          }
        }
        let scrolled = false;
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'end', inline: 'nearest' });
          scrolled = true;
        }
        return {
          cardsCount: cards.length,
          hasSentinel: Boolean(sentinel),
          scrolled,
          htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0,
        };
      })()
    `)
    if (typeof res === 'object' && res !== null) {
      return res as NativeScrollResult
    }
    return { cardsCount: 0, hasSentinel: false, scrolled: false, htmlLength: 0 }
  } catch {
    return { cardsCount: 0, hasSentinel: false, scrolled: false, htmlLength: 0 }
  }
}
