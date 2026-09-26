/**
 * The client card form model against a fake settings scope: staging, dirty
 * tracking, save writes (set/clear), failed-save retention, discard, and the
 * radio/checkbox field kinds — no browser, no DOM.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '../src/client/form.ts'
import { CardForm, checkboxField, numberField, radioField, textField } from '../src/client/form.ts'

/** Minimal reactive scope double: a snapshot, a publish path, and a write log. */
class FakeScope implements ConfigForm<Record<string, unknown>> {
  snapshot: ConfigFormSnapshot<Record<string, unknown>>
  readonly writes: Array<{ field: string; op: 'set' | 'unset'; value?: unknown }> = []
  /** When true, writes settle WITHOUT applying (a rejected Host write). */
  dropWrites = false
  private readonly listeners = new Set<() => void>()

  constructor(
    value: Record<string, unknown> = {},
    user: Record<string, unknown> = {},
    base: Record<string, unknown> = {},
  ) {
    this.snapshot = { status: 'ready', value, base, user, revision: 1, writable: true, mode: 'host' }
  }

  getSnapshot(): ConfigFormSnapshot<Record<string, unknown>> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'set', value })
    const user = { ...(this.snapshot.user as Record<string, unknown>), [field]: value }
    this.publish({ value: { ...(this.snapshot.value as Record<string, unknown>), [field]: value }, user })
  }

  async unset(field: string): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'unset' })
    const user = { ...(this.snapshot.user as Record<string, unknown>) }
    const value = { ...(this.snapshot.value as Record<string, unknown>) }
    delete user[field]
    delete value[field]
    this.publish({ value, user })
  }

  private publish(partial: Partial<ConfigFormSnapshot<Record<string, unknown>>>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

/** The card's field set: backend radio, two text inputs, two checkboxes, three numbers. */
function makeForm(scope: ConfigForm<Record<string, unknown>>) {
  return new CardForm(scope, [
    radioField('backend', ['local', 'cdp']),
    textField('moliPath'),
    checkboxField('shareBrowserContext'),
    checkboxField('denoise'),
    numberField('maxConcurrency', 1, 8),
    numberField('challengeWaitMs', 0, 60_000),
    numberField('challengeRetries', 0, 3),
  ])
}

describe('CardForm', () => {
  it('seeds field state from the scope snapshot', () => {
    const scope = new FakeScope({ backend: 'cdp', moliPath: '/usr/local/bin/moli', denoise: false })
    const form = makeForm(scope)
    expect(form.field('backend').text).toBe('cdp')
    expect(form.field('moliPath').text).toBe('/usr/local/bin/moli')
    expect(form.field('denoise').text).toBe('false')
    expect(form.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('stages an edit and marks the form dirty without touching the scope', () => {
    const scope = new FakeScope({ moliPath: '' })
    const form = makeForm(scope)
    form.actions().edit('moliPath', '/opt/moli')
    expect(form.field('moliPath').text).toBe('/opt/moli')
    expect(form.shell().dirty).toBe(true)
    expect(scope.writes).toHaveLength(0)
  })

  it('save writes staged edits through scope.set and clears the drafts on success', async () => {
    const scope = new FakeScope({ backend: 'local', moliPath: '' })
    const form = makeForm(scope)
    form.actions().edit('backend', 'cdp')
    form.actions().edit('moliPath', '/usr/local/bin/moli')
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'backend', op: 'set', value: 'cdp' },
      { field: 'moliPath', op: 'set', value: '/usr/local/bin/moli' },
    ])
    expect(form.shell().dirty).toBe(false)
    expect(form.shell().failed).toBe(false)
  })

  it('keeps drafts and flags the save when the write does not land', async () => {
    const scope = new FakeScope({ moliPath: '' })
    scope.dropWrites = true
    const form = makeForm(scope)
    form.actions().edit('moliPath', '/opt/moli')
    await form.save()
    expect(form.shell().failed).toBe(true)
    expect(form.field('moliPath').text).toBe('/opt/moli')
    expect(form.shell().dirty).toBe(true)
  })

  it('resetField stages a clear that lets the field re-inherit the composition layer', async () => {
    const scope = new FakeScope({ moliPath: '/old/path' }, { moliPath: '/old/path' }, { moliPath: '/default' })
    const form = makeForm(scope)
    form.actions().resetField('moliPath')
    expect(form.field('moliPath').overridden).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'moliPath', op: 'unset' }])
    expect(form.shell().dirty).toBe(false)
  })

  it('discard drops every staged edit', () => {
    const scope = new FakeScope({ moliPath: '/a' })
    const form = makeForm(scope)
    form.actions().edit('moliPath', '/b')
    form.actions().discard()
    expect(form.field('moliPath').text).toBe('/a')
    expect(form.shell().dirty).toBe(false)
  })

  it('radioField rejects values outside the option set and blocks the save', () => {
    const form = makeForm(new FakeScope({ backend: 'local' }))
    form.actions().edit('backend', 'whatever')
    expect(form.field('backend').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
  })

  it('checkboxField round-trips booleans through the draft strings', async () => {
    const scope = new FakeScope({ denoise: true })
    const form = makeForm(scope)
    form.actions().edit('denoise', 'false')
    expect(form.field('denoise').text).toBe('false')
    expect(form.field('denoise').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'denoise', op: 'set', value: false }])
    expect(form.field('denoise').text).toBe('false')
  })

  it('the shared-context checkbox seeds absent as empty (card renders the on default)', async () => {
    const scope = new FakeScope({ backend: 'cdp' })
    const form = makeForm(scope)
    expect(form.field('shareBrowserContext').text).toBe('')
    expect(form.field('shareBrowserContext').overridden).toBe(false)
    expect(form.shell().dirty).toBe(false)

    form.actions().edit('shareBrowserContext', 'false')
    await form.save()
    expect(scope.writes).toEqual([{ field: 'shareBrowserContext', op: 'set', value: false }])
    expect(form.field('shareBrowserContext').text).toBe('false')
    expect(form.field('shareBrowserContext').overridden).toBe(true)

    form.actions().resetField('shareBrowserContext')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'shareBrowserContext', op: 'unset' })
    expect(form.field('shareBrowserContext').text).toBe('')
  })

  it('numberField round-trips in-range integers and clears on empty', async () => {
    const scope = new FakeScope({ maxConcurrency: 4 })
    const form = makeForm(scope)
    expect(form.field('maxConcurrency').text).toBe('4')
    form.actions().edit('maxConcurrency', '6')
    expect(form.field('maxConcurrency').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'maxConcurrency', op: 'set', value: 6 }])
    form.actions().edit('maxConcurrency', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'maxConcurrency', op: 'unset' })
  })

  it('numberField rejects out-of-range and non-integer drafts, blocking the save', () => {
    const form = makeForm(new FakeScope({ maxConcurrency: 4 }))
    for (const bad of ['0', '9', '2.5', '-1', 'four', '1 2']) {
      form.actions().edit('maxConcurrency', bad)
      expect(form.field('maxConcurrency').invalid, bad).toBe(true)
      expect(form.shell().invalid, bad).toBe(true)
    }
    form.actions().discard()
  })

  it('the challenge-wait field round-trips its millisecond range, 0 included', async () => {
    const scope = new FakeScope({ challengeWaitMs: 15_000 })
    const form = makeForm(scope)
    expect(form.field('challengeWaitMs').text).toBe('15000')
    form.actions().edit('challengeWaitMs', '20000')
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    form.actions().edit('challengeWaitMs', '0')
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'challengeWaitMs', op: 'set', value: 0 }])
    form.actions().edit('challengeWaitMs', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'challengeWaitMs', op: 'unset' })
    form.actions().edit('challengeWaitMs', '60001')
    expect(form.field('challengeWaitMs').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
    form.actions().discard()
  })

  it('the challenge-retries field round-trips its 0..3 range and rejects values past the schema ceiling', async () => {
    const scope = new FakeScope({ challengeRetries: 0 })
    const form = makeForm(scope)
    expect(form.field('challengeRetries').text).toBe('0')
    form.actions().edit('challengeRetries', '3')
    expect(form.field('challengeRetries').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'challengeRetries', op: 'set', value: 3 }])
    form.actions().edit('challengeRetries', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'challengeRetries', op: 'unset' })
    for (const bad of ['4', '-1', '1.5', 'many']) {
      form.actions().edit('challengeRetries', bad)
      expect(form.field('challengeRetries').invalid, bad).toBe(true)
      expect(form.shell().invalid, bad).toBe(true)
    }
    form.actions().discard()
  })

  it('an external scope change republishes through the bound snapshot store', () => {
    const scope = new FakeScope({ moliPath: '/a' })
    const form = makeForm(scope)
    const store = form.bind(() => form.shell())
    expect(store.getSnapshot().dirty).toBe(false)
    scope.set('moliPath', '/b')
    expect(store.getSnapshot().dirty).toBe(false)
  })
})
