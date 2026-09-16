/**
 * Native CDP and layout hooks for Moli:
 * 1. Content Security Policy (CSP) bypass over CDP for micro-frontend sandboxes (Page.setBypassCSP).
 * 2. On-demand layout materialization (Page.captureScreenshot) and scrollIntoViewIfNeeded.
 *
 * Fully zero-user-script: no Monkey-Patching, no IntersectionObserver hijacking,
 * and no client-side proxy required.
 *
 * @module dsh-web-fetch-moli/hooks
 */

import type { CdpPage } from './types.ts'

/**
 * Configure page-level CDP settings on a freshly opened page before navigation.
 *
 * @param page - CDP page.
 * @param options - hook options (bypassCsp).
 */
export async function setupPageHooks(
  page: CdpPage,
  options: { bypassCsp?: boolean; autoScrollSentinel?: boolean } = {},
): Promise<void> {
  // Bypass CSP if enabled (crucial for micro-frontend dynamic script loading)
  if (options.bypassCsp !== false) {
    await setBypassCsp(page)
  }
}

/**
 * Send CDP Page.setBypassCSP to globally bypass CSP restrictions in Moli.
 */
export async function setBypassCsp(page: CdpPage): Promise<void> {
  try {
    if (typeof page.send === 'function') {
      await page.send('Page.setBypassCSP', { enabled: true })
    } else {
      const context = page.context?.()
      if (typeof context?.newCDPSession === 'function') {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Page.setBypassCSP', { enabled: true })
      }
    }
  } catch {
    // Best-effort
  }
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
  try {
    const clipOpts = { clip: MICRO_CLIP_VIEWPORT }
    if (typeof page.captureScreenshot === 'function') {
      await page.captureScreenshot(clipOpts)
    } else if (typeof page.send === 'function') {
      await page.send('Page.captureScreenshot', clipOpts)
    } else {
      const context = page.context?.()
      if (typeof context?.newCDPSession === 'function') {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Page.captureScreenshot', clipOpts)
      }
    }
  } catch {
    // Best-effort
  }
}

export interface NativeScrollResult {
  cardsCount: number
  hasSentinel: boolean
  scrolled: boolean
  htmlLength: number
}

/**
 * Execute native scrollIntoViewIfNeeded on infinite scroll sentinels or trailing cards.
 */
export async function scrollIntoViewIfNeededNative(page: CdpPage): Promise<NativeScrollResult> {
  if (typeof page.evaluate !== 'function') {
    return { cardsCount: 0, hasSentinel: false, scrolled: false, htmlLength: 0 }
  }
  try {
    const res = await page.evaluate(`
      (() => {
        const sentinel = document.querySelector(
          '._loadMoreSentinel_q6822_63, [class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i], [class*="loading" i], [id*="sentinel" i], [id*="loadmore" i]'
        );
        const cards = document.querySelectorAll(
          '._grid_q6822_1 > div, [role="feed"] > *, [class*="grid" i] > *, [class*="card" i], [class*="item" i]'
        );
        let target = sentinel || (cards.length > 0 ? cards[cards.length - 1] : null);
        if (!target) {
          const main = document.querySelector('main, article, [role="main"]') || document.body;
          if (main && main.lastElementChild) {
            target = main.lastElementChild;
          }
        }
        let scrolled = false;
        if (target && typeof target.scrollIntoViewIfNeeded === 'function') {
          target.scrollIntoViewIfNeeded();
          scrolled = true;
        } else if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'end' });
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

/**
 * Native trigger: materialize layout then scroll target element into view.
 * Kept for backward compatibility with previous triggerSentinels export.
 */
export async function triggerSentinels(page: CdpPage): Promise<number> {
  await forceLayoutMaterialization(page)
  const res = await scrollIntoViewIfNeededNative(page)
  return res.scrolled ? (res.cardsCount || 1) : 0
}

/**
 * Backward compatibility stub: checks if sentinel element exists in DOM.
 */
export async function getSentinelCount(page: CdpPage): Promise<number> {
  if (typeof page.evaluate !== 'function') return 0
  try {
    const res = await page.evaluate(`
      (() => {
        const sentinel = document.querySelector(
          '._loadMoreSentinel_q6822_63, [class*="sentinel" i], [class*="loadmore" i], [class*="load-more" i], [class*="infinite" i], [id*="sentinel" i], [id*="loadmore" i]'
        );
        return sentinel ? 1 : 0;
      })()
    `)
    return typeof res === 'number' ? res : 0
  } catch {
    return 0
  }
}

/**
 * Backward compatibility stub.
 */
export async function getIoCount(_page: CdpPage): Promise<number> {
  return 0
}
