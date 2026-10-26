/**
 * The field specs the Moli card declares beyond the two the platform ships
 * (text and plain number): a boolean toggle, an option set, and a bounded
 * integer.
 *
 * Type-only import: the spec *shapes* come from the platform's settings-form
 * kit, but nothing here runs its code, so this module stays testable in Node
 * and adds no runtime dependency to the client bundle.
 *
 * @module dsh-web-fetch-moli/client/fields
 */

import type { SettingsFieldSpec } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * A boolean field. The draft carries `'true'`/`'false'`; an absent stored
 * value formats as the empty string so the control can fall back to the
 * schema default rather than inventing one.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: text => text === 'true'
      ? { kind: 'set', value: true }
      : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * A whole-number field over an inclusive range.
 *
 * The bounds mirror the ceilings the Host schema enforces in `src/config.ts`
 * (`MAX_TIMEOUT_MS` and friends). They cannot be imported here: the client
 * bundle's purity gate forbids value-importing another package's Node half,
 * so the two sides are kept in sync by hand. The Host remains the authority —
 * these bounds only stop a save the Host would refuse anyway.
 * @param field - field name inside the namespace section.
 * @param min - smallest accepted integer (inclusive).
 * @param max - largest accepted integer (inclusive).
 * @returns the field's conversion spec.
 */
export function settingsBoundedNumberField(field: string, min: number, max: number): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' && Number.isInteger(value) ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (!/^\d+$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      return value >= min && value <= max ? { kind: 'set', value } : undefined
    },
  }
}

/**
 * A field over a fixed option set. An absent or unrecognized stored value
 * formats as the empty string, which the card renders as its first option.
 * @param field - field name inside the namespace section.
 * @param values - the accepted option values.
 * @returns the field's conversion spec.
 */
export function settingsChoiceField(field: string, values: readonly string[]): SettingsFieldSpec {
  const accepted = new Set(values)
  return {
    field,
    format: value => typeof value === 'string' && accepted.has(value) ? value : '',
    parse: text => accepted.has(text) ? { kind: 'set', value: text } : undefined,
  }
}
