/**
 * The three field specs the Moli card adds to the platform's two.
 *
 * These are the plugin's own logic — which drafts a field accepts, and what an
 * absent stored value formats as — so they are what this suite pins. The
 * staging engine underneath (`SettingsFormModel`) is the platform's and is
 * covered by its own `settings-form-model.client.spec.ts`; re-testing it here
 * would only test a copy.
 *
 * Node-safe: `src/client/fields.ts` imports the spec types type-only.
 */
import { describe, expect, it } from 'vitest'
import {
  settingsBooleanField, settingsBoundedNumberField, settingsChoiceField,
} from '../src/client/fields.ts'

describe('settingsChoiceField', () => {
  it('formats an accepted value as itself and anything else as empty', () => {
    const spec = settingsChoiceField('backend', ['local', 'cdp'])
    expect(spec.format('cdp')).toBe('cdp')
    expect(spec.format('local')).toBe('local')
    expect(spec.format('nonsense')).toBe('')
    expect(spec.format(undefined)).toBe('')
    expect(spec.format(42)).toBe('')
  })

  it('accepts only the declared options, so a stray draft blocks the save', () => {
    const spec = settingsChoiceField('backend', ['local', 'cdp'])
    expect(spec.parse('local')).toEqual({ kind: 'set', value: 'local' })
    expect(spec.parse('cdp')).toEqual({ kind: 'set', value: 'cdp' })
    expect(spec.parse('nonsense')).toBeUndefined()
    expect(spec.parse('')).toBeUndefined()
  })
})

describe('settingsBooleanField', () => {
  it('formats booleans as draft strings and absence as empty', () => {
    const spec = settingsBooleanField('denoise')
    expect(spec.format(true)).toBe('true')
    expect(spec.format(false)).toBe('false')
    // Absent, so the card can render the schema default rather than a value
    // nobody chose.
    expect(spec.format(undefined)).toBe('')
    expect(spec.format('true')).toBe('')
  })

  it('round-trips both booleans and refuses every other draft', () => {
    const spec = settingsBooleanField('denoise')
    expect(spec.parse('true')).toEqual({ kind: 'set', value: true })
    expect(spec.parse('false')).toEqual({ kind: 'set', value: false })
    for (const bad of ['', '1', '0', 'TRUE', 'yes']) {
      expect(spec.parse(bad), bad).toBeUndefined()
    }
  })
})

describe('settingsBoundedNumberField', () => {
  it('formats integers as decimals and refuses non-integers', () => {
    const spec = settingsBoundedNumberField('maxConcurrency', 1, 200)
    expect(spec.format(4)).toBe('4')
    expect(spec.format(0)).toBe('0')
    expect(spec.format(1.5)).toBe('')
    expect(spec.format(undefined)).toBe('')
  })

  it('treats an empty draft as a clear so the field re-inherits the default', () => {
    expect(settingsBoundedNumberField('timeoutMs', 1000, 300_000).parse('')).toEqual({ kind: 'clear' })
    expect(settingsBoundedNumberField('timeoutMs', 1000, 300_000).parse('   ')).toEqual({ kind: 'clear' })
  })

  it('accepts the inclusive bounds and refuses everything outside them', () => {
    const spec = settingsBoundedNumberField('challengeRetries', 0, 3)
    expect(spec.parse('0')).toEqual({ kind: 'set', value: 0 })
    expect(spec.parse('3')).toEqual({ kind: 'set', value: 3 })
    expect(spec.parse('4')).toBeUndefined()
    expect(spec.parse('-1')).toBeUndefined()
  })

  it('refuses anything that is not a whole decimal integer', () => {
    const spec = settingsBoundedNumberField('timeoutMs', 1000, 300_000)
    for (const bad of ['1.5', '2e5', '0x10', 'four', '1 2', '+5', ' 5 5']) {
      expect(spec.parse(bad), bad).toBeUndefined()
    }
  })

  it('mirrors the Host schema ceiling for every numeric field the card declares', () => {
    // These four pairs are the card's bounds; src/config.ts owns the same
    // numbers on the Host side. A change to either must change both.
    expect(settingsBoundedNumberField('timeoutMs', 1000, 300_000).parse('300001')).toBeUndefined()
    expect(settingsBoundedNumberField('timeoutMs', 1000, 300_000).parse('300000')).toEqual({ kind: 'set', value: 300_000 })
    expect(settingsBoundedNumberField('maxConcurrency', 1, 200).parse('201')).toBeUndefined()
    expect(settingsBoundedNumberField('challengeWaitMs', 0, 60_000).parse('60001')).toBeUndefined()
    expect(settingsBoundedNumberField('challengeRetries', 0, 3).parse('4')).toBeUndefined()
  })
})
