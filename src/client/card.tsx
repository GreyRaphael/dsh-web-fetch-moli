/**
 * The Moli plugin configuration card:
 * Streamlined backend selection (Local Moli daemon, Remote CDP, One-shot CLI),
 * with non-redundant feature toggles (CSP bypass, infinite-scroll sentinels,
 * browser context isolation, denoise pipeline) and resource controls.
 *
 * @module dsh-web-fetch-moli/client/card
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { CheckboxField, RadioGroupField, ValueField } from './fields.tsx'
import type { MoliCardFace } from './controller.ts'

export type MoliCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'web-fetch-moli'>
  & InjectFace<MoliCardFace>

export function MoliCard(props: MoliCardProps) {
  const { t } = props
  const state = props.useMoliCard(snapshot => snapshot)
  const disabled = !state.writable
  const backend = state.backend.text === 'cdp' ? 'cdp' : 'local'

  const bindValue = (
    field: 'moliPath' | 'cdpEndpoint' | 'timeoutMs' | 'maxConcurrency' | 'challengeWaitMs',
    options?: { id?: string; embedded?: boolean; disabled?: boolean; placeholder?: string },
  ) => (
    <ValueField
      id={options?.id ?? `plugin-config-moli-${field}`}
      embedded={options?.embedded}
      label={t(field)}
      hint={t(`${field}Hint` as any)}
      placeholder={options?.placeholder ?? (t(`${field}Placeholder` as any) || '')}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('invalidText')}
      disabled={options?.disabled ?? disabled}
      {...state[field]}
      onEdit={(text) => { props.edit(field, text) }}
      onReset={() => { props.resetField(field) }}
    />
  )

  const bindCheckbox = (
    field: 'bypassCsp' | 'autoScrollSentinel' | 'shareBrowserContext' | 'denoise',
    options?: { id?: string; embedded?: boolean; disabled?: boolean },
  ) => (
    <CheckboxField
      id={options?.id ?? `plugin-config-moli-${field}`}
      embedded={options?.embedded}
      label={t(field)}
      hint={t(`${field}Hint` as any)}
      checked={state[field].text !== 'false'}
      overridden={state[field].overridden}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      disabled={options?.disabled ?? disabled}
      onEdit={(text) => { props.edit(field, text) }}
      onReset={() => { props.resetField(field) }}
    />
  )

  return (
    <PluginCard
      copy={{
        expand: t('expand'),
        collapse: t('collapse'),
        unsaved: t('unsaved'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        discard: t('discard'),
        save: t('save'),
        saving: t('saving'),
      }}
      title={t('title')}
      description={t('description')}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <RadioGroupField
        label={t('backendLabel')}
        options={[
          {
            value: 'local',
            label: t('backendLocal'),
            hint: t('backendLocalHint'),
            content: bindValue('moliPath', {
              id: 'plugin-config-moli-path-local',
              embedded: true,
              disabled: disabled || backend !== 'local',
            }),
          },
          {
            value: 'cdp',
            label: t('backendCdp'),
            hint: t('backendCdpHint'),
            content: (
              <>
                {bindValue('cdpEndpoint', {
                  id: 'plugin-config-moli-cdp',
                  embedded: true,
                  disabled: disabled || backend !== 'cdp',
                  placeholder: '127.0.0.1:9222',
                })}
                {bindCheckbox('shareBrowserContext', {
                  id: 'plugin-config-moli-share-context',
                  embedded: true,
                  disabled: disabled || backend !== 'cdp',
                })}
              </>
            ),
          },
        ]}
        text={state.backend.text}
        overridden={state.backend.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('backend', text) }}
        onReset={() => { props.resetField('backend') }}
      />

      {bindCheckbox('bypassCsp')}
      {bindCheckbox('autoScrollSentinel')}
      {bindCheckbox('denoise')}
      {bindValue('timeoutMs')}
      {bindValue('maxConcurrency')}
      {bindValue('challengeWaitMs')}
    </PluginCard>
  )
}
