#!/usr/bin/env node
/**
 * One-off helper: verify the GreyRaphael/moli release source and refresh the
 * cached binary (~/.cache/moli/moli) by exercising the plugin's own resolver.
 *
 * Usage: node scripts/switch-moli.mjs [--force]
 */
import {
  fetchLatestMoliReleaseTag,
  downloadLatestMoliBinary,
  getLocalMoliVersion,
  resolveMoliBinary,
} from '../lib/index.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync, accessSync, constants } from 'node:fs'

function isExecutableFile(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const force = process.argv.includes('--force')
const cached = join(homedir(), '.cache', 'moli', 'moli')

console.log(`[switch-moli] latest tag on release source: ${await fetchLatestMoliReleaseTag()}`)
console.log(`[switch-moli] local cached version: ${getLocalMoliVersion(cached)}`)

const bin = await downloadLatestMoliBinary(undefined, { forceOverwrite: force })
if (!isExecutableFile(bin)) throw new Error(`downloaded binary not executable: ${bin}`)
console.log(`[switch-moli] binary ready at ${bin} (version ${getLocalMoliVersion(bin)})`)
console.log(`[switch-moli] resolver picks: ${await resolveMoliBinary('')}`)
