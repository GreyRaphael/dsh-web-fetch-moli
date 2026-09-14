# dsh-web-fetch-moli

[English](./README.md) · [GitHub](https://github.com/GreyRaphael/dsh-web-fetch-moli)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 官方生态插件，为内置 `web_fetch` 工具提供基于 [Moli](https://github.com/lexmount/moli)（超轻量级 Rust 无头浏览器）的渲染后端。在仅占用 **~60MB 内存**（相比 Chromium/Playwright 的 ~1GB 降低超 90%）的前提下，完美支持企业级复杂微前端（Micro-Frontend）、动态单页应用（SPA）与静态页面，并通过 **Readability + DOMPurify** 降噪清洗后输出规范的 GitHub Flavored Markdown。

## 核心特性

- **极致低内存占用** — 单个本地 Moli 常驻守护服务仅占用 **~50–60 MB 内存**，在资源受限的边缘节点或云服务器上亦可轻松支撑高并发抓取。
- **企业级微前端与复杂 SPA 全面兼容** — 突破了传统轻量级无头浏览器（如 Lightpanda 在 iframe 沙箱崩溃、Obscura 在 style-loader 报错）的瓶颈：
  - 支持 CDP 动态绕过 CSP（`Page.setBypassCSP`），彻底解决严格内容安全策略阻止动态 `import()` 的问题。
  - 内置针对 Moli 结构优先几何（Structure-First Geometry）的 `IntersectionObserver` 哨兵自动翻转探针，完美渲染无限滚动与瀑布流卡片列表。
- **三种灵活运行模式**：
  - `local`（默认）：自动拉起受管的本地 `moli serve` CDP 守护进程，提供最完整的动态 SPA 渲染能力。
  - `cdp`：连接用户自建或远端的 Moli / Chromium CDP 服务。
  - `cli`：每次请求直接调用单次 `moli fetch` 命令行，无后台常驻进程，冷启动极速。
- **专业降噪管道** — 采用 Mozilla Readability 提取正文，DOMPurify 过滤布局噪音（广告、导航栏、侧边栏、页脚），并通过 Turndown (GFM) 转为高质量 Markdown。自动缩略长 base64 图片，防止污染模型上下文。
- **Cloudflare 挑战有界等待** — 自动识别 `cf-mitigated: challenge` 验证页，在同一页面上下文内有界等待浏览器自然完成人机验证，无需任何违规模拟行为。

## 方案对比

| 特性 / 指标 | Chromium / Playwright | Lightpanda (Zig) | Obscura (Rust) | **Moli (Rust) + DSH 插件** |
| :--- | :--- | :--- | :--- | :--- |
| **内存占用** | ~800 MB – 1.2 GB | ~40 MB | ~50 MB | **~50 – 60 MB** |
| **微前端沙箱兼容性** | ✅ 完整 | ❌ iframe 沙箱崩溃 (`contentWindow.bind`) | ❌ 动态 `style-loader` 样式报错 | **✅ 100% 完美支持（CDP + CSP 绕过）** |
| **无限滚动/懒加载卡片** | ✅ 原生像素循环 | ❌ 几何模型不全 | ❌ 几何模型不全 | **✅ 自动哨兵触发钩子 (Sentinel Hook)** |
| **无常驻免守护模式** | ❌ 启动开销巨大 | ❌ | ❌ | **✅ 单次极速 CLI (`moli fetch`)** |
| **交互协议** | 重量级 CDP | 轻量级 CDP | 自定义 / CDP | **双模驱动：CDP 守护进程 + CLI** |

## 架构原理

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = moli
        ├─ local: 自动定位 moli 二进制 → 启动并管理 `moli serve` 守护进程 → connectOverCDP
        │           └─ setupPageHooks: 开启 Page.setBypassCSP + 注入 IntersectionObserver 哨兵翻转探针
        ├─ cdp:   连接用户配置的 remoteEndpoint CDP 端口
        ├─ cli:   直接执行 `moli fetch <url> --dump html`（无常驻进程）
        ├─ page.goto → 哨兵探针循环触发 → 等待网络空闲 (networkidle) → page.content()
        ├─ 降噪管道: Readability 提取正文 → DOMPurify 清洗噪声 → Turndown 转 GFM
        └─ 输出 Markdown（关闭 denoise 时输出原始渲染 HTML）
```

## 环境依赖

- DeepSeek Harness (`dsh web`)，Node.js ≥ 20。
- 系统安装有 [Moli](https://github.com/lexmount/moli) v1.1.5+ 可执行文件（可在 `$PATH`、`~/.local/bin/moli` 中找到，或在设置中指定 `moliPath`）。

快速安装 Moli：
```sh
curl -sSL https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C ~/.local/bin
chmod +x ~/.local/bin/moli
```

## 安装插件

```sh
# 方式 1：直接通过 GitHub 仓库安装（即时可用）
dsh plugin --profile web add github:GreyRaphael/dsh-web-fetch-moli

# 方式 2：通过 npm 包名安装
dsh plugin --profile web add dsh-web-fetch-moli
```

添加后重启 `dsh web` 即可生效。

## 设置与配置

在 DSH 设置面板（设置 → 插件 → 插件配置 → *Moli 网页爬取*）中可热更新配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `backend` | `local` | 后端模式：`local`（受管本地 Moli 服务）、`cdp`（远端 CDP 地址）、`cli`（单次命令行）。 |
| `moliPath` | （自动） | `moli` 可执行文件路径；留空自动按系统 `$PATH` 探测。 |
| `cdpEndpoint` | `127.0.0.1:9222` | 远端 CDP 地址（`host:port` 或完整 URL）。 |
| `bypassCsp` | `true` | 是否通过 CDP 开启 `Page.setBypassCSP`，微前端沙箱动态加载脚本必备。 |
| `autoScrollSentinel` | `true` | 是否自动触发 `IntersectionObserver` 哨兵，加载瀑布流无限滚动卡片。 |
| `shareBrowserContext` | `true` | 是否复用浏览器上下文（保持会话与 cookie）；取消勾选则每次抓取使用独立隔离上下文。 |
| `denoise` | `true` | 启用 Readability + DOMPurify 降噪算法。 |
| `maxConcurrency` | （自动） | 最大并发抓取数（自动：本地 20，远端 50，CLI 8）。 |
| `challengeWaitMs` | `15000` | Cloudflare 人机验证有界等待上限（毫秒；0 为关闭）。 |
| `challengeRetries` | `1` | 验证超时后的同页面重试次数。 |

## 开源协议

MIT
