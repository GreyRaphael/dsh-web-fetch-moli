# dsh-web-fetch-moli

[中文](./README.zh-CN.md) · [GitHub](https://github.com/GreyRaphael/dsh-web-fetch-moli)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin providing a **Moli** backend for the `web_fetch` tool. Built on [Moli](https://github.com/lexmount/moli) (an ultra-lightweight Rust headless browser), it renders dynamic micro-frontends, single-page applications (SPAs), and static sites with **~60MB memory footprint** (>90% reduction compared to ~1GB for standard Chromium/Playwright), denoises pages via **LinkeDOM + Readability + mdream**, and returns clean, LLM-optimized GitHub Flavored Markdown.

## Key Highlights

- **Ultra-Lightweight Footprint** — Consumes only **~50–60 MB RAM** per local daemon, allowing high concurrency on resource-constrained servers without memory bloat.
- **Enterprise Micro-Frontend & Dynamic SPA Compatibility** — Bypasses Content Security Policy (`Page.setBypassCSP`), ignores certificate errors, and bypasses Service Worker caching. Drives native Moli layout tree computation via CDP Micro-Clip layout materialization (`Page.captureScreenshot` 1x1 micro-viewport) and triggers `scrollIntoViewIfNeeded` without any user-script monkey-patching, cleanly rendering complex micro-frontends (Alibaba Alfa, qiankun, single-spa) where other lightweight engines fail.
- **Three Flexible Backends**:
  - `local` *(default)*: Automatically manages a local `moli serve` daemon over CDP, providing full SPA and micro-frontend execution.
  - `cdp`: Connects to an existing remote Moli or Chromium CDP service over Chrome DevTools Protocol.
  - `cli`: Directly executes one-shot `moli fetch`, zero background daemon, ultra-fast cold start.
- **High-Performance Two-Stage Denoise Pipeline** — LinkeDOM + Mozilla Readability extracts primary content and eliminates noise (ads, nav bars, footers, forms), followed by mdream (Rust native with pure JS fallback) for high-fidelity, LLM-optimized Markdown conversion. Inline base64 images are elided to compact size placeholders.
- **Cloudflare Challenge Resilience** — Detects `cf-mitigated: challenge` interstitials and waits in the same page/context for natural clearance without artificial bot behavior.

## Performance & Architecture Comparison

| Feature / Metric | Chromium / Playwright | Lightpanda (Zig) | Obscura (Rust) | **Moli (Rust) + DSH Plugin** |
| :--- | :--- | :--- | :--- | :--- |
| **Memory Footprint** | ~800 MB – 1.2 GB | ~40 MB | ~50 MB | **~50 – 60 MB** |
| **Micro-Frontend Sandbox** | ✅ Full | ❌ Crashes on iframe sandbox (`contentWindow.bind`) | ❌ Fails on dynamic `style-loader` | **✅ 100% (CDP + CSP bypass)** |
| **Infinite Scroll / Sentinels** | ✅ Pixel layout loop | ❌ Geometry incomplete | ❌ Geometry incomplete | **✅ Native Layout Materialization (Micro-Clip CDP)** |
| **Daemonless Mode** | ❌ Heavy launch | ❌ | ❌ | **✅ One-shot CLI (`moli fetch`)** |
| **Execution Protocol** | Heavy CDP | Lightweight CDP | Custom / CDP | **Dual: CDP Daemon + CLI** |

## How it works

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = moli
        ├─ local: resolves moli binary → manages `moli serve` daemon → connectOverCDP
        │           └─ setupPageHooks: Page.setBypassCSP + ignoreCertErrors + bypassServiceWorker
        ├─ cdp:   connectOverCDP(remoteEndpoint)
        ├─ cli:   spawns `moli fetch <url> --dump html` (zero daemon)
        ├─ page.goto → Micro-Clip layout materialization + native scroll loop → settle (networkidle) → page.content()
        ├─ denoise: LinkeDOM (DOM) → Readability (article extract) → mdream (Markdown)
        └─ Markdown (or raw HTML when denoise is disabled)
```

## Requirements

- DeepSeek Harness (`dsh web`), Node.js ≥ 20.
- **Zero manual setup**: the plugin features **automatic download on first use**. If no `moli` binary is detected on your system, it automatically downloads and unpacks the latest release binary matching your OS and architecture (Linux, macOS, Windows x86_64 / arm64) into `~/.cache/moli`.
- Existing installations of [Moli](https://github.com/lexmount/moli) v1.1.5+ are automatically detected on `$PATH`, `~/.local/bin/moli`, or via the `moliPath` setting.

Manual installation (optional):
```sh
curl -sSL https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C ~/.local/bin
chmod +x ~/.local/bin/moli
```

## Installation

```sh
# Option 1: Install directly via GitHub repository
dsh plugin --profile web add github:GreyRaphael/dsh-web-fetch-moli

# Option 2: Install via npm package name
dsh plugin --profile web add dsh-web-fetch-moli
```

After adding, restart `dsh web` to load the plugin.

## Configuration

The settings card (设置 → 插件 → 插件配置 → *Moli 网页爬取*) configures `web-fetch-moli` in real time:

| Field | Default | Description |
| --- | --- | --- |
| `backend` | `local` | `local` (managed Moli CDP daemon), `cdp` (remote CDP endpoint), or `cli` (one-shot CLI). |
| `moliPath` | *(auto)* | Path to `moli` binary. Blank = auto-discover on `$PATH` and standard locations. |
| `cdpEndpoint` | `127.0.0.1:9222` | Remote CDP endpoint (`host:port` or URL). |
| `bypassCsp` | `true` | Bypasses Content Security Policy via CDP `Page.setBypassCSP`, unlocking micro-frontend dynamic script loading. |
| `autoScrollSentinel` | `true` | Programmatically triggers `IntersectionObserver` load-more sentinels for structure-first geometry. |
| `shareBrowserContext` | `true` | Preserves cookies and localStorage across fetches. Unchecked: fresh isolated context per fetch. |
| `denoise` | `true` | Runs LinkeDOM + Readability + mdream to strip ads, navbars, and footers before LLM-optimized Markdown conversion. |
| `maxConcurrency` | *(auto)* | Max concurrent rendering slots (auto: local 20, remote CDP 50, CLI 8). |
| `challengeWaitMs` | `15000` | Bounded wait (ms) for Cloudflare verification to clear naturally. |
| `challengeRetries` | `1` | Same-page retry attempts after challenge wait. |

## License

MIT
