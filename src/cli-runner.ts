/**
 * One-shot CLI runner for Moli (`moli fetch`).
 *
 * Runs `moli fetch <url>` as an isolated child process without needing a background daemon.
 *
 * @module dsh-web-fetch-moli/cli-runner
 */

import { spawn } from 'node:child_process'
import { WebError } from '@deepseek-ai/dsh-web'
import type { MoliCliResult } from './types.ts'

export interface RunMoliCliOptions {
  moliPath: string
  url: string
  dump?: 'html' | 'markdown' | 'json'
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Execute a one-shot fetch using `moli fetch`.
 *
 * @param options - execution options including binary path, url, and dump format.
 * @returns execution result with stdout content.
 */
export async function runMoliFetch(options: RunMoliCliOptions): Promise<MoliCliResult> {
  const { moliPath, url, dump = 'html', timeoutMs = 30000, signal } = options

  if (signal?.aborted) {
    throw new WebError('web fetch aborted', 'WEB_ABORTED')
  }

  const args: string[] = ['fetch', url, '--dump', dump, '--timeout', String(timeoutMs)]

  return new Promise<MoliCliResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(moliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: unknown) {
      reject(new WebError(
        `failed to execute moli at "${moliPath}": ${String(err instanceof Error ? err.message : err)}`,
        'WEB_PROVIDER_ERROR',
        { cause: err },
      ))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    const onAbort = () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
      }
      reject(new WebError('web fetch aborted', 'WEB_ABORTED'))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
      }
      reject(new WebError(`moli fetch timed out after ${timeoutMs}ms: ${url}`, 'WEB_FETCH_TIMEOUT'))
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(new WebError(`moli process execution failed: ${err.message}`, 'WEB_PROVIDER_ERROR', { cause: err }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')

      if (code !== 0) {
        reject(new WebError(
          `moli fetch failed with exit code ${String(code)} for ${url}: ${stderr || stdout || 'unknown error'}`,
          'WEB_FETCH_FAILED',
        ))
        return
      }

      resolve({
        statusCode: 200,
        content: stdout,
        url,
        contentType: dump === 'html' ? 'text/html' : dump === 'markdown' ? 'text/markdown' : 'application/json',
      })
    })
  })
}
