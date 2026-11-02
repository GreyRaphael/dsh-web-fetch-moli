# dsh-web-fetch-moli

[English](./README.md) · [GitHub](https://github.com/GreyRaphael/dsh-web-fetch-moli)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 生态插件，为内置 `web_fetch` 工具提供基于 [Moli](https://github.com/GreyRaphael/moli)（超轻量级 Rust 无头浏览器）的渲染后端。它只占完整 Chromium/Playwright 栈一个数量级以下的内存，支持企业级复杂微前端（Micro-Frontend）、动态单页应用（SPA）与静态页面，并通过 **LinkeDOM + Readability + mdream** 高性能双阶段管道降噪清洗后输出规范的大模型优化 Markdown。

## 核心特性

- **轻量内存占用** — 本地常驻守护进程空闲时仅个位数 MB、渲染时为数十 MB（实测数据见下文），因此资源受限的边缘节点或云服务器上亦可支撑高并发抓取。具体数字与测量条件见「实测内存占用」一节。
- **企业级微前端与复杂 SPA 全面兼容** — 支持 CDP 动态绕过 CSP（`Page.setBypassCSP`）、可选忽略 TLS 证书错误（`ignoreCertificateErrors`，默认关闭）与 SW 穿透，彻底解决严格内容安全策略阻止动态 `import()` 的问题；并基于 CDP Micro-Clip 排版物化（`Page.captureScreenshot` 1x1 微视口）驱动 Moli 原生排版树计算，联动 W3C 标准 `scrollIntoView({ block: 'nearest' })` 触发展开全量无限滚动与瀑布流卡片列表（零用户脚本注入、零代理劫持）。
- **两种灵活运行模式**：
  - `local`（默认）：自动拉起受管的本地 `moli serve` CDP 守护进程，提供最完整的动态 SPA 渲染能力。
  - `cdp`：连接用户自建或远端的 Moli / Chromium CDP 服务。
- **高性能双阶段降噪管道** — 采用 LinkeDOM + Mozilla Readability 提取正文并剔除布局噪音（广告、导航栏、侧边栏、页脚），并通过 mdream（Rust 原生引擎 + 纯 JS 回退）转为高质量、高保真大模型友好 Markdown。自动缩略长 base64 图片，防止污染上下文。
- **Cloudflare 挑战有界等待** — 自动识别 `cf-mitigated: challenge` 验证页，在同一页面上下文内有界等待浏览器自然完成人机验证，无需任何违规模拟行为。

## 架构原理

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = moli
        ├─ local: 自动定位 moli 二进制 → 启动并管理 `moli serve` 守护进程 → connectOverCDP
        │           └─ setupPageHooks: 开启 Page.setBypassCSP + 可选证书忽略 + 绕过 Service Worker
        ├─ cdp:   连接用户配置的 remoteEndpoint CDP 端口
        ├─ page.goto → Micro-Clip 排版物化 + 原生滚动循环 → 等待网络空闲 (networkidle) → page.content()
        ├─ 降噪管道: LinkeDOM (DOM) → Readability (正文提取) → mdream (转 Markdown)
        └─ 输出 Markdown（关闭 denoise 时输出原始渲染 HTML）
```

## 实测内存占用

Moli 是单个 Rust 进程（没有独立的浏览器进程 + 驱动 + 渲染进程树），因此常驻内存远低于完整的 Chromium 栈。本仓库**不含基准测试脚本**；下表是单机单次实测记录，写在文档里是为了让这个说法可复现、而不是空口断言。请把它当作数量级参考，而非性能保证。

测量条件：Moli `1.1.9`、Linux x86_64、单个用 `moli serve` 启动的守护进程、从 `/proc/<pid>/status` 读取 `VmHWM`（峰值常驻内存）并对所有 `moli` 进程求和、每次 `Page.navigate` 后等待 5 秒、单标签页、无并发。

| 状态 | 峰值内存（`VmHWM`） |
| --- | --- |
| 守护进程已启动、未加载页面 | 13.2 MB |
| 加载一个轻量静态页（`example.com`）后 | 55.9 MB |
| 加载一个重型文章页（维基百科长条目）后 | 99.6 MB |

这两件事是单一数字会掩盖的：空闲成本很小，但**单个重型页面就能把一个守护进程推到约 100 MB**，且页面关闭后进程不会回落（`VmHWM` 高水位保持不变）。请按此估算每并发抓取的内存占用，而不是拿一个数字去乘并发数。

这里刻意不与其他引擎做定量对比：本仓库没有任何 Chromium、Lightpanda 或 Obscura 的测量数据，也没有跑过它们的测试套件，因此不给出各家产品的具体数字或失败指控。可以仅凭本仓库代码与测试确认的是：插件通过 CDP 驱动 Moli、为动态脚本加载绕过 CSP、并通过 Micro-Clip 截图物化排版，使 `IntersectionObserver` 哨兵得以触发。

## 环境依赖

- DeepSeek Harness (`dsh web`) ≥ `0.2.1-rc.3`，Node.js ≥ 22（插件通过原生全局 `WebSocket` 驱动 CDP，Node 20 不提供该 API）。
- **免手动安装**：插件内置**首次使用自动下载安装**能力。若检测到系统中未安装 Moli，会自动下载适配当前操作系统与 CPU 架构（Linux、macOS、Windows x86_64 / arm64）的最新版二进制并解包到 `~/.cache/moli`，开箱即用。
- 已有安装的探测顺序为：`moliPath` 配置项 → `MOLI_PATH` 环境变量 → `~/.cache/moli/moli` → `$PATH` 上的 `moli`。**不会扫描 `~/.local/bin`**；你若装在那里，请把它加入 `$PATH`，或直接设置 `moliPath`。

手动安装参考（可选）。发布包会解包到带版本号的目录（`moli-v1.1.9-x86_64-unknown-linux-gnu/`），因此必须用 `--strip-components=1` 才能把二进制落到可预期的路径：

```sh
mkdir -p ~/.local/bin
curl -sSL https://github.com/GreyRaphael/moli/releases/latest/download/moli-x86_64-unknown-linux-gnu.tar.gz \
  | tar -xz --strip-components=1 -C ~/.local/bin
chmod +x ~/.local/bin/moli
```

这样二进制位于 `~/.local/bin/moli`，而该目录**不是**本插件的默认查找位置——请把它加入 `PATH`（多数发行版已默认包含 `~/.local/bin`），或用 `moliPath` 指向它。Windows 上对应资产是 `.zip`，包内成员同样位于带版本号的目录下，解压后用 `moliPath` 指向解出的 `moli.exe`。

## 安装插件

```sh
# 直接通过 GitHub 仓库安装（当前唯一可用方式）
dsh plugin --profile web add github:GreyRaphael/dsh-web-fetch-moli

# 待本包发布到 npm 后，可直接使用包名：
# dsh plugin --profile web add dsh-web-fetch-moli
```

> **npm 状态**：`dsh-web-fetch-moli` **尚未发布到 npm registry**
>（`https://registry.npmjs.org/dsh-web-fetch-moli` 在 0.8.0 时返回 404），因此上面的裸包名方式现在会失败。
> 请先用 `github:` 方式；npm 发布流程见 `CONTRIBUTING.md`。

添加后重启 `dsh web` 即可生效。

## 设置与配置

插件的每个配置项都是本行 Config 里的 **volatile 字段**：DSH 的设置域（0.1.7 起）直接按 profile 条目渲染表单，保存即热更新——不重启、也不重挂插件。在 DSH 的「插件」页面打开 *dsh-web-fetch-moli* 即可配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `backend` | `local` | 后端模式：`local`（受管本地 Moli 服务）或 `cdp`（远端 CDP 地址）。 |
| `moliPath` | （自动） | `moli` 可执行文件路径；留空则依次探测 `MOLI_PATH` → `~/.cache/moli` → `$PATH`。 |
| `cdpEndpoint` | `127.0.0.1:9222` | 远端 CDP 地址（`host:port` 或完整 URL，在 `cdp` 模式生效）。 |
| `shareBrowserContext` | `true` | 是否复用浏览器上下文（在 `cdp` 模式生效）；本地模式下始终使用隔离上下文防止污染。 |
| `bypassCsp` | `true` | 是否通过 CDP 开启 `Page.setBypassCSP`，微前端沙箱动态加载脚本必备。 |
| `ignoreCertificateErrors` | `false` | 是否通过 CDP `Security.setIgnoreCertificateErrors` 忽略 TLS 证书错误。默认关闭：开启即等于放弃传输层认证，中间人或被劫持的 CDN 可以改写页面内容，而这些内容正是本插件喂给模型的东西。仅在访问使用自签名或 MITM 代理证书的内网主机时开启。 |
| `autoScrollSentinel` | `true` | 是否自动触发 `IntersectionObserver` 哨兵，加载瀑布流无限滚动卡片。 |
| `denoise` | `true` | 启用 LinkeDOM + Readability + mdream 降噪与 LLM 优化 Markdown 转换。 |
| `timeoutMs` | `90000` | 单次抓取的总超时预算（毫秒）；重型微前端页面需要多轮排版与滚动。bundle 层出厂 60000，schema 默认 90000。 |
| `maxConcurrency` | （自动） | 最大并发抓取数（自动：本地 20，远端 50）。 |
| `challengeWaitMs` | `5000` | Cloudflare 人机验证有界等待上限（毫秒；0 为关闭）。 |
| `challengeRetries` | `0` | 验证超时后的同页面重试次数。 |

## 开源协议

MIT
