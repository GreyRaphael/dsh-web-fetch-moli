/**
 * The Moli plugin configuration card:
 * Backend selection (Local Moli daemon, Remote CDP, One-shot CLI) with nested options,
 * CSP bypass and sentinel hooks, denoise toggle, and concurrency controls.
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
  const backend = state.backend.text === 'cdp' ? 'cdp' : state.backend.text === 'cli' ? 'cli' : 'local'

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
            content: (
              <>
                <ValueField
                  embedded
                  id="plugin-config-moli-path-local"
                  label={t('moliPath')}
                  hint={t('moliPathHint')}
                  placeholder={t('moliPathPlaceholder')}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  invalidLabel={t('invalidText')}
                  disabled={disabled || backend !== 'local'}
                  {...state.moliPath}
                  onEdit={(text) => { props.edit('moliPath', text) }}
                  onReset={() => { props.resetField('moliPath') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-bypass-csp-local"
                  label={t('bypassCsp')}
                  hint={t('bypassCspHint')}
                  checked={state.bypassCsp.text !== 'false'}
                  overridden={state.bypassCsp.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'local'}
                  onEdit={(text) => { props.edit('bypassCsp', text) }}
                  onReset={() => { props.resetField('bypassCsp') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-sentinel-local"
                  label={t('autoScrollSentinel')}
                  hint={t('autoScrollSentinelHint')}
                  checked={state.autoScrollSentinel.text !== 'false'}
                  overridden={state.autoScrollSentinel.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'local'}
                  onEdit={(text) => { props.edit('autoScrollSentinel', text) }}
                  onReset={() => { props.resetField('autoScrollSentinel') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-share-context-local"
                  label={t('shareBrowserContext')}
                  hint={t('shareBrowserContextHint')}
                  checked={state.shareBrowserContext.text !== 'false'}
                  overridden={state.shareBrowserContext.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'local'}
                  onEdit={(text) => { props.edit('shareBrowserContext', text) }}
                  onReset={() => { props.resetField('shareBrowserContext') }}
                />
              </>
            ),
          },
          {
            value: 'cdp',
            label: t('backendCdp'),
            hint: t('backendCdpHint'),
            content: (
              <>
                <ValueField
                  embedded
                  id="plugin-config-moli-cdp"
                  label={t('cdpEndpoint')}
                  hint={t('cdpEndpointHint')}
                  placeholder="127.0.0.1:9222"
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  invalidLabel={t('invalidText')}
                  disabled={disabled || backend !== 'cdp'}
                  {...state.cdpEndpoint}
                  onEdit={(text) => { props.edit('cdpEndpoint', text) }}
                  onReset={() => { props.resetField('cdpEndpoint') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-bypass-csp-cdp"
                  label={t('bypassCsp')}
                  hint={t('bypassCspHint')}
                  checked={state.bypassCsp.text !== 'false'}
                  overridden={state.bypassCsp.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'cdp'}
                  onEdit={(text) => { props.edit('bypassCsp', text) }}
                  onReset={() => { props.resetField('bypassCsp') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-sentinel-cdp"
                  label={t('autoScrollSentinel')}
                  hint={t('autoScrollSentinelHint')}
                  checked={state.autoScrollSentinel.text !== 'false'}
                  overridden={state.autoScrollSentinel.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'cdp'}
                  onEdit={(text) => { props.edit('autoScrollSentinel', text) }}
                  onReset={() => { props.resetField('autoScrollSentinel') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-moli-share-context-cdp"
                  label={t('shareBrowserContext')}
                  hint={t('shareBrowserContextHint')}
                  checked={state.shareBrowserContext.text !== 'false'}
                  overridden={state.shareBrowserContext.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'cdp'}
                  onEdit={(text) => { props.edit('shareBrowserContext', text) }}
                  onReset={() => { props.resetField('shareBrowserContext') }}
                />
              </>
            ),
          },
          {
            value: 'cli',
            label: t('backendCli'),
            hint: t('backendCliHint'),
            content: (
              <ValueField
                embedded
                id="plugin-config-moli-path-cli"
                label={t('moliPath')}
                hint={t('moliPathHint')}
                placeholder={t('moliPathPlaceholder')}
                overriddenLabel={t('overridden')}
                resetLabel={t('reset')}
                invalidLabel={t('invalidText')}
                disabled={disabled || backend !== 'cli'}
                {...state.moliPath}
                onEdit={(text) => { props.edit('moliPath', text) }}
                onReset={() => { props.resetField('moliPath') }}
              />
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
      <CheckboxField
        id="plugin-config-moli-denoise"
        label={t('denoise')}
        hint={t('denoiseHint')}
        checked={state.denoise.text !== 'false'}
        overridden={state.denoise.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('denoise', text) }}
        onReset={() => { props.resetField('denoise') }}
      />
      <ValueField
        id="plugin-config-moli-concurrency"
        label={t('maxConcurrency')}
        hint={t('maxConcurrencyHint')}
        placeholder={t('maxConcurrencyPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.maxConcurrency}
        onEdit={(text) => { props.edit('maxConcurrency', text) }}
        onReset={() => { props.resetField('maxConcurrency') }}
      />
      <ValueField
        id="plugin-config-moli-challenge-wait"
        label={t('challengeWaitMs')}
        hint={t('challengeWaitMsHint')}
        placeholder={t('challengeWaitMsPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.challengeWaitMs}
        onEdit={(text) => { props.edit('challengeWaitMs', text) }}
        onReset={() => { props.resetField('challengeWaitMs') }}
      />
    </PluginCard>
  )
}
