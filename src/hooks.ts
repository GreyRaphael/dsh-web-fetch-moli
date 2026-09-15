/**
 * Page-level hooks for Moli:
 * 1. Content Security Policy (CSP) bypass over CDP for micro-frontend sandboxes.
 * 2. Deep container scroll utilities for infinite scroll, virtual lists, and lazy-loading.
 *
 * @module dsh-web-fetch-moli/hooks
 */

import type { CdpPage } from './types.ts'

/**
 * Backward compatibility: formerly used for IntersectionObserver monkey patching.
 * Now obsolete as Deep Container Scrolling uses native browser DOM mechanics.
 */
export const SENTINEL_OBSERVER_INIT_SCRIPT = ''

/**
 * Result of a single deep container scrolling round.
 */
export interface DeepScrollResult {
  scrollablesCount: number
  nodes: number
  textLen: number
}

/**
 * Configure page-level hooks on a freshly opened page.
 *
 * @param page - CDP page.
 * @param options - hook options (bypassCsp).
 */
export async function setupPageHooks(
  page: CdpPage,
  options: { bypassCsp?: boolean; autoScrollSentinel?: boolean },
): Promise<void> {
  // Bypass CSP if enabled (crucial for micro-frontend dynamic script loading)
  if (options.bypassCsp !== false) {
    try {
      const context = page.context?.()
      if (typeof context?.newCDPSession === 'function') {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Page.setBypassCSP', { enabled: true })
      }
    } catch {
      // Best-effort
    }
  }
}

/**
 * Perform a single round of deep container scrolling across all scrollable DOM elements,
 * the window/document scrolling element, and the last item in the viewport.
 *
 * Discovers any element where `scrollHeight > clientHeight + 20` with `overflow-y: auto/scroll/overlay`,
 * scrolls it to the bottom, dispatches standard `scroll` events, and triggers `scrollIntoView`
 * on the trailing item for virtual-scroll and observer-driven paginations.
 *
 * @param page - CDP page.
 * @returns count of scrollables found and DOM snapshot metrics.
 */
export async function deepScrollContainers(page: CdpPage): Promise<DeepScrollResult> {
  if (typeof page.evaluate !== 'function') {
    return { scrollablesCount: 0, nodes: 0, textLen: 0 }
  }
  try {
    const res = await page.evaluate(`
      (() => {
        const docEl = document.scrollingElement || document.documentElement || document.body;
        const scrollables = [];
        if (docEl && docEl.scrollHeight > docEl.clientHeight + 20) {
          scrollables.push(docEl);
        }

        const candidates = document.querySelectorAll('div, section, article, main, aside, nav, ul, ol, pre, table');
        for (const el of candidates) {
          if (el === docEl) continue;
          if (el.clientHeight <= 0 || el.scrollHeight <= el.clientHeight + 20) continue;
          const style = window.getComputedStyle(el);
          const oy = style.overflowY || style.overflow;
          if (/(auto|scroll|overlay)/.test(oy)) {
            scrollables.push(el);
          }
        }

        for (const el of scrollables) {
          el.scrollTop = el.scrollHeight;
          try {
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch {}
        }

        const maxScrollY = document.documentElement ? document.documentElement.scrollHeight : (document.body ? document.body.scrollHeight : 999999);
        window.scrollTo(0, maxScrollY);
        try {
          window.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch {}

        const lastItem = document.querySelector(
          '[class*="card"]:last-child, [class*="item"]:last-child, [class*="model"]:last-child'
        );
        if (lastItem && typeof lastItem.scrollIntoView === 'function') {
          lastItem.scrollIntoView(false);
        }

        const nodes = document.querySelectorAll('*').length;
        const textLen = (document.body ? (document.body.textContent || '') : '').length;
        return { scrollablesCount: scrollables.length, nodes, textLen };
      })()
    `)
    if (!res || typeof res !== 'object') {
      return { scrollablesCount: 0, nodes: 0, textLen: 0 }
    }
    const r = res as Record<string, unknown>
    return {
      scrollablesCount: typeof r.scrollablesCount === 'number' ? r.scrollablesCount : 0,
      nodes: typeof r.nodes === 'number' ? r.nodes : 0,
      textLen: typeof r.textLen === 'number' ? r.textLen : 0,
    }
  } catch {
    return { scrollablesCount: 0, nodes: 0, textLen: 0 }
  }
}

/**
 * Backward-compatible trigger for load-more sentinels.
 * Delegates to Deep Container Scrolling.
 *
 * @param page - CDP page.
 * @returns number of scrollables triggered.
 */
export async function triggerSentinels(page: CdpPage): Promise<number> {
  const res = await deepScrollContainers(page)
  return res.scrollablesCount
}

/**
 * Backward-compatible helper returning active sentinel count (always 0 now).
 */
export async function getSentinelCount(_page: CdpPage): Promise<number> {
  return 0
}

/**
 * Backward-compatible helper returning IntersectionObserver count (always 0 now).
 */
export async function getIoCount(_page: CdpPage): Promise<number> {
  return 0
}
