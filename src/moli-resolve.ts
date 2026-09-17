/**
 * Locates and resolves the Moli executable binary and bundled CDP client.
 *
 * Resolution order for Moli binary:
 *  1. Configured executable path (`config.moliPath`);
 *  2. Environment variable `MOLI_PATH`;
 *  3. `moli` found on `$PATH`;
 *  4. Standard user and system directories (`~/.local/bin/moli`, `~/.cargo/bin/moli`, etc.).
 *
 * For CDP connectivity, the native WebSocket CDP client is used as the protocol driver.
 *
 * @module dsh-web-fetch-moli/moli-resolve
 */

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CdpChromium } from './types.ts'
import { connectCdp } from './cdp-client.ts'

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
 * Read current dsh-web-fetch-moli package version from package.json.
 */
export function getPluginPackageVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const content = readFileSync(pkgUrl, 'utf-8')
    const parsed = JSON.parse(content) as { version?: string }
    return parsed.version ?? '0.4.0'
  } catch {
    return '0.4.0'
  }
}

/**
 * Read the version string of a local Moli binary by executing `moli --version`.
 *
 * @param binaryPath - absolute path to executable.
 * @returns semver string (e.g. '1.1.5'), or null if unexecutable/unparseable.
 */
export function getLocalMoliVersion(binaryPath: string): string | null {
  try {
    if (!isExecutableFile(binaryPath)) return null
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    })
    const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Query the latest official Moli release tag from GitHub Releases.
 *
 * Tries curl first (respecting proxy environment variables like http_proxy/https_proxy),
 * with a fallback to native fetch with a strict 6s timeout.
 *
 * @returns latest semver string (e.g. '1.1.6'), or null if network is offline.
 */
export async function fetchLatestMoliReleaseTag(): Promise<string | null> {
  // 1. Try curl (fast, respects system & shell proxy envs)
  try {
    const stdout = execFileSync(
      'curl',
      ['-sI', '--connect-timeout', '5', '--max-time', '8', 'https://github.com/lexmount/moli/releases/latest'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const match = stdout.match(/location:.*tag\/v?([0-9A-Za-z.-]+)/i)
    if (match?.[1]) {
      return match[1].trim().replace(/^v/, '')
    }
  } catch {
    // curl failed or unavailable, fallback to fetch
  }

  // 2. Fallback to native fetch
  try {
    const resp = await fetch('https://github.com/lexmount/moli/releases/latest', {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    })
    const location = resp.headers.get('location') ?? ''
    const match = location.match(/tag\/v?([0-9A-Za-z.-]+)/i)
    if (match?.[1]) {
      return match[1].trim().replace(/^v/, '')
    }
  } catch {
    // network unavailable
  }

  return null
}

/**
 * Ensures the cached Moli binary (~/.cache/moli/moli) is updated to the latest
 * official GitHub release whenever dsh-web-fetch-moli is upgraded or first installed.
 *
 * A marker file (~/.cache/moli/.plugin-version) records the last checked plugin version.
 * If the current plugin version matches the marker, returns immediately (0 network overhead).
 */
export async function syncLatestMoliOnPluginUpdate(destinationDir?: string): Promise<void> {
  const userHome = homedir()
  const destDir = destinationDir ?? join(userHome, '.cache', 'moli')
  const stampFile = join(destDir, '.plugin-version')
  const currentPluginVersion = getPluginPackageVersion()

  let savedPluginVersion = ''
  try {
    if (existsSync(stampFile)) {
      savedPluginVersion = readFileSync(stampFile, 'utf-8').trim()
    }
  } catch {
    // Ignore read errors
  }

  // Skip if plugin has already checked for this version
  if (savedPluginVersion === currentPluginVersion) {
    return
  }

  // In test environment, skip remote GitHub check unless explicitly opted in
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !process.env.RUN_ONLINE_BENCHMARK) {
    return
  }

  const isWindows = process.platform === 'win32'
  const binName = isWindows ? 'moli.exe' : 'moli'
  const targetBinaryPath = join(destDir, binName)

  try {
    const [latestReleaseVer, localVer] = await Promise.all([
      fetchLatestMoliReleaseTag(),
      Promise.resolve(getLocalMoliVersion(targetBinaryPath)),
    ])

    if (latestReleaseVer !== null) {
      if (localVer === null || localVer !== latestReleaseVer) {
        console.info(
          `[dsh-web-fetch-moli] Plugin updated to v${currentPluginVersion}. ` +
          `Upgrading Moli binary: ${localVer ?? 'missing'} -> v${latestReleaseVer}...`,
        )
        await downloadLatestMoliBinary(destDir, { forceOverwrite: true })
      }
    }

    mkdirSync(destDir, { recursive: true })
    writeFileSync(stampFile, currentPluginVersion, 'utf-8')
  } catch (err: unknown) {
    console.warn('[dsh-web-fetch-moli] Check/update latest Moli release failed (offline fallback):', err)
  }
}

/**
 * Resolve the Moli executable path.
 *
 * Resolution order:
 *  1. Explicitly configured path (`config.moliPath`);
 *  2. Environment variable `MOLI_PATH`;
 *  3. Official GitHub release cached binary (`~/.cache/moli/moli`), synced on plugin update;
 *  4. System `$PATH` (`moli`);
 *  5. Automated download from GitHub Releases.
 *
 * @param configuredPath - user-configured `moliPath` (blank = auto-discovery).
 * @returns absolute path to executable Moli binary.
 * @throws {Error} if Moli executable cannot be found.
 */
export async function resolveMoliBinary(configuredPath = ''): Promise<string> {
  const trimmed = configuredPath.trim()
  const cached = resolvedMoliCache.get(trimmed)
  if (cached !== undefined && isExecutableFile(cached)) return cached

  // 1. Explicitly configured path (user overrides everything)
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

  // 3. Automated check: ensure ~/.cache/moli/moli has latest release when plugin updates
  await syncLatestMoliOnPluginUpdate()

  // 4. Default official GitHub release location (~/.cache/moli/moli)
  const userHome = homedir()
  const isWindows = process.platform === 'win32'
  const binName = isWindows ? 'moli.exe' : 'moli'
  const cachedMoli = join(userHome, '.cache', 'moli', binName)
  if (isExecutableFile(cachedMoli)) {
    resolvedMoliCache.set(trimmed, cachedMoli)
    return cachedMoli
  }

  // 5. System $PATH fallback (if pre-installed on system)
  const onPath = findOnPath('moli')
  if (onPath !== undefined) {
    resolvedMoliCache.set(trimmed, onPath)
    return onPath
  }

  // 6. Automated fallback: download latest official Moli release if missing
  try {
    const downloaded = await downloadLatestMoliBinary()
    if (isExecutableFile(downloaded)) {
      resolvedMoliCache.set(trimmed, downloaded)
      return downloaded
    }
  } catch (downloadErr: unknown) {
    throw new Error(
      `cannot find "moli" executable on standard location (~/.cache/moli), ` +
      `and automated download failed: ${String(downloadErr instanceof Error ? downloadErr.message : downloadErr)}. ` +
      `Please check network or set the "moliPath" setting.`,
    )
  }

  throw new Error(
    'cannot find "moli" executable on standard location (~/.cache/moli); ' +
    'please check network or set the "moliPath" setting.',
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
 * @param options - download options (forceOverwrite).
 * @returns absolute path to the extracted executable binary.
 */
export async function downloadLatestMoliBinary(
  destinationDir?: string,
  options: { forceOverwrite?: boolean } = {},
): Promise<string> {
  const userHome = homedir()
  const destDir = destinationDir ?? join(userHome, '.cache', 'moli')
  mkdirSync(destDir, { recursive: true })

  const isWindows = process.platform === 'win32'
  const binName = isWindows ? 'moli.exe' : 'moli'
  const targetBinaryPath = join(destDir, binName)

  if (!options.forceOverwrite && isExecutableFile(targetBinaryPath)) {
    return targetBinaryPath
  }

  const existingDownload = inFlightDownloads.get(destDir)
  if (existingDownload !== undefined && !options.forceOverwrite) {
    return existingDownload
  }

  const downloadPromise = (async () => {
    if (!options.forceOverwrite && isExecutableFile(targetBinaryPath)) {
      return targetBinaryPath
    }

    const { filename, isZip } = getMoliReleaseAsset()
    const downloadUrl = `https://github.com/lexmount/moli/releases/latest/download/${filename}`
    console.info(`[dsh-web-fetch-moli] Downloading latest official Moli release from ${downloadUrl}...`)

    const tempArchive = join(destDir, `.download-${String(Date.now())}-${filename}`)
    const tempExtractDir = join(destDir, `.extract-${String(Date.now())}`)
    mkdirSync(tempExtractDir, { recursive: true })

    try {
      let downloadedViaCurl = false
      try {
        execFileSync(
          'curl',
          ['-fL', '--connect-timeout', '15', '--max-time', '180', '-o', tempArchive, downloadUrl],
          { stdio: 'pipe' },
        )
        if (existsSync(tempArchive) && statSync(tempArchive).size > 1000) {
          downloadedViaCurl = true
        }
      } catch {
        // Fallback to fetch
      }

      if (!downloadedViaCurl) {
        const response = await fetch(downloadUrl, { redirect: 'follow' })
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`)
        }
        if (!response.body) {
          throw new Error('response body is null')
        }
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempArchive))
      }

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
        try {
          execFileSync('tar', ['--no-same-owner', '-m', '-xzf', tempArchive, '-C', tempExtractDir], { stdio: 'pipe' })
        } catch (tarErr) {
          // Check if binary was extracted despite non-fatal tar warnings (e.g. utime)
          if (!findBinaryRecursively(tempExtractDir, binName)) {
            try {
              execFileSync('tar', ['-xzf', tempArchive, '-C', tempExtractDir], { stdio: 'pipe' })
            } catch {
              if (!findBinaryRecursively(tempExtractDir, binName)) {
                throw tarErr
              }
            }
          }
        }
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

      resolvedMoliCache.set('', targetBinaryPath)
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

let nativeClient: CdpChromium | undefined

/** Resolve the CDP protocol driver using the native WebSocket client. */
export async function resolveCdpBackend(): Promise<{ chromium: CdpChromium; source: string }> {
  if (nativeClient !== undefined) {
    return { chromium: nativeClient, source: 'native WebSocket CDP client' }
  }
  const client: CdpChromium = {
    connectOverCDP: (endpoint: string, options?: { timeout?: number }) =>
      connectCdp(endpoint, options?.timeout ?? 30000),
  }
  nativeClient = client
  return { chromium: client, source: 'native WebSocket CDP client' }
}
