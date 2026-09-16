/**
 * Locale bundles for the Moli card.
 *
 * @module dsh-web-fetch-moli/client/locales
 */

/** Locale keys this card renders. */
export type MoliCardLocaleKey =
  | 'title' | 'description'
  | 'backendLabel' | 'backendLocal' | 'backendLocalHint' | 'backendCdp' | 'backendCdpHint' | 'backendCli' | 'backendCliHint'
  | 'moliPath' | 'moliPathHint' | 'moliPathPlaceholder'
  | 'cdpEndpoint' | 'cdpEndpointHint'
  | 'bypassCsp' | 'bypassCspHint'
  | 'autoScrollSentinel' | 'autoScrollSentinelHint'
  | 'shareBrowserContext' | 'shareBrowserContextHint'
  | 'denoise' | 'denoiseHint'
  | 'maxConcurrency' | 'maxConcurrencyHint' | 'maxConcurrencyPlaceholder'
  | 'challengeWaitMs' | 'challengeWaitMsHint' | 'challengeWaitMsPlaceholder'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidText'

/** This plugin's dictionary namespace, merged into the locale key map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-fetch-moli': MoliCardLocaleKey
  }
}

/** English copy. */
export const en: Record<MoliCardLocaleKey, string> = {
  title: 'Moli web fetch',
  description: 'Ultra-lightweight web-fetch provider using Moli (Rust headless browser, ~60MB RAM). Supports local daemon, one-shot CLI, and remote CDP.',
  backendLabel: 'Backend mode',
  backendLocal: 'Local Moli daemon',
  backendLocalHint: 'Spawns a managed local moli serve process over CDP with micro-frontend and CSP bypass support (~60MB RAM).',
  backendCdp: 'Remote CDP endpoint',
  backendCdpHint: 'Connect to an existing Moli or Chromium CDP service over DevTools Protocol.',
  backendCli: 'One-shot CLI',
  backendCliHint: 'Executes moli fetch directly per request without running a background daemon.',
  moliPath: 'Moli executable path',
  moliPathHint: 'Leave blank to auto-discover moli on $PATH or standard directories.',
  moliPathPlaceholder: '(auto: moli from $PATH)',
  cdpEndpoint: 'CDP endpoint',
  cdpEndpointHint: 'host:port or http(s)/ws URL. Leave blank for 127.0.0.1:9222.',
  bypassCsp: 'Bypass CSP (micro-frontend support)',
  bypassCspHint: 'Enables CDP Page.setBypassCSP to allow dynamic script loading in micro-frontend sandboxes (e.g. Alibaba Alfa / qiankun).',
  autoScrollSentinel: 'Auto-trigger lazy-load sentinels',
  autoScrollSentinelHint: 'Enables native CDP micro-clip layout materialization and scrollIntoView to dynamically load infinite card lists.',
  shareBrowserContext: 'Share browser context (profile logins)',
  shareBrowserContextHint: 'Preserves cookies and localStorage across fetches. Unchecked: fresh isolated context per fetch.',
  denoise: 'Enable denoise algorithm',
  denoiseHint: 'Readability + mdream strips ads, nav bars, and footers before LLM-optimized markdown conversion.',
  maxConcurrency: 'Max concurrent fetches',
  maxConcurrencyHint: 'How many fetches may render at once. Blank = auto: local 20, remote CDP 50, CLI 8.',
  maxConcurrencyPlaceholder: '(auto: local 20 / CDP 50 / CLI 8)',
  challengeWaitMs: 'Cloudflare challenge wait (ms)',
  challengeWaitMsHint: 'Bounded wait for Cloudflare challenge verification. 0 = off.',
  challengeWaitMsPlaceholder: '(default: 15000)',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidText: 'This value is not accepted here.',
}

/** Simplified Chinese copy. */
export const zh: Record<MoliCardLocaleKey, string> = {
  title: 'Moli 网页爬取',
  description: '基于 Moli（超轻量 Rust 无头浏览器，仅约 60MB 内存）的网页抓取插件。支持本地服务、单次 CLI 及远程 CDP。',
  backendLabel: '后端运行模式',
  backendLocal: '本地 Moli 服务',
  backendLocalHint: '在本地启动受管的 moli serve 服务并通过 CDP 通信，支持微前端沙箱与 CSP 绕过，内存占用仅约 60MB。',
  backendCdp: '远端 CDP 地址',
  backendCdpHint: '连接至已在运行的 Moli 或 Chromium CDP 端口。',
  backendCli: '单次 CLI 命令',
  backendCliHint: '每次请求直接执行 moli fetch 命令行，无需后台常驻进程。',
  moliPath: 'Moli 可执行文件路径',
  moliPathHint: '留空则按系统 $PATH 或默认目录查找 moli。',
  moliPathPlaceholder: '（自动：按 $PATH 查找 moli）',
  cdpEndpoint: 'CDP 地址',
  cdpEndpointHint: 'host:port 或 http(s)/ws 地址；留空默认 127.0.0.1:9222。',
  bypassCsp: '绕过 CSP（支持微前端）',
  bypassCspHint: '开启 CDP Page.setBypassCSP，允许微前端沙箱（如阿里 Alfa / qiankun）动态加载模块。',
  autoScrollSentinel: '自动触发瀑布流懒加载',
  autoScrollSentinelHint: '开启原生 CDP Micro-Clip 排版物化与 scrollIntoView 动态滚动，自动加载全部无限瀑布流卡片。',
  shareBrowserContext: '共享浏览器上下文（复用登录态）',
  shareBrowserContextHint: '复用 cookie 与 localStorage；取消勾选则每次抓取使用全新隔离上下文。',
  denoise: '启用降噪算法',
  denoiseHint: '使用 Readability + mdream 清洗广告、导航栏与页脚后转为大模型优化的高质量 Markdown。',
  maxConcurrency: '最大并发抓取数',
  maxConcurrencyHint: '同时执行抓取的并发上限。留空自动：本地 20，远端 50，CLI 8。',
  maxConcurrencyPlaceholder: '（自动：本地 20 / CDP 50 / CLI 8）',
  challengeWaitMs: 'Cloudflare 挑战等待上限（毫秒）',
  challengeWaitMsHint: '在同一页面内有界等待 Cloudflare 验证通过。0 为关闭。',
  challengeWaitMsPlaceholder: '（默认：15000）',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidText: '该值不被此设置项接受。',
}
