import { describe, expect, it } from 'vitest'
import {
  downloadLatestMoliBinary,
  fetchLatestMoliReleaseTag,
  findOnPath,
  getLocalMoliVersion,
  getMoliReleaseAsset,
  getPluginPackageVersion,
  isExecutableFile,
  resolveCdpBackend,
  resolveMoliBinary,
  syncLatestMoliOnPluginUpdate,
} from '../src/moli-resolve.ts'

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

  it('getMoliReleaseAsset returns release asset for current platform', () => {
    const asset = getMoliReleaseAsset()
    expect(asset.filename).toBeDefined()
    expect(asset.filename).toMatch(/^moli-/)
    if (process.platform === 'win32') {
      expect(asset.filename).toMatch(/\.zip$/)
      expect(asset.isZip).toBe(true)
    } else {
      expect(asset.filename).toMatch(/\.tar\.gz$/)
      expect(asset.isZip).toBe(false)
    }
  })

  it('resolveMoliBinary throws on non-existent configured path', async () => {
    await expect(resolveMoliBinary('/non/existent/path/to/moli')).rejects.toThrow(
      'configured moli path "/non/existent/path/to/moli" does not exist',
    )
  })

  it('downloadLatestMoliBinary returns existing binary or downloads', { timeout: 60_000 }, async () => {
    const bin = await downloadLatestMoliBinary()
    expect(bin).toBeDefined()
    expect(isExecutableFile(bin)).toBe(true)
  })

  it('resolveMoliBinary finds moli on PATH or fallback locations', { timeout: 60_000 }, async () => {
    const bin = await resolveMoliBinary()
    expect(bin).toBeDefined()
    expect(isExecutableFile(bin)).toBe(true)
  })

  it('getPluginPackageVersion returns valid semver from package.json', () => {
    const ver = getPluginPackageVersion()
    expect(ver).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('getLocalMoliVersion inspects binary version string', async () => {
    const bin = await resolveMoliBinary()
    const ver = getLocalMoliVersion(bin)
    expect(ver).toBeDefined()
    expect(ver).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('fetchLatestMoliReleaseTag fetches remote release tag or returns null on network issues', async () => {
    const tag = await fetchLatestMoliReleaseTag()
    if (tag !== null) {
      expect(tag).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it('syncLatestMoliOnPluginUpdate fast-path skips check when version stamp matches', async () => {
    const t0 = performance.now()
    await syncLatestMoliOnPluginUpdate()
    const elapsed = performance.now() - t0
    // Fast path should complete in under 50ms without network roundtrip
    expect(elapsed).toBeLessThan(100)
  })

  it('resolveCdpBackend returns usable chromium driver', async () => {
    const { chromium, source } = await resolveCdpBackend()
    expect(chromium).toBeDefined()
    expect(typeof chromium.connectOverCDP).toBe('function')
    expect(source).toContain('CDP')
  })
})

