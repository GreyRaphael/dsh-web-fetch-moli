/**
 * Form container for Moli configuration: status indicators, action controls.
 *
 * @module dsh-web-fetch-moli/client/PluginCard
 */

import type { ReactNode } from 'react'
import type { CardShell } from './form.ts'
import css from './PluginCard.module.css'

/** Copy keys the form chrome renders. */
export interface CardChromeCopy {
  readOnly: string
  saveFailed: string
  discard: string
  save: string
  saving: string
}

/** Card chrome props. */
export interface PluginCardProps {
  /** Chrome copy. */
  copy: CardChromeCopy
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render the Moli settings form container.
 * @param props - the form's copy, state, actions, and controls.
 * @returns the form container, or null when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const { state, copy } = props
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving

  return (
    <div className={css.card}>
      <div className={css.body}>
        {!state.writable ? <p className={css.readOnly} role="status">{copy.readOnly}</p> : null}
        {props.children}
        <div className={css.footer}>
          {state.failed ? <p className={css.failed} role="status">{copy.saveFailed}</p> : null}
          <button
            type="button"
            className={css.discard}
            disabled={!state.dirty || state.saving}
            onClick={props.onDiscard}
          >
            {copy.discard}
          </button>
          <button
            type="button"
            className={css.save}
            disabled={blocked}
            onClick={props.onSave}
          >
            {state.saving ? copy.saving : copy.save}
          </button>
        </div>
      </div>
    </div>
  )
}
