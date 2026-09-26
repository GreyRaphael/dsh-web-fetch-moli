/**
 * Browser client half of `dsh-web-fetch-moli`: registers the locale dictionary
 * and the bundle-configuration card keyed by `dsh-web-fetch-moli`.
 *
 * @module dsh-web-fetch-moli/client
 */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MoliCardController, WEB_FETCH_MOLI_NS } from './controller.ts'
import { MoliCard } from './card.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'web-fetch-moli'

/** Bundle name matching package.json and profile bundle list. */
const BUNDLE_ID = 'dsh-web-fetch-moli'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the Moli bundle-configuration card on the Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-fetch-moli: card dictionary')

  const controller = new MoliCardController(ctx.configForms.get(WEB_FETCH_MOLI_NS))
  ctx.effect(() => () => { controller.dispose() }, 'web-fetch-moli: controller lifecycle')

  // Register into the canonical bundle config slot while served by Host
  ctx.effect(() => ctx.configForms.whileServed([WEB_FETCH_MOLI_NS], () =>
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_ID,
      locale: NS,
      inject: () => controller.inject(),
    }, MoliCard)),
  ), 'web-fetch-moli: bundle configuration')
}
