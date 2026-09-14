/**
 * Browser client half of `dsh-web-fetch-moli`: registers the locale dictionary
 * and the plugin-configuration card keyed by the `web-fetch-moli` settings namespace.
 *
 * @module dsh-web-fetch-moli/client
 */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { MoliCardController, WEB_FETCH_MOLI_NS } from './controller.ts'
import { MoliCard } from './card.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'web-fetch-moli'

/** Required services. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the Moli plugin-configuration card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-fetch-moli: card dictionary')

  const controller = new MoliCardController(
    ctx.settingsScope.bind({ namespace: WEB_FETCH_MOLI_NS }),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: WEB_FETCH_MOLI_NS,
    locale: NS,
    inject: () => controller.inject(),
  }, MoliCard))
}
