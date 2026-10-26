/**
 * The Moli plugin configuration card: backend selection (local Moli daemon or
 * remote CDP), the feature toggles that matter for micro-frontend rendering,
 * and the resource controls.
 *
 * The form frame and the value controls come from
 * `@deepseek-ai/dsh-client-ui-primitives` — a module the browser shell seeds
 * into the frozen module table — so this bundle carries neither a copy of the
 * form model nor its own styling of the same widgets. Only the two shapes the
 * shared set does not cover stay local: the backend radio group (whose two
 * options gate other fields) and the override badge beside a checkbox.
 *
 * @module dsh-web-fetch-moli/client/card
 */

import {
  Checkbox, SettingsForm, SettingsValueField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MoliCardFace } from './controller.ts'
import css from './card.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: { view?: 'summary' | 'page' } }
  }
}

export type MoliCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'web-fetch-moli'>
  & InjectFace<MoliCardFace>
  & {
    view?: 'summary' | 'page'
  }

/** Fields the shared control should mark for a numeric keypad. */
const NUMERIC: ReadonlySet<string> = new Set(['timeoutMs', 'maxConcurrency', 'challengeWaitMs', 'challengeRetries'])

/** Backends in display order, paired with their copy keys. */
const BACKENDS = [
  { value: 'local', label: 'backendLocal' },
  { value: 'cdp', label: 'backendCdp' },
] as const

export function MoliCard(props: MoliCardProps) {
  const { t } = props
  if (props.view === 'summary') {
    return t('description')
  }

  const state = props.useMoliCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  const backend = state.backend.text === 'cdp' ? 'cdp' : 'local'

  const valueField = (
    field: 'moliPath' | 'cdpEndpoint' | 'timeoutMs' | 'maxConcurrency' | 'challengeWaitMs' | 'challengeRetries',
    options?: { id?: string; disabled?: boolean; placeholder?: string },
  ) => (
    <SettingsValueField
      id={options?.id ?? `plugin-config-moli-${field}`}
      label={t(field)}
      hint={t(`${field}Hint`)}
      placeholder={options?.placeholder ?? (t(`${field}Placeholder`) || '')}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('invalidText')}
      {...NUMERIC.has(field) ? { numeric: true } : {}}
      disabled={options?.disabled ?? disabled}
      {...state[field]}
      onEdit={(text) => { props.edit(field, text) }}
      onReset={() => { props.resetField(field) }}
    />
  )

  /**
   * A boolean toggle. The shipped `Checkbox` draws the box and its label but
   * not the override badge or the reset beside it, so the row supplies those
   * two: dropping them would hide the only way back to the deployment default.
   */
  const toggle = (
    field: 'denoise' | 'bypassCsp' | 'autoScrollSentinel' | 'shareBrowserContext',
    options?: { id?: string; disabled?: boolean },
  ) => {
    const off = options?.disabled ?? disabled
    const current = state[field]
    return (
      <div key={field} className={css.toggle}>
        <div className={css.toggleRow}>
          <Checkbox
            checked={current.text !== 'false'}
            label={t(field)}
            disabled={off}
            onChange={(next) => { props.edit(field, next ? 'true' : 'false') }}
          />
          {current.overridden
            ? (
              <span className={css.badges}>
                <span className={css.badge}>{t('overridden')}</span>
                <button
                  type="button"
                  className={css.reset}
                  disabled={off}
                  onClick={() => { props.resetField(field) }}
                >
                  {t('reset')}
                </button>
              </span>
            )
            : null}
        </div>
        <p className={css.hint}>{t(`${field}Hint`)}</p>
      </div>
    )
  }

  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <fieldset className={css.backend}>
        <legend className={css.backendLegend}>{t('backendLabel')}</legend>
        {BACKENDS.map(option => (
          <label key={option.value} className={css.backendOption}>
            <input
              type="radio"
              name="plugin-config-moli-backend"
              value={option.value}
              checked={backend === option.value}
              disabled={disabled}
              onChange={() => { props.edit('backend', option.value) }}
            />
            <span className={css.backendLabel}>{t(option.label)}</span>
            <span className={css.hint}>{t(`${option.label}Hint`)}</span>
          </label>
        ))}
        {state.backend.overridden
          ? (
            <button
              type="button"
              className={css.reset}
              disabled={disabled}
              onClick={() => { props.resetField('backend') }}
            >
              {t('reset')}
            </button>
          )
          : null}
      </fieldset>

      {valueField('moliPath', { disabled: disabled || backend !== 'local' })}
      {valueField('cdpEndpoint', { disabled: disabled || backend !== 'cdp', placeholder: '127.0.0.1:9222' })}
      {toggle('shareBrowserContext', { disabled: disabled || backend !== 'cdp' })}
      {toggle('bypassCsp')}
      {toggle('autoScrollSentinel')}
      {toggle('denoise')}
      {valueField('timeoutMs')}
      {valueField('maxConcurrency')}
      {valueField('challengeWaitMs')}
      {valueField('challengeRetries')}
    </SettingsForm>
  )
}
