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
  createReadStream,
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
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ExecFileOptions } from 'node:child_process'
import type { CdpChromium } from './types.ts'
import { connectCdp } from './cdp-client.ts'

/** Memoized path to resolved Moli binary. */
const resolvedMoliCache = new Map<string, string>()

/**
 * Base URL of the Moli upstream GitHub Releases.
 *
 * Moli binaries are sourced from the GreyRaphael/moli fork, which carries
 * upstream's release asset naming (moli-<target>.tar.gz / .zip) verbatim.
 */
export const MOLI_RELEASES_URL = 'https://github.com/GreyRaphael/moli/releases'

/** Redirect endpoint resolving to the latest release tag. */
const MOLI_LATEST_RELEASE_URL = `${MOLI_RELEASES_URL}/latest`

/** Latest-release asset download base (`/releases/latest/download/<asset>`). */
const MOLI_LATEST_DOWNLOAD_URL = `${MOLI_LATEST_RELEASE_URL}/download`

/** GitHub `owner/repo` slug of the Moli binary upstream. */
export const MOLI_REPO_SLUG = 'GreyRaphael/moli'

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

/** Error codes signaling a transient Windows file lock (AV scan, indexer, or a not-yet-released handle). */
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Default total budget for lock retries (~10.5s worst case). */
const LOCK_RETRY_TIMEOUT_MS = 10_000

/**
 * Promisified `execFile` that never blocks the event loop. All child-process
 * invocations go through this so a slow download or a wedged binary can never
 * freeze the host's concurrent fetches.
 */
function runCommand(command: string, args: string[], options: { timeout: number } & Omit<ExecFileOptions, 'timeout'> = { timeout: 5_000 }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', ...options }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout as string)
    })
  })
}

/**
 * Run a filesystem operation, retrying on transient Windows file locks.
 *
 * On Windows a freshly extracted/renamed executable is routinely held open
 * (exclusive lock) for a short while by Defender or the search indexer, making
 * an immediate `copyFileSync` fail with `EBUSY`. Retrying with exponential
 * backoff rides out the scan window instead of failing the install — with
 * real-timer sleeps, so the event loop keeps serving requests while the lock
 * rides out.
 *
 * @param op - zero-arg (synchronous fs) operation to run.
 * @param label - description used in the final error message.
 * @param timeoutMs - total retry budget (default ~10s).
 */
export async function withFsLockRetry<T>(op: () => Promise<T> | T, label: string, timeoutMs = LOCK_RETRY_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let delay = 150
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await op()
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === undefined || !TRANSIENT_LOCK_CODES.has(code) || Date.now() >= deadline) {
        if (TRANSIENT_LOCK_CODES.has(String(code)) && attempt > 1) {
          const wrapped = new Error(`${label} failed after ${attempt} attempts (${code}): ${String((err as Error)?.message ?? err)}`)
          ;(wrapped as NodeJS.ErrnoException).cause = err
          throw wrapped
        }
        throw err
      }
      await sleep(Math.min(delay, 200))
      delay = Math.min(delay * 2, 2000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Read current dsh-web-fetch-moli package version.
 *
 * In production builds tsdown replaces `__PLUGIN_VERSION__` with a string
 * literal at compile time — no runtime file I/O and no hardcoded fallback
 * that drifts across releases.  In dev/test (where the define is absent)
 * the function falls back to reading `../package.json` relative to the
 * source file.
 */
export function getPluginPackageVersion(): string {
  /* istanbul ignore next -- build-time define is always present in production */
  if (typeof __PLUGIN_VERSION__ === 'string') return __PLUGIN_VERSION__
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const content = readFileSync(pkgUrl, 'utf-8')
    return (JSON.parse(content) as { version?: string }).version ?? '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}

/**
 * Read the version string of a local Moli binary by executing `moli --version`
 * — asynchronously, so a wedged binary can never block the event loop.
 *
 * @param binaryPath - absolute path to executable.
 * @returns semver string (e.g. '1.1.5'), or null if unexecutable/unparseable.
 */
export async function getLocalMoliVersion(binaryPath: string): Promise<string | null> {
  try {
    if (!isExecutableFile(binaryPath)) return null
    const output = await runCommand(binaryPath, ['--version'], { timeout: 3_000 })
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
 * with a fallback to native fetch with a strict 6s timeout. Both paths are
 * async — the event loop stays responsive while the network answers.
 *
 * @returns latest semver string (e.g. '1.1.6'), or null if network is offline.
 */
export async function fetchLatestMoliReleaseTag(): Promise<string | null> {
  // 1. Try curl (fast, respects system & shell proxy envs)
  try {
    const stdout = await runCommand(
      'curl',
      ['-sI', '--connect-timeout', '5', '--max-time', '8', MOLI_LATEST_RELEASE_URL],
      { timeout: 9_000 },
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
    const resp = await fetch(MOLI_LATEST_RELEASE_URL, {
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
 * Fetch the release asset digests, or undefined when they cannot be read.
 *
 * A seam rather than a direct call so tests can drive both integrity branches
 * (match, mismatch, absent) without the network. `tests/moli-resolve.spec.ts`
 * substitutes it; production always reaches the API.
 * @returns release asset metadata, or undefined when unreachable.
 */
let releaseDigestSource: () => Promise<MoliReleaseAssetDigest[] | undefined> = fetchLatestMoliReleaseAssetDigests

/**
 * Override how the download path obtains release digests.
 * @param source - replacement reader, or undefined to restore the API reader.
 */
export function setReleaseDigestSourceForTests(source: (() => Promise<MoliReleaseAssetDigest[] | undefined>) | undefined): void {
  releaseDigestSource = source ?? fetchLatestMoliReleaseAssetDigests
}

/** Read digests through the active seam. */
async function resolveReleaseDigests(): Promise<MoliReleaseAssetDigest[] | undefined> {
  try {
    return await releaseDigestSource()
  } catch {
    // An unreachable/throwing reader must not fail the install; the verifier
    // reports the unverified state itself.
    return undefined
  }
}

/** In-flight binary sync promises keyed by destination directory. */
const inFlightSyncs = new Map<string, Promise<void>>()

/**
 * GitHub REST endpoint describing the latest release, including per-asset
 * digests.
 *
 * This is a second API call on purpose: the packument-free `/releases/latest`
 * redirect (which {@link fetchLatestMoliReleaseTag} follows) yields only a tag,
 * while the integrity metadata this plugin verifies against is published on the
 * REST resource. One extra request on the (rarer) download path buys a real
 * supply-chain control, and a failure here degrades to "unverified" rather than
 * blocking the install.
 */
const MOLI_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${MOLI_REPO_SLUG}/releases/latest`

/** One release asset as the integrity check needs it. */
export interface MoliReleaseAssetDigest {
  /** Asset filename exactly as the release publishes it (e.g. `moli-x86_64-unknown-linux-gnu.tar.gz`). */
  name: string
  /**
   * GitHub's `digest` field, `sha256:<hex>`, or undefined when the release was
   * published before GitHub started computing digests.
   */
  digest: string | undefined
}

/**
 * Read the latest release's asset digests from the GitHub REST API.
 *
 * Every failure mode (no curl, no network, rate limit, unexpected JSON shape)
 * returns `undefined` so the caller can warn and proceed: an install that cannot
 * reach the API must still work, it just cannot claim to be verified.
 *
 * @returns asset name → digest entries, or undefined when the metadata is unreachable.
 */
export async function fetchLatestMoliReleaseAssetDigests(): Promise<MoliReleaseAssetDigest[] | undefined> {
  let body: string | null = null
  try {
    body = await runCommand(
      'curl',
      ['-sfL', '--connect-timeout', '5', '--max-time', '15', '-H', 'Accept: application/vnd.github+json', MOLI_LATEST_RELEASE_API_URL],
      { timeout: 20_000 },
    )
  } catch {
    try {
      const resp = await fetch(MOLI_LATEST_RELEASE_API_URL, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (resp.ok) body = await resp.text()
    } catch {
      // Unreachable metadata — the caller warns and installs unverified
    }
  }
  if (body === null) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const assets = (parsed as { assets?: unknown }).assets
  if (!Array.isArray(assets)) return undefined

  const entries: MoliReleaseAssetDigest[] = []
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const { name, digest } = asset as { name?: unknown; digest?: unknown }
    if (typeof name !== 'string') continue
    entries.push({ name, digest: typeof digest === 'string' && digest.length > 0 ? digest : undefined })
  }
  return entries
}

/** Default check interval for Moli upstream releases (24 hours). */
export const DEFAULT_MOLI_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Options for syncing Moli binary. */
export interface SyncMoliOptions {
  /** Force remote release check even if TTL or plugin version stamp is fresh. */
  forceCheck?: boolean
  /** Custom check interval budget in ms (defaults to 24h). */
  checkIntervalMs?: number
}

/** Parse a three-component semver string into [major, minor, patch]. */
export function parseSemVer(ver: string): [number, number, number] | null {
  const m = ver.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

/** Check whether `remote` version is strictly newer than `local` version. */
export function isNewerVersion(remote: string, local: string): boolean {
  const r = parseSemVer(remote)
  const l = parseSemVer(local)
  if (!r || !l) return remote !== local
  if (r[0] !== l[0]) return r[0] > l[0]
  if (r[1] !== l[1]) return r[1] > l[1]
  if (r[2] !== l[2]) return r[2] > l[2]
  // If core major.minor.patch is equal, a stable release is newer than a prerelease
  if (local.includes('-') && !remote.includes('-')) return true
  return false
}

/**
 * Ensures the cached Moli binary (~/.cache/moli/moli) is kept up-to-date with
 * the latest official GitHub release.
 *
 * Checks remote releases when:
 *  1. The target Moli binary does not exist on disk;
 *  2. The plugin itself was just upgraded (`currentPluginVersion !== savedPluginVersion`);
 *  3. More than 24 hours have elapsed since the last remote check (TTL expired);
 *  4. Explicitly requested via `options.forceCheck`.
 *
 * Otherwise returns immediately (fast path, 0 network overhead).
 *
 * @param destinationDir - directory to save the binary into (defaults to `~/.cache/moli`).
 * @param options - check options (forceCheck, checkIntervalMs).
 */
export async function syncLatestMoliBinary(
  destinationDir?: string,
  options?: SyncMoliOptions,
): Promise<void> {
  const userHome = homedir()
  const destDir = destinationDir ?? join(userHome, '.cache', 'moli')
  const stampFile = join(destDir, '.plugin-version')
  const currentPluginVersion = getPluginPackageVersion()

  const isWindows = process.platform === 'win32'
  const binName = isWindows ? 'moli.exe' : 'moli'
  const targetBinaryPath = join(destDir, binName)

  let savedPluginVersion = ''
  let lastCheckedTime = 0
  try {
    if (existsSync(stampFile)) {
      const content = readFileSync(stampFile, 'utf-8').trim()
      if (content.startsWith('{')) {
        const parsed = JSON.parse(content) as { pluginVersion?: string; checkedAt?: number }
        savedPluginVersion = parsed.pluginVersion ?? ''
        lastCheckedTime = typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0
      } else {
        savedPluginVersion = content
        lastCheckedTime = statSync(stampFile).mtimeMs
      }
    }
  } catch {
    // Ignore read errors
  }

  const now = Date.now()
  const interval = options?.checkIntervalMs ?? DEFAULT_MOLI_CHECK_INTERVAL_MS
  const isFresh = isExecutableFile(targetBinaryPath)
    && (savedPluginVersion === currentPluginVersion)
    && (now >= lastCheckedTime && now - lastCheckedTime < interval)

  // Skip remote check if fresh unless explicitly forced
  if (!options?.forceCheck && isFresh) {
    return
  }

  // Deduplicate concurrent check/download requests for the same directory
  const existingSync = inFlightSyncs.get(destDir)
  if (existingSync !== undefined && !options?.forceCheck) {
    return existingSync
  }

  // In test environment, skip remote GitHub check unless explicitly opted in
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !process.env.RUN_ONLINE_BENCHMARK) {
    return
  }

  const syncPromise = (async () => {
    try {
      const [latestReleaseVer, localVer] = await Promise.all([
        fetchLatestMoliReleaseTag(),
        getLocalMoliVersion(targetBinaryPath),
      ])

      if (latestReleaseVer !== null) {
        if (localVer === null || isNewerVersion(latestReleaseVer, localVer)) {
          console.info(
            `[dsh-web-fetch-moli] New Moli release available: ${localVer ?? 'missing'} -> v${latestReleaseVer}. ` +
            `Updating Moli binary...`,
          )
          await downloadLatestMoliBinary(destDir, { forceOverwrite: true })
        }

        // Only stamp when remote check actually succeeded
        mkdirSync(destDir, { recursive: true })
        writeFileSync(
          stampFile,
          JSON.stringify({ pluginVersion: currentPluginVersion, checkedAt: Date.now() }),
          'utf-8',
        )
      }
    } catch (err: unknown) {
      console.warn('[dsh-web-fetch-moli] Check/update latest Moli release failed (offline fallback):', err)
    }
  })().finally(() => {
    inFlightSyncs.delete(destDir)
  })

  inFlightSyncs.set(destDir, syncPromise)
  return syncPromise
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
  await syncLatestMoliBinary()

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
    const downloadUrl = `${MOLI_LATEST_DOWNLOAD_URL}/${filename}`
    console.info(`[dsh-web-fetch-moli] Downloading latest official Moli release from ${downloadUrl}...`)

    const tempArchive = join(destDir, `.download-${String(Date.now())}-${filename}`)
    const tempExtractDir = join(destDir, `.extract-${String(Date.now())}`)
    mkdirSync(tempExtractDir, { recursive: true })

    try {
      let downloadedViaCurl = false
      try {
        await runCommand(
          'curl',
          ['-fL', '--connect-timeout', '15', '--max-time', '180', '-o', tempArchive, downloadUrl],
          { timeout: 190_000 },
        )
        if (existsSync(tempArchive) && statSync(tempArchive).size > 1000) {
          downloadedViaCurl = true
        }
      } catch {
        // Fallback to fetch
      }

      if (!downloadedViaCurl) {
        const response = await fetch(downloadUrl, {
          redirect: 'follow',
          // Hard ceiling on the streaming download so a wedged transfer cannot
          // pin the install forever; a slow link still gets the full window.
          signal: AbortSignal.timeout(190_000),
        })
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`)
        }
        if (!response.body) {
          throw new Error('response body is null')
        }
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempArchive))
      }

      await verifyArchiveDigest(tempArchive, filename, await resolveReleaseDigests())

      if (isZip) {
        try {
          await runCommand('tar', ['-xf', tempArchive, '-C', tempExtractDir], { timeout: 60_000 })
        } catch {
          await runCommand(
            'powershell',
            ['-NoProfile', '-Command', `Expand-Archive -Path "${tempArchive}" -DestinationPath "${tempExtractDir}" -Force`],
            { timeout: 120_000 },
          )
        }
      } else {
        try {
          await runCommand('tar', ['--no-same-owner', '-m', '-xzf', tempArchive, '-C', tempExtractDir], { timeout: 60_000 })
        } catch (tarErr) {
          // Check if binary was extracted despite non-fatal tar warnings (e.g. utime)
          if (!findBinaryRecursively(tempExtractDir, binName)) {
            try {
              await runCommand('tar', ['-xzf', tempArchive, '-C', tempExtractDir], { timeout: 60_000 })
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

      // Atomically install via temp sibling. All ops retry on transient
      // Windows locks: a freshly extracted .exe is frequently held open by
      // Defender/indexer for a moment (EBUSY/EPERM on immediate copy).
      const tempTarget = `${targetBinaryPath}.part-${String(Date.now())}`
      await withFsLockRetry(() => copyFileSync(foundBinary, tempTarget), `copy extracted "${binName}"`)
      if (!isWindows) {
        await withFsLockRetry(() => chmodSync(tempTarget, 0o755), `chmod temp ${binName}`)
      }
      try {
        await withFsLockRetry(() => renameSync(tempTarget, targetBinaryPath), `rename temp ${binName} into place`)
      } catch {
        // Cross-device rename or target locked (e.g. daemon running): copy-in-place fallback
        await withFsLockRetry(() => copyFileSync(tempTarget, targetBinaryPath), `copy temp ${binName} into place`)
        try { await withFsLockRetry(() => rmSync(tempTarget, { force: true }), `remove temp ${binName}`, 2000) } catch {}
      }

      if (!isWindows) {
        await withFsLockRetry(() => chmodSync(targetBinaryPath, 0o755), `chmod ${binName}`)
      }

      resolvedMoliCache.set('', targetBinaryPath)
      console.info(`[dsh-web-fetch-moli] successfully installed Moli binary to ${targetBinaryPath}`)
      return targetBinaryPath
    } finally {
      try { await withFsLockRetry(() => rmSync(tempArchive, { force: true }), 'remove downloaded archive', 2000) } catch {}
      try { await withFsLockRetry(() => rmSync(tempExtractDir, { recursive: true, force: true }), 'remove extract dir', 2000) } catch {}
    }
  })().finally(() => {
    inFlightDownloads.delete(destDir)
  })

  inFlightDownloads.set(destDir, downloadPromise)
  return downloadPromise
}

/**
 * Verify the downloaded archive against the digest the release metadata
 * publishes for it.
 *
 * The upstream release publishes no `<asset>.sha256` companion file — measured
 * 404 on every asset — while the GitHub REST API does expose `assets[].digest`.
 * Looking for the companion file therefore found nothing and returned silently,
 * which made "opportunistic verification" mean "no verification": a tampered or
 * truncated archive was extracted, `chmod 0755`'d and executed with HTTPS as the
 * only control. Reading the API digest instead makes the check real.
 *
 * A present digest that does not match aborts the install before extraction.
 * An *absent* digest (older releases, unreachable API, rate limit) warns loudly
 * and proceeds: refusing to install would break first-run on a network that
 * cannot reach api.github.com, but silence would make the gap invisible.
 *
 * Runs only on the download path — never per fetch.
 * @param archivePath - the downloaded archive on disk.
 * @param assetName - asset filename to look up in the release metadata.
 * @param digests - release asset metadata, or undefined when unreachable.
 */
export async function verifyArchiveDigest(
  archivePath: string,
  assetName: string,
  digests: MoliReleaseAssetDigest[] | undefined,
): Promise<void> {
  const expectedRaw = digests?.find(entry => entry.name === assetName)?.digest
  if (expectedRaw === undefined) {
    console.warn(
      `[dsh-web-fetch-moli] integrity NOT verified for ${assetName}: ` +
      `${digests === undefined
        ? 'the release metadata (api.github.com) was unreachable'
        : 'the release publishes no digest for this asset'}. ` +
      'The downloaded binary will be installed and executed, authenticated only by HTTPS.',
    )
    return
  }
  // GitHub publishes `sha256:<hex>`; tolerate a bare hex too so a future format
  // change degrades to "still checked" rather than "silently unverified".
  const expected = expectedRaw.match(/\b([0-9a-f]{64})\b/i)?.[1]?.toLowerCase()
  if (expected === undefined) {
    console.warn(
      `[dsh-web-fetch-moli] integrity NOT verified for ${assetName}: ` +
      `unrecognized digest format ${JSON.stringify(expectedRaw)}. Proceeding under HTTPS only.`,
    )
    return
  }
  const actual = await sha256File(archivePath)
  if (actual !== expected) {
    throw new Error(
      `checksum verification failed for ${assetName}: expected sha256 ${expected}, got ${actual}; ` +
      'refusing to install a tampered or truncated archive',
    )
  }
  console.info(`[dsh-web-fetch-moli] verified ${assetName} against the release digest (sha256:${actual})`)
}

/** Stream a file through SHA-256 without buffering it whole in memory. */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => { hash.update(chunk as Buffer) })
    stream.on('error', reject)
    stream.on('end', () => { resolve(hash.digest('hex')) })
  })
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

/** Resolve the CDP protocol driver (the native WebSocket client, memoized). */
export function resolveCdpBackend(): CdpChromium {
  if (nativeClient !== undefined) return nativeClient
  const client: CdpChromium = {
    connectOverCDP: (endpoint: string, options?: { timeout?: number }) =>
      connectCdp(endpoint, options?.timeout ?? 30000),
  }
  nativeClient = client
  return client
}
