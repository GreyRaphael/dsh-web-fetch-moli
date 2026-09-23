/**
 * Locale bundles for the Moli card.
 *
 * @module dsh-web-fetch-moli/client/locales
 */

/** Locale keys this card renders. */
export type MoliCardLocaleKey =
  | 'title' | 'description'
  | 'backendLabel' | 'backendLocal' | 'backendLocalHint' | 'backendCdp' | 'backendCdpHint'
  | 'moliPath' | 'moliPathHint' | 'moliPathPlaceholder'
  | 'cdpEndpoint' | 'cdpEndpointHint' | 'cdpEndpointPlaceholder'
  | 'bypassCsp' | 'bypassCspHint'
  | 'autoScrollSentinel' | 'autoScrollSentinelHint'
  | 'shareBrowserContext' | 'shareBrowserContextHint'
  | 'denoise' | 'denoiseHint'
  | 'timeoutMs' | 'timeoutMsHint' | 'timeoutMsPlaceholder'
  | 'maxConcurrency' | 'maxConcurrencyHint' | 'maxConcurrencyPlaceholder'
  | 'challengeWaitMs' | 'challengeWaitMsHint' | 'challengeWaitMsPlaceholder'
  | 'challengeRetries' | 'challengeRetriesHint' | 'challengeRetriesPlaceholder'
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
  description: 'Ultra-lightweight web-fetch provider using Moli (Rust headless browser, ~60MB RAM). Supports local managed daemon and remote CDP.',
  backendLabel: 'Backend mode',
  backendLocal: 'Local Moli daemon',
  backendLocalHint: 'Spawns a managed local moli serve process over CDP with micro-frontend and CSP bypass support (~60MB RAM).',
  backendCdp: 'Remote CDP endpoint',
  backendCdpHint: 'Connect to an existing Moli or Chromium CDP service over DevTools Protocol.',
  moliPath: 'Moli executable path',
  moliPathHint: 'Leave blank to auto-discover moli on $PATH or standard directories.',
  moliPathPlaceholder: '(auto: moli from $PATH)',
  cdpEndpoint: 'CDP endpoint',
  cdpEndpointHint: 'host:port or http(s)/ws URL. Leave blank for 127.0.0.1:9222.',
  cdpEndpointPlaceholder: '',
  bypassCsp: 'Bypass CSP (micro-frontend support)',
  bypassCspHint: 'Enables CDP Page.setBypassCSP to allow dynamic script loading in micro-frontend sandboxes (e.g. Alibaba Alfa / qiankun).',
  autoScrollSentinel: 'Auto-trigger lazy-load sentinels',
  autoScrollSentinelHint: 'Enables native CDP micro-clip layout materialization and scrollIntoView to dynamically load infinite card lists.',
  shareBrowserContext: 'Share browser context (profile logins)',
  shareBrowserContextHint: 'Preserves cookies and localStorage across fetches. Unchecked: fresh isolated context per fetch.',
  denoise: 'Enable denoise algorithm',
  denoiseHint: 'Readability + mdream strips ads, nav bars, and footers before LLM-optimized markdown conversion.',
  timeoutMs: 'Fetch timeout budget (ms)',
  timeoutMsHint: 'Total deadline budget for a single fetch operation (schema default 90000ms).',
  timeoutMsPlaceholder: '(default: 90000)',
  maxConcurrency: 'Max concurrent fetches',
  maxConcurrencyHint: 'How many fetches may render at once. Blank = auto: local 20, remote CDP 50.',
  maxConcurrencyPlaceholder: '(auto: local 20 / CDP 50)',
  challengeWaitMs: 'Cloudflare challenge wait (ms)',
  challengeWaitMsHint: 'Bounded wait for Cloudflare challenge verification. 0 = off.',
  challengeWaitMsPlaceholder: '(default: 5000)',
  challengeRetries: 'Cloudflare challenge retries',
  challengeRetriesHint: 'Same-page re-navigation attempts after the challenge wait window runs out.',
  challengeRetriesPlaceholder: '(default: 0)',
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
  description: '基于 Moli（超轻量 Rust 无头浏览器，仅约 60MB 内存）的网页抓取插件。支持受管本地服务及远程 CDP 集群。',
  backendLabel: '后端运行模式',
  backendLocal: '本地 Moli 服务',
  backendLocalHint: '在本地启动受管的 moli serve 服务并通过 CDP 通信，支持微前端沙箱与 CSP 绕过，内存占用仅约 60MB。',
  backendCdp: '远端 CDP 地址',
  backendCdpHint: '连接至已在运行的 Moli 或 Chromium CDP 端口。',
  moliPath: 'Moli 可执行文件路径',
  moliPathHint: '留空则按系统 $PATH 或默认目录查找 moli。',
  moliPathPlaceholder: '（自动：按 $PATH 查找 moli）',
  cdpEndpoint: 'CDP 地址',
  cdpEndpointHint: 'host:port 或 http(s)/ws 地址；留空默认 127.0.0.1:9222。',
  cdpEndpointPlaceholder: '',
  bypassCsp: '绕过 CSP（支持微前端）',
  bypassCspHint: '开启 CDP Page.setBypassCSP，允许微前端沙箱（如阿里 Alfa / qiankun）动态加载模块。',
  autoScrollSentinel: '自动触发瀑布流懒加载',
  autoScrollSentinelHint: '开启原生 CDP Micro-Clip 排版物化与 scrollIntoView 动态滚动，自动加载全部无限瀑布流卡片。',
  shareBrowserContext: '共享浏览器上下文（复用登录态）',
  shareBrowserContextHint: '复用 cookie 与 localStorage；取消勾选则每次抓取使用全新隔离上下文。',
  denoise: '启用降噪算法',
  denoiseHint: '使用 Readability + mdream 清洗广告、导航栏与页脚后转为大模型优化的高质量 Markdown。',
  timeoutMs: '抓取超时预算 (ms)',
  timeoutMsHint: '单次抓取的最大超时预算（毫秒），schema 默认 90000ms。',
  timeoutMsPlaceholder: '（默认：90000）',
  maxConcurrency: '最大并发抓取数',
  maxConcurrencyHint: '同时执行抓取的并发上限。留空自动：本地 20，远端 50。',
  maxConcurrencyPlaceholder: '（自动：本地 20 / CDP 50）',
  challengeWaitMs: 'Cloudflare 挑战等待上限（毫秒）',
  challengeWaitMsHint: '在同一页面内有界等待 Cloudflare 验证通过。0 为关闭。',
  challengeWaitMsPlaceholder: '（默认：5000）',
  challengeRetries: 'Cloudflare 挑战重试次数',
  challengeRetriesHint: '挑战等待窗口用尽后，在同一页面上的重新导航尝试次数。',
  challengeRetriesPlaceholder: '（默认：0）',
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
