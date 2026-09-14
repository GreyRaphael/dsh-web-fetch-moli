/**
 * Page-level hooks for Moli:
 * 1. Content Security Policy (CSP) bypass over CDP for micro-frontend sandboxes.
 * 2. IntersectionObserver sentinel hooks for structure-first geometry lazy loading.
 *
 * @module dsh-web-fetch-moli/hooks
 */

import type { PlaywrightPage } from './types.ts'

/**
 * Script injected at document start to track IntersectionObserver sentinels
 * for programmatic visibility triggering.
 */
export const SENTINEL_OBSERVER_INIT_SCRIPT = `
(function() {
  if (window.__moliSentinelHookInstalled) return;
  window.__moliSentinelHookInstalled = true;
  window.__sentinels = new Map();
  const OrigIO = window.IntersectionObserver;
  if (!OrigIO) return;

  window.IntersectionObserver = function(callback, options) {
    const inst = new OrigIO(callback, options);
    const origObserve = inst.observe;
    const origUnobserve = inst.unobserve;

    inst.observe = function(el) {
      if (el && typeof el.className === 'string' &&
          (el.className.includes('Sentinel') || el.className.includes('sentinel') || el.className.includes('loadMore') || el.className.includes('load-more') || el.className.includes('infinite'))) {
        window.__sentinels.set(el, { inst, callback });
      }
      return origObserve.call(inst, el);
    };

    inst.unobserve = function(el) {
      window.__sentinels.delete(el);
      return origUnobserve.call(inst, el);
    };

    return inst;
  };
  window.IntersectionObserver.prototype = OrigIO.prototype;
})();
`

/**
 * Configure page-level hooks on a freshly opened page.
 *
 * @param page - Playwright page.
 * @param options - hook options (bypassCsp, autoScrollSentinel).
 */
export async function setupPageHooks(
  page: PlaywrightPage,
  options: { bypassCsp?: boolean; autoScrollSentinel?: boolean },
): Promise<void> {
  // 1. Bypass CSP if enabled (crucial for micro-frontend dynamic script loading)
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

  // 2. Install IntersectionObserver hook script
  if (options.autoScrollSentinel !== false && typeof page.addInitScript === 'function') {
    try {
      await page.addInitScript(SENTINEL_OBSERVER_INIT_SCRIPT)
    } catch {
      // Best-effort
    }
  }
}

/**
 * Programmatically flip visibility of IntersectionObserver load-more sentinels
 * to trigger dynamic content loading in Moli.
 *
 * @param page - Playwright page.
 * @returns number of sentinels triggered.
 */
export async function triggerSentinels(page: PlaywrightPage): Promise<number> {
  if (typeof page.evaluate !== 'function') return 0
  try {
    const count = await page.evaluate(`
      (() => {
        let triggered = 0;
        if (window.__sentinels) {
          for (const [el, { inst, callback }] of window.__sentinels.entries()) {
            if (el && el.isConnected) {
              callback([{ isIntersecting: false, target: el }], inst);
              callback([{ isIntersecting: true, target: el }], inst);
              triggered++;
            }
          }
        }
        return triggered;
      })()
    `)
    return typeof count === 'number' ? count : 0
  } catch {
    return 0
  }
}
