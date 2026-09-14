/**
 * Locates and resolves the Moli executable binary and bundled CDP client.
 *
 * Resolution order for Moli binary:
 *  1. Configured executable path (`config.moliPath`);
 *  2. Environment variable `MOLI_PATH`;
 *  3. `moli` found on `$PATH`;
 *  4. Standard user and system directories (`~/.local/bin/moli`, `~/.cargo/bin/moli`, etc.).
 *
 * For CDP connectivity, the bundled `playwright-core` is used as the protocol driver.
 *
 * @module dsh-web-fetch-moli/moli-resolve
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PlaywrightChromium } from './types.ts'

/** Memoized path to resolved Moli binary. */
const resolvedMoliCache = new Map<string, string>()

/**
 * Find `name` as an executable file on `$PATH`.
 *
 * @param name - executable basename (e.g. 'moli').
 * @returns absolute path to the binary, or undefined.
 */
export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

/** Check if a path exists and is an executable file. */
export function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the Moli executable path.
 *
 * @param configuredPath - user-configured `moliPath` (blank = auto-discovery).
 * @returns absolute path to executable Moli binary.
 * @throws {Error} if Moli executable cannot be found.
 */
export async function resolveMoliBinary(configuredPath = ''): Promise<string> {
  const trimmed = configuredPath.trim()
  const cached = resolvedMoliCache.get(trimmed)
  if (cached !== undefined) return cached

  // 1. Explicitly configured path
  if (trimmed !== '') {
    if (isExecutableFile(trimmed)) {
      resolvedMoliCache.set(trimmed, trimmed)
      return trimmed
    }
    throw new Error(`configured moli path "${trimmed}" does not exist or is not executable`)
  }

  // 2. Environment variable MOLI_PATH
  const envPath = process.env.MOLI_PATH?.trim()
  if (envPath && isExecutableFile(envPath)) {
    resolvedMoliCache.set(trimmed, envPath)
    return envPath
  }

  // 3. System $PATH
  const onPath = findOnPath('moli')
  if (onPath !== undefined) {
    resolvedMoliCache.set(trimmed, onPath)
    return onPath
  }

  // 4. Standard local / home / system fallback locations
  const userHome = homedir()
  const fallbackCandidates = [
    join(userHome, '.local', 'bin', 'moli'),
    join(userHome, '.cargo', 'bin', 'moli'),
    join(userHome, '.cache', 'moli', 'moli'),
    '/usr/local/bin/moli',
    '/usr/bin/moli',
  ]

  for (const candidate of fallbackCandidates) {
    if (isExecutableFile(candidate)) {
      resolvedMoliCache.set(trimmed, candidate)
      return candidate
    }
  }

  throw new Error(
    'cannot find "moli" executable on $PATH or standard locations (~/.local/bin, ~/.cargo/bin); ' +
    'please install Moli (e.g. download release from https://github.com/lexmount/moli or cargo install moli) ' +
    'or set the "moliPath" setting.',
  )
}

let bundledCore: PlaywrightChromium | undefined

/** Resolve the CDP protocol driver using bundled playwright-core. */
export async function resolveCdpBackend(): Promise<{ chromium: PlaywrightChromium; source: string }> {
  if (bundledCore !== undefined) {
    return { chromium: bundledCore, source: 'bundled playwright-core over CDP' }
  }
  const pkg = await import('playwright-core') as { chromium?: unknown }
  const chromium = pkg.chromium
  if (chromium === undefined || typeof (chromium as PlaywrightChromium).connectOverCDP !== 'function') {
    throw new Error('playwright-core dependency did not export a usable chromium namespace')
  }
  bundledCore = chromium as PlaywrightChromium
  return { chromium: bundledCore, source: 'bundled playwright-core over CDP' }
}
