import { describe, expect, it } from 'vitest'
import { findOnPath, isExecutableFile, resolveCdpBackend, resolveMoliBinary } from '../src/moli-resolve.ts'

describe('moli-resolve', () => {
  it('findOnPath finds executables on system PATH', () => {
    const nodePath = findOnPath('node')
    expect(nodePath).toBeDefined()
    expect(typeof nodePath).toBe('string')
    expect(isExecutableFile(nodePath!)).toBe(true)
  })

  it('findOnPath returns undefined for non-existent commands', () => {
    expect(findOnPath('definitely-not-a-real-executable-xyz123')).toBeUndefined()
  })

  it('resolveMoliBinary throws on non-existent configured path', async () => {
    await expect(resolveMoliBinary('/non/existent/path/to/moli')).rejects.toThrow(
      'configured moli path "/non/existent/path/to/moli" does not exist',
    )
  })

  it('resolveMoliBinary finds moli on PATH or local bin', async () => {
    const bin = await resolveMoliBinary()
    expect(bin).toBeDefined()
    expect(isExecutableFile(bin)).toBe(true)
  })

  it('resolveCdpBackend returns usable chromium driver', async () => {
    const { chromium, source } = await resolveCdpBackend()
    expect(chromium).toBeDefined()
    expect(typeof chromium.connectOverCDP).toBe('function')
    expect(source).toContain('CDP')
  })
})
