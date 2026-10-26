/**
 * The Moli card controller: staged form over the `web-fetch-moli` settings
 * namespace, built on the platform's shared `SettingsFormModel` instead of a
 * local copy of it.
 *
 * Nothing here styles or tracks state: the model stages drafts, fences writes
 * with the revision they started from, and republishes through a snapshot
 * store. This file only says which fields the card edits and how the
 * projection is shaped.
 *
 * @module dsh-web-fetch-moli/client/controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  settingsBooleanField, settingsBoundedNumberField, settingsChoiceField,
} from './fields.ts'

/** Settings namespace this card edits. */
export const WEB_FETCH_MOLI_NS = 'web-fetch-moli'

/** The section fields this card edits. */
export interface MoliSettings {
  backend?: string
  moliPath?: string
  cdpEndpoint?: string
  shareBrowserContext?: boolean
  bypassCsp?: boolean
  autoScrollSentinel?: boolean
  denoise?: boolean
  timeoutMs?: number
  maxConcurrency?: number
  challengeWaitMs?: number
  challengeRetries?: number
}

/** What the Moli card renders. */
export interface MoliCardState extends SettingsFormShell {
  backend: SettingsFieldState
  moliPath: SettingsFieldState
  cdpEndpoint: SettingsFieldState
  shareBrowserContext: SettingsFieldState
  bypassCsp: SettingsFieldState
  autoScrollSentinel: SettingsFieldState
  denoise: SettingsFieldState
  timeoutMs: SettingsFieldState
  maxConcurrency: SettingsFieldState
  challengeWaitMs: SettingsFieldState
  challengeRetries: SettingsFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface MoliCardFace extends SettingsFormActions {
  hooks: {
    moliCard: SnapshotStore<MoliCardState>
  }
}

/** Bridges the `web-fetch-moli` settings scope onto the card. */
export class MoliCardController {
  private readonly form: SettingsFormModel<MoliSettings>
  private readonly store: SnapshotStore<MoliCardState>

  /**
   * @param scope - the shared configuration form for this card's namespace.
   */
  constructor(scope: SettingsFormScope<MoliSettings>) {
    this.form = new SettingsFormModel(scope, [
      settingsChoiceField('backend', ['local', 'cdp']),
      settingsTextField('moliPath'),
      settingsTextField('cdpEndpoint'),
      settingsBooleanField('shareBrowserContext'),
      settingsBooleanField('bypassCsp'),
      settingsBooleanField('autoScrollSentinel'),
      settingsBooleanField('denoise'),
      // Bounds mirror the Host schema ceilings in src/config.ts
      // (MAX_TIMEOUT_MS / MAX_CONCURRENCY_CEILING / MAX_CHALLENGE_WAIT_MS /
      // MAX_CHALLENGE_RETRIES). See settingsBoundedNumberField.
      settingsBoundedNumberField('timeoutMs', 1000, 300_000),
      settingsBoundedNumberField('maxConcurrency', 1, 200),
      settingsBoundedNumberField('challengeWaitMs', 0, 60_000),
      settingsBoundedNumberField('challengeRetries', 0, 3),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): MoliCardState {
    return {
      ...this.form.shell(),
      backend: this.form.field('backend'),
      moliPath: this.form.field('moliPath'),
      cdpEndpoint: this.form.field('cdpEndpoint'),
      shareBrowserContext: this.form.field('shareBrowserContext'),
      bypassCsp: this.form.field('bypassCsp'),
      autoScrollSentinel: this.form.field('autoScrollSentinel'),
      denoise: this.form.field('denoise'),
      timeoutMs: this.form.field('timeoutMs'),
      maxConcurrency: this.form.field('maxConcurrency'),
      challengeWaitMs: this.form.field('challengeWaitMs'),
      challengeRetries: this.form.field('challengeRetries'),
    }
  }

  inject(): MoliCardFace {
    return { hooks: { moliCard: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}
