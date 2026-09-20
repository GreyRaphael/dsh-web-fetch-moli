# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-09-20

### Changed

- **Moli 二进制上游切换至 `GreyRaphael/moli` fork（性能增强版）**:
  - `src/moli-resolve.ts` 新增 `MOLI_RELEASES_URL` / `MOLI_REPO_SLUG` 常量，将版本探测（curl HEAD 与原生 fetch 兜底）与二进制自动下载的 3 处硬编码 `lexmount/moli` URL 全部切换为 `GreyRaphael/moli`。
  - 新增 `MOLI_LATEST_DOWNLOAD_URL` 常量固化 GitHub "latest" 资产的正确下载路径格式（`/releases/latest/download/<asset>`），修复仅拼 `/releases/download/<asset>`（缺少 `latest` 段）导致 404 的隐患。
  - fork 完整保留上游 release asset 命名（`moli-<target>.tar.gz` / `.zip`），平台与架构探测逻辑零改动。
  - `src/index.ts` 新增导出 `downloadLatestMoliBinary`、`getMoliReleaseAsset`、`MOLI_RELEASES_URL`、`MOLI_REPO_SLUG`，方便外部工具复用解析与下载能力。
  - 同步更新 `README.md`、`README.zh-CN.md` 与 `.github/workflows/ci.yml` 中的全部上游链接与安装命令。
  - 新增 `scripts/switch-moli.mjs` 迁移脚本：走插件自身解析器校验新发布源并强制刷新本地 `~/.cache/moli/moli` 二进制（支持 `--force`）。

### Verified

- 本地缓存的 moli 二进制已升级至 fork 的 **v1.1.8**（原 1.1.7）。
- 测试套件 13 个文件 134 项测试全部通过（含真实 moli 守护进程集成测试）。
- 端到端验证：`moli serve` CDP 守护进程就绪、健康检查通过、页面渲染（example.com 返回 200）与去噪 Markdown 输出正常。

## [0.4.0] - 2026-09-17

### Changed

- **彻底移除 `cli`（单次命令行）模式，统一收敛为原生轻量 CDP 驱动**:
  - 移除了 `src/cli-runner.ts` 及所有相关的单次命令行进程启动与解析逻辑。
  - `MoliBackend` 运行模式严格收敛为 `'local' | 'cdp'`；`maxConcurrency` 的 CLI 默认并发配置也一并清理。
  - 重构前端 WebUI 配置面板：移除 `cli` 单选，并将仅在 `cdp` 模式下生效的 `shareBrowserContext` 配置下沉内嵌至 `cdp` 模式设置块中，消除“配置项在 local 下无效却暴露在全局”的体验混淆。
  - 精简相关测试套件，13 个测试文件共 134 项测试全部通过。

## [0.3.12] - 2026-09-16

### Fixed

- **修复弱网/慢速环境下微前端与复杂 SPA 瀑布流卡片提前中断与未去噪问题**:
  - **建议 1 修复（动态渲染与无限滚动）**:
    - 优化 `settleDynamicSpa`：延长骨架屏/加载动画等待上限至 `Math.min(25_000, ...)`，且当卡片或 Sentinel 已挂载到 DOM 时优先判定已就绪，避免因页面常驻的微弱 `.ant-spin` 类误判未就绪导致超时退出。
    - 修复 `runSentinelRounds` 误触底提早退出：移除 `(res.cardsCount > 0 && !res.hasSentinel)` 的过早中断逻辑，严格要求 `unchangedRounds >= 2` 才判定停止增长；同时保留此前已见 Sentinel 后的 `everHadSentinel && !res.hasSentinel` 触底快速收敛机制，防止首轮尚未挂载 Sentinel 时直接中断。
    - 优化单轮等待节奏至 1200ms，为弱网环境下的下一批数据请求保留充裕的网络往返与 DOM 挂载时间。
  - **建议 2 修复（配置容错与默认兜底）**:
    - 在 `src/index.ts` 的 `apply` 中对外部传入的 `config` 默认通过 `Config(config ?? {})` 注入 schema 完整默认值；在 `MoliFetchProvider` 内部增设 `withDefaults` 深度兜底。
    - 修复判断条件从 `!config.denoise` 改为严格的 `config.denoise === false`，彻底消除未配置时回退为未去噪原始 HTML 并在 100,000 字符处被截断的问题。
    - 将 `DEFAULT_TIMEOUT_MS` 提升至 90s，为多达 10 轮排版物化与网络加载的重型微前端页面（如阿里云百炼 179 张卡片）提供充裕的端到端执行预算。


### Fixed

- **自动穿透与对齐 Preset 预设作用域的 `web_fetch` 超时预算**:
  - 针对 DSH Web 模式下 Agent Preset（如 `standard` 预设）漏设 `fetchTimeoutMs` 导致 `web_fetch` 被局部作用域 30s 默认值遮蔽（shadowing）的问题，通过 Cordis `ctx.inject(['tools'])` 安全挂载 `tools/execute` 前置流水线钩子（`prepend: true`）。
  - 在每次分发 `web_fetch` 前，动态把当前会话/预设作用域中的 `tool.timeoutMs` 提升并对齐至 Moli 的实际配置预算（默认 60s），确保上层 `@deepseek-ai/dsh-tool-call-timeout-policy` 守卫自动采用 60s 倒计时，彻底告别 `Error: tool call timed out after 30000ms`。
  - 遵循 Cordis 严格的服务依赖隔离规范，零破坏性，无需用户修改 DSH 源码或自定义 Preset。

## [0.3.10] - 2026-09-16

### Fixed

- **修复 Cordis 插件激活时非法访问未注入服务导致崩溃的问题**:
  - 彻底移除 `src/index.ts` 中对未在 `inject` 声明的 `(ctx as any).tools` 的非法访问，解决 `Error: cannot get property "tools" without inject` 导致的插件激活失败（`1 entry did not activate`）。
  - 超时完全由插件自身的 `Config.timeoutMs`（默认 60s）与 `cordis.patch.yml` 声明控制，且与传入的外部 `signal` 自动协同，遵循 Cordis 严格的服务依赖隔离契约。

## [0.3.9] - 2026-09-16

### Added

- **深度对齐 DSH `fetchTimeoutMs` (60s) 超时预算**:
  - 在 `Config` 中新增 `timeoutMs` 配置字段，并将抓取全局兜底预算从写死的 25s 提升至 60,000ms（与 `cordis.patch.yml` 中 `tool-web` 的 60s 预算完全对齐）。
  - 运行时动态感知 `ctx.tools.get('web_fetch')?.timeoutMs`，实现与上层 DSH 工具守卫预算的双向智能自动同步。
  - 前端 UI 设置卡片与中英本地化字典全面增加 `timeoutMs` 配置支持。

### Changed

- **重构预导航与安全 CDP 指令管道**:
  - 严格仅保留 6 项有实际业务改变意义的非默认 CDP 配置（`Page/Runtime/Network.enable`、`Page.setBypassCSP`、`Security.setIgnoreCertificateErrors`、`Network.setBypassServiceWorker`）。
  - 省略 Moli 原生出厂自带的 1080P 桌面视口与 `navigator.webdriver=false`，规避旧版 Moli 报错 `UnknownMethod`。
  - `setBypassCSP` 动态透传前端配置的布尔值，杜绝连接池复用时的状态遗留。
- **Micro-Clip 物化与 W3C 标准滚动机制**:
  - 彻底废除 UserScript 猴子补丁，采用极简 1x1 Micro-Clip 截图促发 Moli 布局树物化，结合 W3C 原生 `scrollIntoView` 机制稳定加载 179+ 瀑布流卡片。
- **Moli 内核升级**:
  - 插件升级时自动检测并从 GitHub Releases 同步最新版 Moli 二进制。

## [0.3.2] - 2026-09-14

### Fixed

- **修复微前端及复杂 SPA 在 DOM 就绪前过早退出的数据截断问题**:
  - 移除脆弱且依赖类名猜测的 `waitForSpaHydration` 探测，避免在微前端加载脚本阶段因 DOM 尚未生成 spinner 而误判退出。
  - 恢复健全的 Sentinel 观测生命周期，增加 800ms 初始加载宽限期与 400ms 重试，为慢速 SPA 提供充足的微前端容器加载时间。
  - 优化 Sentinel 触发轮次为 2 轮（每轮 500ms 间隔）及 500ms 沉淀时间，相比旧版减少 16s 无效等待，将阿里云百炼（179 个模型卡片，2.1 万字 Markdown）抓取时间稳定在 14s 内完成，彻底杜绝 30s 工具调用超时。
  - 为 `runSentinelRounds` 增加 `page.evaluate` 安全守卫，增强 mock 单元测试与无 evaluate 环境下的健壮性。

## [0.3.1] - 2026-09-14

### Fixed

- **修复单包构建产物与依赖打包问题**:
  - 将 `linkedom`、`@mozilla/readability`、`@mdream/js` 完全内联打包入 `lib/index.js` 单一 ESM 产物，避免动态加载分块缺失。
  - 优化微前端加载状态处理，解决 `session.v3` 日志中发现的工具调用超时问题。

## [0.3.0] - 2026-09-14

### Changed

- **升级为高性能双阶段 Markdown 管道（方案 C）**:
  - **阶段 1（降噪与正文提取）**: 采用轻量级虚拟 DOM 引擎 `linkedom` 结合 `@mozilla/readability`，以极低内存开销精准提取主体正文并剔除导航、页脚、侧边栏等冗余布局。
  - **阶段 2（HTML 转 Markdown）**: 采用 `mdream`（Rust 原生 NAPI 加速，自动回退纯 JS `@mdream/js`），专为大语言模型优化的 Markdown 生成算法，完美处理复杂嵌套表格、代码块及语义化排版。
  - 全面替换旧版简易正则转换引擎，彻底解决阿里云百炼等复杂页面 Markdown 生成时内容丢失与格式破碎问题。

## [0.2.1] - 2026-09-14

### Fixed

- **修复包发布缺少动态代码分块（cdp-client chunk）的问题**: 将 `src/moli-resolve.ts` 中对 `cdp-client.ts` 的引用改为静态导入，使 `lib/index.js` 单独打包为一个完整自包含的 ESM bundle；同时将 `package.json` 的 `files` 字段规范为包括完整的 `lib` 目录，避免插件打包或发布时遗漏生成的产物。

## [0.2.0] - 2026-09-14

### Changed

- **零重型外部依赖重构（Zero Heavy External Dependencies）**:
  - 移除 `playwright-core`，基于 Node.js 原生 `fetch` 与 `WebSocket` 实现纯 TypeScript 原生 CDP 客户端（`src/cdp-client.ts`），支持会话管理、目标附加、网络请求拦截路由与页面生命周期监听。
  - 移除 `jsdom`、`@mozilla/readability`、`dompurify`、`turndown` 及 `@joplin/turndown-plugin-gfm`，实现零依赖纯原生 HTML 清洗与 GFM Markdown 转换引擎（`src/markdown.ts`），大幅降低内存占用与 GC 压力，解析性能提升数十倍。
  - 生产依赖仅保留 `@deepseek-ai/schemastery`，安装体积减少数十 MB，消除潜在供应链依赖安全风险。

## [0.1.6] - 2026-09-14

### Fixed

- **Fix incomplete response on asynchronous micro-frontend and lazy-loaded SPA pages**: Extended IntersectionObserver sentinel discovery timeout (`maxSentinelWaitMs` from 3.5s to 10s) and per-round render settle time (from 1.2s to 1.5s) in `runSentinelRounds`. Added immediate early-break when sentinels mount. Enables full infinite-scroll catalog extraction on complex micro-frontend platforms (such as Alibaba Cloud Bailian Model Market, extracting all 179 model cards).
- **Update real-world micro-frontend benchmark timeout**: Raised vitest timeout in `tests/bailian-benchmark.spec.ts` from 60s to 90s to comfortably accommodate full catalog extraction across multiple network batches.

## [0.1.5] - 2026-09-14

### Fixed

- **Eliminate deprecated `whatwg-encoding` subdependency warning**: Upgraded `jsdom` from `^26.0.0` to `^29.1.1`. Modern jsdom uses `@exodus/bytes` and `html-encoding-sniffer@^6.0.0`, eliminating the npm deprecation warning for `whatwg-encoding@3.1.1` during plugin installation.
- **Mark `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-web` optional in `peerDependenciesMeta`**: When installing the plugin into a DSH profile via `dsh plugin --profile <name> add`, pnpm no longer flags missing peer dependency warnings for host-injected services.
- **Modernize tsdown bundling options**: Updated `tsdown.config.ts` from deprecated `external` / `noExternal` to `deps: { neverBundle, alwaysBundle }`, eliminating compiler warnings during build.
- **Dependency updates**: Bumped `@joplin/turndown-plugin-gfm` to `^1.0.68`, `dompurify` to `^3.4.15`, and aligned devDependency `@deepseek-ai/cordis` to `4.0.2`.

## [0.1.4] - 2026-09-14

### Changed

- **Clean and standardized Moli provider registration**: Standardized provider identity strictly to `moli` (id: `moli`). Cleaned up legacy client radio group form names to `moli-backend`. Added Cordis integration test coverage verifying provider registration into `ctx.web`.


### Fixed

- **Boot no longer fails against dsh-settings 0.1.2+** (`dsh web` died with `plugin tree failed to load … The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'installSettingsSection'`). The plugin was built against the 0.1.1-era API whose top-level helpers (`installSettingsSection`, `settingsNamespace`) no longer exist: dsh-settings 0.1.2 moved that behavior onto the settings service itself (`ctx.settings.installSection(owner, ns, schema, entry, hooks)`) and replaced the runtime `settingsNamespace()` factory with the plain `SettingsNamespace` string type. The host resolves a plugin's bare `@deepseek-ai/*` imports against its own module graph (the loader imports entry packages with the host context as resolution parent), so the plugin's local 0.1.1-rc.1 copy never shields it — the moment the host runs dsh-settings ≥0.1.2, ESM's strict named-export check kills the whole plugin tree at link time. `apply()` now follows the same idiom as the shipped providers (see `web-search-deepseek`): the namespace is a literal constant and the section installs through `ctx.inject(['settings'], (settingsCtx) => settingsCtx.settings.installSection(...))`, so `lib/index.js` no longer imports `@deepseek-ai/dsh-settings` at runtime at all. Dependencies were aligned to the host generation: devDependencies to `0.1.2-alpha.5` (plus `@deepseek-ai/dsh-client-store`, which the published ui-slots types import but do not declare — without it `InjectFace`'s `HostObservable` inference silently degrades to `any` and `card.tsx` fails typecheck), `@deepseek-ai/schemastery` to `>=3.18.2`, and the dsh-settings/dsh-web peer ranges tightened to `>=0.1.2-alpha.0 <0.3.0` (older hosts lack `installSection` and can no longer load this plugin). Verified against the host's real module graph: namespace `web-fetch-moli` registers, the `moli` fetch provider lands in `ctx.web`, and a committed settings change reaches the provider's config thunk; the full suite (126 tests) stays green.

- **Normal pages of Cloudflare-Bot-Management sites no longer misclassify as challenges** (badcase: `https://openrouter.ai/openai/gpt-6-astra-pro`). Cloudflare injects its passive JavaScript-Detections (JSD) telemetry into EVERY normal page of a protected zone — either as a direct `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">` or as that URL strung inside a hidden-1x1-iframe bootstrap's inline script text. The URL embeds the `/cdn-cgi/challenge-platform/` prefix, so the content-level marker scan read every such plain-200 real-content page as an interstitial; the live DOM probe then correctly said "not challenged", but the chained-round recheck re-ran the same false positive and overrode it, burning the whole wait budget and all retries and failing with `WEB_FETCH_CHALLENGE` ("last status 200"). The classifier now strips the `scripts/jsd/` telemetry directory before the challenge-platform prefix check (`classifyChallengeHtml`) and the DOM probe excludes it from its script-src scan (`CHALLENGE_DOM_PROBE`); the bare `/cdn-cgi/scripts/jsd/main.js` marker left the list entirely — it is telemetry in every spelling. Real interstitials still classify: they load orchestrate scripts (`/cdn-cgi/challenge-platform/h/…`) plus `window._cf_chl_opt` / `#challenge-*` / the title family, none of which live under `scripts/jsd/` (regression-tested, including an interstitial that carries the JSD script alongside its own orchestrate scripts). Verified live: the openrouter.ai badcase and nowsecure.nl both return their real articles now, and the full suite (126 tests incl. real-browser challenge integration) stays green.

### Removed

- `dsh.plugin.json`, the standalone plugin manifest. Its content was fully redundant with what the host already reads from `package.json` (the `dsh.*` fields plus `cordis.patch.yml` via `dsh.bundle.patch`), and as a second version-carrying file it had already drifted once (0.2.4's lockstep note) — the package manifest is now the single version source. The stale `"dsh.plugin.json"` entry is gone from the `files` list too, so the published tarball no longer claims a file it does not carry.

## [0.2.6] - 2026-08-27

### Fixed

- **Windows `$PATH` discovery works** (issue #1): `findOnPath` split `process.env.PATH` on a literal `:`, but Windows joins PATH entries with `;` — the whole variable read as one bogus directory, so auto-discovering a `playwright` executable (blank `playwrightPath`) never found anything and silently fell through to the bundled `playwright-core`. It now splits on Node's `path.delimiter`, and a regression test scans a multi-directory PATH with the probe in a non-first entry (the case both Windows reproducers in the issue hit).
- **`pnpm build` is cross-platform** (issue #1): the build script cleaned `lib/` with `rm -rf`, which does not exist on Windows PowerShell — `'rm' is not recognized` killed the build before TypeScript declarations or tsdown ever ran, and since `prepare` runs the same script, installing from a git checkout failed on Windows too. The clean step is now `node -e "require('node:fs').rmSync('lib',{recursive:true,force:true})"`, which works everywhere Node does (a follow-up `scripts/clean.mjs` was considered and dropped to keep the pipeline in one place; tsdown's own `clean` cannot replace it — it runs after `tsc` and would delete the declarations just emitted).
- CI now runs the full check (install, typecheck, test, build) on `windows-latest` alongside `ubuntu-latest`, Node 22/24 — so the PATH-split and build-script regressions above cannot land again unnoticed. The tarball content verification stays Linux-only (`/tmp` + `tar`/`grep` piping); it checks npm packaging, not platform behavior.
- Known Windows limitation, documented rather than fixed here: npm/pnpm global installs expose `playwright` as `.cmd`/`.ps1` shims whose upward walk cannot find the package root, so PATH auto-discovery may still land on the bundled core. Setting `playwrightPath` to the package root or a browser executable selects the intended installation; PATHEXT-aware probing is tracked as a follow-up.

## [0.2.5] - 2026-08-25

### Added

- **Bounded Cloudflare-challenge wait** (issue #2): when a navigation lands on a challenge interstitial, the fetch now keeps the **same page and browser context** and waits for the browser's own verification to clear it, instead of returning the interstitial as content (the behavior before this release — with a strict site that meant "Just a moment…" as markdown within ~1s, the real article never captured even though the browser would have passed the check seconds later).
  - Detection is layered with a suspicion gate: the documented `cf-mitigated: challenge` response header (set on every challenge page type), then 403/503 HTML from a `server: cloudflare` edge, then content-level markers — the localized interstitial title family ("Just a moment...", "请稍候…", "Минутку…", …) plus structural markers (`/cdn-cgi/challenge-platform/` scripts, `#challenge-*` elements, `cf-chl-widget-` frames, `window._cf_chl_opt`, the `.footer .footer-inner .ray-id` footer). Markers are attribute/assignment-shaped so an article that merely quotes them stays clean, and the content tier only runs on challenge-compatible responses (`isChallengeCompatibleResponse`: 403/429/503, or `server: cloudflare` / `cf-ray` present) — interstitials never ship a plain 200, so a normal article cannot be misread as a challenge (and normal fetches skip the extra content read entirely). Hard-block pages ("Attention Required!", "you have been blocked" + a `cf-headline`/`cf-error-details` layout) classify separately and fail immediately.
  - During the wait the provider tracks the **last main-frame navigation response** (the real page reloads in after the clear) and probes the live DOM every 500ms, so SPA-style clears (content swapped with no navigation) are captured too; a probe that throws mid-navigation (context destroyed) counts as "still challenged". A clear that lands on a *chained* round (JS test → Turnstile interstitial) is caught by a settled-DOM recheck — content-level, deliberately, so SPA clears whose response stays 403 forever still pass — and consumes one of the retries.
  - Knobs: `challengeWaitMs` (0–60000, default 15000; **0 disables the whole path and restores the exact pre-0.2.5 behavior**) and `challengeRetries` (0–3, default 1 — a same-tab re-navigation whose context keeps any clearance cookies the browser earned). Everything stays inside the 45s per-fetch deadline with a finish reserve; on exhaustion the fetch fails with the new provider-specific `WEB_FETCH_CHALLENGE` code (the web seam's open-string `code` tolerates provider codes) naming the site, budget, and last challenge status.
  - Cookie lifecycle is unchanged by design: isolated fetches' clearance dies with their context (verified: a second isolated fetch is challenged again), profile-mode clearance stays in the remote browser's own profile (verified: a second profile fetch skips the challenge); nothing is exported, copied, or manufactured. No clicking, no CAPTCHA answers, no fingerprint spoofing.
  - Settings card gains a *Cloudflare challenge wait (ms)* number field; `scripts/challenge-demo.mjs` runs a local simulated strict edge through the baseline and the feature for a before/after printout.
- New exports: `classifyChallengeResponse`, `classifyChallengeHtml`, `isChallengeCompatibleResponse`, `CHALLENGE_DOM_PROBE`, `CHALLENGE_TITLE_RE`, `CHALLENGE_POLL_INTERVAL_MS`, `CHALLENGE_FINISH_RESERVE_MS`, `WEB_FETCH_CHALLENGE_CODE`, `DEFAULT_CHALLENGE_WAIT_MS`, `DEFAULT_CHALLENGE_RETRIES`, `effectiveChallengeWaitMs`, `effectiveChallengeRetries`, and the `ChallengeVerdict` type.

## [0.2.4] - 2026-08-25

### Fixed

- Denoise now elides inline `data:` image payloads (`data:image/png;base64,...`) to size placeholders like `![alt](data:image/png;base64,...8.9KB)`. Build tools (Docusaurus/webpack) inline images above a size cutoff straight into the HTML; they survived Readability, DOMPurify, and Turndown as raw base64 — on the onlyoffice.com docs events page that was **65% of the returned body** (100k chars, truncated at the cap). With the placeholder the same page returns 41.8k chars complete. The elision happens in the DOM before extraction, so both the article and whole-document fallback paths apply it; it runs under the denoise toggle only (raw-HTML mode is untouched) and keeps alt text, MIME type, and the approximate size.
- `dsh.plugin.json` version had drifted (still 0.2.2 after the 0.2.3 release); both manifests now move in lockstep at 0.2.4.

## [0.2.3] - 2026-08-24

### Fixed

- The bundle layer no longer pins `searchProvider: deepseek-official` on the `web` row. The pin out-ranked every later layer, so a user's own search-provider bundle could register and stay healthy yet never be selected — and `$DSH_WEB_SEARCH_PROVIDER` was dead config too (the row's config beat the env). The row's whole config is still replaced by the patch (no deep merge), so `searchProvider` is now simply **omitted**: with the base bundle's single registered search provider, auto-selection picks it exactly as before, while any later layer — a user search bundle, the profile/home `cordis.patch.yml`, or `$DSH_WEB_SEARCH_PROVIDER` — is free to pin search. Two usable search providers with no explicit selection still fail loud (`WEB_PROVIDER_AMBIGUOUS`) instead of guessing. Fetch stays pinned to `moli`; this bundle owns fetch, not search.

## [0.2.2] - 2026-08-24

### Added

- CDP context modes: a new `shareBrowserContext` setting (checkbox *Share the browser context (profile logins)* nested under the Remote CDP option in the plugin-configuration card, default **on**) selects how each CDP fetch is scoped. **Profile mode** (default): each fetch is a tab in the remote browser's default context — its real profile — so cookies/localStorage are shared and the browser's persistent logins apply; the tab closes when the fetch ends, the shared context never closes. **Isolated mode** (unchecked): the previous behavior — a fresh incognito-like context per fetch.
- `effectiveContextMode(config)` and the exported `CdpContextMode` / `CdpAcquireMode` types.
- Popup guard: popups a fetched page spawns (`window.open`) are closed so no tab outlives its fetch in the remote browser.

### Changed

- The fetch lease is now page-scoped: `CdpLease` carries `page` + `persistent`, `CdpConnectionPool.acquire` takes a mode, and `release` closes only what the lease owns (page always; context unless it is the remote default context). The connection-management core (ensure/connect/watch/drop/dispose) is unchanged — a `browser.close()` on a CDP handle only disconnects, so the remote browser always survives.
- Resource-subrequest filtering moved from context level to **page level**, so profile mode never intercepts tabs it does not own (an operator's manual tabs in the same context).
- Local-backend pages are closed explicitly on teardown (previously the page relied on its context's close to take it down).

### Fixed

- Local sessions now close in a defined order — page, context, browser — each grace-bounded, instead of leaving the page to the context-close side effect.
- Partial-failure leaks: an isolated lease whose `newPage()` fails on a live connection now closes the context it just created (it previously stayed open until the whole connection went away), and the local backend closes its launched browser when `newContext()`/`newPage()` fail after a successful launch (a whole Chromium previously stayed running).

### Security

- Profile mode is a semantic upgrade: fetched pages see the remote browser's logged-in identity, and requests they goad the agent into carry its session cookies. README (en/zh) documents the risk notes and the persistent-`user-data-dir` browser setup; the disclosure adds a credentialed-fetch permission entry.

## [0.2.1] - 2026-08-23

### Fixed

- CI no longer fails on every push: the matrix dropped Node 20 and runs on Node 22/24. `pnpm/action-setup` with a floating `version: 11` resolves to pnpm 11.22.0, which requires Node ≥ 22.13 (`node:sqlite`) and crashed the Node 20 job inside `setup-node` before any step ran, with fail-fast cancelling the healthy 22/24 jobs. Node 20 cannot be restored by pinning pnpm alone: the `tsdown` 0.22 build (run by `prepare` on install) also requires Node ≥ 22.18.
- `CONTRIBUTING.md` now states the toolchain needs Node ≥ 22 while the published plugin itself still runs on Node ≥ 20 (no Node 22+ APIs in the runtime code or build output).

## [0.2.0] - 2026-08-21

### Changed

- CDP backend architecture: instead of one `connectOverCDP` per fetch, the provider now keeps a **single shared connection** to the remote browser for its lifetime; each fetch leases an isolated context (a tab) and closes only that. Reconnects automatically when the connection drops or the configured endpoint changes; the connection is dropped on plugin unload. Concurrent fetches therefore cost tabs, not connections or browsers.
- Concurrency is backend-priced: `maxConcurrency` is now optional with backend-dependent defaults — **4** for local (each slot launches a whole Chromium) and **50** for CDP (each slot is a tab in the already-running browser), range widened to 1–200. The settings card explains the auto default; an explicit value still wins.

### Fixed

- `web fetch aborted while waiting for a free browser slot` no longer surfaces as the common failure under parallel `web_fetch` bursts: the CDP default alone covers 50 concurrent tabs, and a queued fetch that gets no slot within 20s fails fast with `WEB_FETCH_TIMEOUT` plus a retry/`maxConcurrency` hint instead of hanging until an abort mislabels it.
- Queue-wait errors translate through the standard taxonomy: the provider's own deadline expiring while queued reports `WEB_FETCH_TIMEOUT`, and a caller cancelling a queued fetch keeps the precise slot message under `WEB_ABORTED`.
- Cleanup hardening: context/browser closes in the fetch teardown are grace-bounded (2s), so a wedged Playwright close can no longer pin a concurrency slot forever (which previously made every later fetch die on the queue), and a queued fetch that fails to acquire never releases a phantom slot.

### Added

- `CdpConnectionPool` (exported): the shared-connection core — one connect under concurrent acquires, per-fetch context leases, liveness probes (`isConnected` + `disconnected`), single reconnect-and-retry, generation-guarded abandonment of connects made stale by an endpoint change or dispose.
- `effectiveMaxConcurrency(config)` and the `DEFAULT_MAX_CONCURRENCY_LOCAL` / `DEFAULT_MAX_CONCURRENCY_CDP` / `MAX_CONCURRENCY_CEILING` constants.
- Provider `dispose()` plus a `ctx.effect` teardown hook in the plugin entry that drops the shared CDP connection on unload.
- Tests: the CDP pool (8 cases), provider-level CDP behavior (one connection, tabs closed per fetch, 50-way tab burst, dead endpoint), queue cases, and a real-Chromium CDP integration smoke (debugging port, denoise fetch, 12-tab concurrent burst) that self-skips without a browser.

## [0.1.1] - 2026-08-21

### Fixed

- Peer ranges for `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-web` now carry an explicit prerelease branch (`>=0.1.0-rc.6 <0.2.0 || >=0.1.1-rc.1 <1`): a bare `>=0.1.0-rc.6 <1` silently excludes `0.1.1-rc.1` builds under node-semver's prerelease rule, which would resolve an older host package copy for npm installs.

### Added

- Tests for the client card form model (staging, save writes, failed-save retention, discard, radio/checkbox fields) and GFM edge cases (strikethrough, checkbox lists, table separators).
- `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue/PR templates, and README links to them.

## [0.1.0] - 2026-08-21

### Added

- First public release as a DSH bundle plugin.
- `PlaywrightFetchProvider` registered with `ctx.web` under id `playwright`; the bundle patch pins the web seam's `fetchProvider` to it and enables the `web_fetch` tool with a 60s budget.
- Local backend: path / `$PATH` / bundled `playwright-core` resolution with native-executable sniffing and package-root discovery.
- Remote backend: CDP connect (`connectOverCDP`) with fresh isolated context per fetch.
- Denoise pipeline: jsdom → Mozilla Readability → DOMPurify (layout tags dropped, `KEEP_CONTENT: false`) → Turndown + GFM with `tool-web`-consistent style and table rules.
- Per-fetch deadline (45s), concurrent-fetch semaphore (2), resource-subrequest filtering, 100k body cap, `WEB_*` error taxonomy parity with the shipped HTTP provider.
- Client settings card (*Playwright 网页爬取*) with backend radio, nested path/CDP inputs, denoise checkbox, and zh/en locales.
- Unit tests (config, markdown, playwright resolution, provider over a fake browser) plus a self-skipping real-browser integration smoke.
