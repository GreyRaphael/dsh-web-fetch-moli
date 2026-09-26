/**
 * The Moli card controller: staged form over the `web-fetch-moli` settings namespace.
 *
 * @module dsh-web-fetch-moli/client/controller
 */

import type { ConfigForm, CardShell, CardFieldState, CardActions, SnapshotStore } from './form.ts'
import { CardForm, checkboxField, numberField, radioField, textField } from './form.ts'

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
export interface MoliCardState extends CardShell {
  backend: CardFieldState
  moliPath: CardFieldState
  cdpEndpoint: CardFieldState
  shareBrowserContext: CardFieldState
  bypassCsp: CardFieldState
  autoScrollSentinel: CardFieldState
  denoise: CardFieldState
  timeoutMs: CardFieldState
  maxConcurrency: CardFieldState
  challengeWaitMs: CardFieldState
  challengeRetries: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface MoliCardFace extends CardActions {
  hooks: {
    moliCard: SnapshotStore<MoliCardState>
  }
}

/** Bridges the `web-fetch-moli` settings scope onto the card. */
export class MoliCardController {
  private readonly form: CardForm<MoliSettings>
  private readonly store: SnapshotStore<MoliCardState>

  constructor(scope: ConfigForm<MoliSettings>) {
    this.form = new CardForm(
      scope,
      [
        radioField('backend', ['local', 'cdp']),
        textField('moliPath'),
        textField('cdpEndpoint'),
        checkboxField('shareBrowserContext'),
        checkboxField('bypassCsp'),
        checkboxField('autoScrollSentinel'),
        checkboxField('denoise'),
        numberField('timeoutMs', 1000, 300_000),
        numberField('maxConcurrency', 1, 200),
        numberField('challengeWaitMs', 0, 60_000),
        numberField('challengeRetries', 0, 3),
      ],
    )
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
