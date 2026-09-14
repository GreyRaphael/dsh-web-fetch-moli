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

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CdpChromium } from './types.ts'

/** Memoized path to resolved Moli binary. */
const resolvedMoliCache = new Map<string, string>()

/** In-flight download promises keyed by destination directory. */
const inFlightDownloads = new Map<string, Promise<string>>()

/**
 * Find `name` as an executable file on `$PATH`.
 *
 * Automatically inspects Windows `PATHEXT` (e.g. .exe, .cmd, .bat) on win32 platforms.
 *
 * @param name - executable basename (e.g. 'moli', 'node').
 * @returns absolute path to the binary, or undefined.
 */
export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? ''
  const isWindows = process.platform === 'win32'
  const extList = isWindows
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';').filter(Boolean) : ['.EXE', '.CMD', '.BAT'])
    : []

  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidates = [join(dir, name)]
    if (isWindows) {
      for (const ext of extList) {
        if (!name.toLowerCase().endsWith(ext.toLowerCase())) {
          candidates.push(join(dir, `${name}${ext}`))
          candidates.push(join(dir, `${name}${ext.toLowerCase()}`))
        }
      }
    }
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

/** Check if a path exists and is an executable file. */
export function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK)
    } else {
      accessSync(path, constants.F_OK)
    }
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
  const isWindows = process.platform === 'win32'
  const moliNames = isWindows ? ['moli.exe', 'moli'] : ['moli']
  const fallbackDirs = [
    join(userHome, '.local', 'bin'),
    join(userHome, '.cargo', 'bin'),
    join(userHome, '.cache', 'moli'),
    '/usr/local/bin',
    '/usr/bin',
  ]

  for (const dir of fallbackDirs) {
    for (const binName of moliNames) {
      const candidate = join(dir, binName)
      if (isExecutableFile(candidate)) {
        resolvedMoliCache.set(trimmed, candidate)
        return candidate
      }
    }
  }

  // 5. Automated fallback: download latest official Moli release if missing
  try {
    const downloaded = await downloadLatestMoliBinary()
    if (isExecutableFile(downloaded)) {
      resolvedMoliCache.set(trimmed, downloaded)
      return downloaded
    }
  } catch (downloadErr: unknown) {
    throw new Error(
      `cannot find "moli" executable on $PATH or standard locations (~/.local/bin, ~/.cargo/bin), ` +
      `and automated download failed: ${String(downloadErr instanceof Error ? downloadErr.message : downloadErr)}. ` +
      `Please install Moli manually (download release from https://github.com/lexmount/moli or cargo install moli) or set the "moliPath" setting.`,
    )
  }

  throw new Error(
    'cannot find "moli" executable on $PATH or standard locations (~/.local/bin, ~/.cargo/bin); ' +
    'please install Moli (e.g. download release from https://github.com/lexmount/moli or cargo install moli) ' +
    'or set the "moliPath" setting.',
  )
}

/**
 * Detect the official release asset filename for current platform and CPU architecture.
 */
export function getMoliReleaseAsset(): { filename: string; isZip: boolean } {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'linux') {
    if (arch === 'x64') return { filename: 'moli-x86_64-unknown-linux-gnu.tar.gz', isZip: false }
    if (arch === 'arm64') return { filename: 'moli-aarch64-unknown-linux-gnu.tar.gz', isZip: false }
  } else if (platform === 'darwin') {
    if (arch === 'arm64') return { filename: 'moli-aarch64-apple-darwin.tar.gz', isZip: false }
    if (arch === 'x64') return { filename: 'moli-x86_64-apple-darwin.tar.gz', isZip: false }
  } else if (platform === 'win32') {
    if (arch === 'x64') return { filename: 'moli-x86_64-pc-windows-msvc.zip', isZip: true }
    if (arch === 'arm64') return { filename: 'moli-aarch64-pc-windows-msvc.zip', isZip: true }
  }
  throw new Error(`unsupported platform/architecture for Moli auto-download: ${platform}-${arch}`)
}

/**
 * Automatically download and unpack the latest official Moli release binary
 * into `~/.cache/moli/moli` (or `~/.cache/moli/moli.exe`).
 *
 * @param destinationDir - directory to save the binary into (defaults to `~/.cache/moli`).
 * @returns absolute path to the extracted executable binary.
 */
export async function downloadLatestMoliBinary(destinationDir?: string): Promise<string> {
  const userHome = homedir()
  const destDir = destinationDir ?? join(userHome, '.cache', 'moli')
  mkdirSync(destDir, { recursive: true })

  const isWindows = process.platform === 'win32'
  const binName = isWindows ? 'moli.exe' : 'moli'
  const targetBinaryPath = join(destDir, binName)

  if (isExecutableFile(targetBinaryPath)) {
    return targetBinaryPath
  }

  const existingDownload = inFlightDownloads.get(destDir)
  if (existingDownload !== undefined) {
    return existingDownload
  }

  const downloadPromise = (async () => {
    // Re-check after acquiring task slot
    if (isExecutableFile(targetBinaryPath)) {
      return targetBinaryPath
    }

    const { filename, isZip } = getMoliReleaseAsset()
    const downloadUrl = `https://github.com/lexmount/moli/releases/latest/download/${filename}`
    console.info(`[dsh-web-fetch-moli] "moli" binary not found; auto-downloading from ${downloadUrl}...`)

    const tempArchive = join(destDir, `.download-${String(Date.now())}-${filename}`)
    const tempExtractDir = join(destDir, `.extract-${String(Date.now())}`)
    mkdirSync(tempExtractDir, { recursive: true })

    try {
      const response = await fetch(downloadUrl, { redirect: 'follow' })
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`)
      }
      if (!response.body) {
        throw new Error('response body is null')
      }

      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempArchive))

      if (isZip) {
        try {
          execFileSync('tar', ['-xf', tempArchive, '-C', tempExtractDir], { stdio: 'pipe' })
        } catch {
          execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `Expand-Archive -Path "${tempArchive}" -DestinationPath "${tempExtractDir}" -Force`],
            { stdio: 'pipe' },
          )
        }
      } else {
        execFileSync('tar', ['-xzf', tempArchive, '-C', tempExtractDir], { stdio: 'pipe' })
      }

      const foundBinary = findBinaryRecursively(tempExtractDir, binName)
      if (foundBinary === undefined) {
        throw new Error(`could not locate "${binName}" inside downloaded archive`)
      }

      // Atomically install via temp sibling
      const tempTarget = `${targetBinaryPath}.part-${String(Date.now())}`
      copyFileSync(foundBinary, tempTarget)
      if (!isWindows) {
        chmodSync(tempTarget, 0o755)
      }
      try {
        renameSync(tempTarget, targetBinaryPath)
      } catch {
        copyFileSync(tempTarget, targetBinaryPath)
        try { rmSync(tempTarget, { force: true }) } catch {}
      }

      if (!isWindows) {
        chmodSync(targetBinaryPath, 0o755)
      }

      console.info(`[dsh-web-fetch-moli] successfully installed Moli binary to ${targetBinaryPath}`)
      return targetBinaryPath
    } finally {
      try { rmSync(tempArchive, { force: true }) } catch {}
      try { rmSync(tempExtractDir, { recursive: true, force: true }) } catch {}
    }
  })().finally(() => {
    inFlightDownloads.delete(destDir)
  })

  inFlightDownloads.set(destDir, downloadPromise)
  return downloadPromise
}

function findBinaryRecursively(dir: string, binName: string): string | undefined {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findBinaryRecursively(full, binName)
      if (found !== undefined) return found
    } else if (entry.isFile() && (entry.name === binName || entry.name.toLowerCase() === binName.toLowerCase())) {
      return full
    }
  }
  return undefined
}

let bundledCore: CdpChromium | undefined

/** Resolve the CDP protocol driver using bundled playwright-core. */
export async function resolveCdpBackend(): Promise<{ chromium: CdpChromium; source: string }> {
  if (bundledCore !== undefined) {
    return { chromium: bundledCore, source: 'bundled playwright-core over CDP' }
  }
  const pkg = await import('playwright-core') as { chromium?: unknown }
  const chromium = pkg.chromium
  if (chromium === undefined || typeof (chromium as CdpChromium).connectOverCDP !== 'function') {
    throw new Error('playwright-core dependency did not export a usable chromium namespace')
  }
  bundledCore = chromium as CdpChromium
  return { chromium: bundledCore, source: 'bundled playwright-core over CDP' }
}
