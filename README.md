# dsh-web-fetch-moli

[中文](./README.zh-CN.md) · [GitHub](https://github.com/GreyRaphael/dsh-web-fetch-moli)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin providing a **Moli** backend for the `web_fetch` tool. Built on [Moli](https://github.com/GreyRaphael/moli) (an ultra-lightweight Rust headless browser), it renders dynamic micro-frontends, single-page applications (SPAs), and static sites in a memory footprint an order of magnitude below a full Chromium/Playwright stack, denoises pages via **LinkeDOM + Readability + mdream**, and returns clean, LLM-optimized GitHub Flavored Markdown.

## Key Highlights

- **Lightweight Footprint** — A local daemon costs single-digit MB at rest and tens of MB while rendering (measured below), so high concurrency stays viable on resource-constrained servers. See [Measured footprint](#measured-footprint) for the numbers and their conditions.
- **Enterprise Micro-Frontend & Dynamic SPA Compatibility** — Bypasses Content Security Policy (`Page.setBypassCSP`), bypasses Service Worker caching, and can optionally ignore TLS certificate errors (`ignoreCertificateErrors`, off by default). Drives native Moli layout tree computation via CDP Micro-Clip layout materialization (`Page.captureScreenshot` 1x1 micro-viewport) and triggers W3C standard `scrollIntoView({ block: 'nearest' })` without any user-script monkey-patching, cleanly rendering complex micro-frontends (Alibaba Alfa, qiankun, single-spa) that require full dynamic-script execution.
- **Two Flexible Backends**:
  - `local` *(default)*: Automatically manages a local `moli serve` daemon over CDP, providing full SPA and micro-frontend execution.
  - `cdp`: Connects to an existing remote Moli or Chromium CDP service over Chrome DevTools Protocol.
- **High-Performance Two-Stage Denoise Pipeline** — LinkeDOM + Mozilla Readability extracts primary content and eliminates noise (ads, nav bars, footers, forms), followed by mdream (Rust native with pure JS fallback) for high-fidelity, LLM-optimized Markdown conversion. Inline base64 images are elided to compact size placeholders.
- **Cloudflare Challenge Resilience** — Detects `cf-mitigated: challenge` interstitials and waits in the same page/context for natural clearance without artificial bot behavior.

## How it works

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = moli
        ├─ local: resolves moli binary → manages `moli serve` daemon → connectOverCDP
        │           └─ setupPageHooks: Page.setBypassCSP + optional ignoreCertErrors + bypassServiceWorker
        ├─ cdp:   connectOverCDP(remoteEndpoint)
        ├─ page.goto → Micro-Clip layout materialization + native scroll loop → settle (networkidle) → page.content()
        ├─ denoise: LinkeDOM (DOM) → Readability (article extract) → mdream (Markdown)
        └─ Markdown (or raw HTML when denoise is disabled)
```

## Measured footprint

Moli is a single Rust process (no separate browser + driver + renderer tree), so its resident set stays far below a
full Chromium stack. The plugin ships **no benchmark harness** — the numbers below are one measurement on one machine,
recorded here so the claim is reproducible rather than asserted. Treat them as an order of magnitude, not a guarantee.

Conditions: Moli `1.1.9`, Linux x86_64, one daemon started with `moli serve`, `VmHWM` (peak resident set) summed over
all `moli` processes from `/proc/<pid>/status`, 5s settle after each `Page.navigate`, single tab, no concurrency.

| State | Peak RSS (`VmHWM`) |
| --- | --- |
| Daemon started, no page loaded | 13.2 MB |
| After one light static page (`example.com`) | 55.9 MB |
| After one heavy article page (Wikipedia, long article + assets) | 99.6 MB |

Two things a single headline number would hide: the resting cost is small, but **a heavy page can push one daemon to
roughly 100 MB**, and the process does not shrink back after the page is closed (the high-water mark stays). Budget per
concurrent fetch accordingly rather than multiplying one number by your concurrency.

Comparison with other engines is deliberately qualitative here: this repository contains no measurements of Chromium,
Lightpanda, or Obscura, and this project has not run their test suites, so no per-product figures or failure claims are
made. What can be stated from this repository's own code and tests: the plugin drives Moli over CDP, bypasses CSP for
dynamic script loading, and materializes layout via Micro-Clip screenshots so `IntersectionObserver` sentinels fire.

## Requirements

- DeepSeek Harness (`dsh web`) ≥ `0.2.1-rc.3`, Node.js ≥ 22 (the plugin drives CDP over the native global `WebSocket`, which Node 20 does not provide).
- **Zero manual setup**: the plugin features **automatic download on first use**. If no `moli` binary is detected, it downloads and unpacks the latest release binary matching your OS and architecture (Linux, macOS, Windows x86_64 / arm64) into `~/.cache/moli`.
- Existing installations are detected in this order: the `moliPath` setting → the `MOLI_PATH` environment variable → `~/.cache/moli/moli` → `moli` on `$PATH`. There is **no scan of `~/.local/bin`**; if you install Moli there, either put it on `$PATH` or set `moliPath`.

Manual installation (optional). The release archive unpacks into a versioned directory
(`moli-v1.1.9-x86_64-unknown-linux-gnu/`), so `--strip-components=1` is required to land the binary at a predictable path:

```sh
mkdir -p ~/.local/bin
curl -sSL https://github.com/GreyRaphael/moli/releases/latest/download/moli-x86_64-unknown-linux-gnu.tar.gz \
  | tar -xz --strip-components=1 -C ~/.local/bin
chmod +x ~/.local/bin/moli
```

That places the binary at `~/.local/bin/moli`, which is **not** a default search location for this plugin — export it on
`PATH` (most distributions already include `~/.local/bin` there) or point the `moliPath` setting at it. On Windows the
asset is a `.zip` whose archive members sit under the same versioned directory; extract it and point `moliPath` at the
resulting `moli.exe`.

## Installation

```sh
# Install directly from the GitHub repository (this is the path that works today)
dsh plugin --profile web add github:GreyRaphael/dsh-web-fetch-moli

# Once this package is published to npm, the bare package name will work too:
# dsh plugin --profile web add dsh-web-fetch-moli
```

> **npm status:** `dsh-web-fetch-moli` is **not yet on the npm registry**
> (`https://registry.npmjs.org/dsh-web-fetch-moli` returns 404 as of 0.8.0), so the bare-name form will fail today.
> Use the `github:` form above. `CONTRIBUTING.md` states how an npm release is produced.

After adding, restart `dsh web` to load the plugin.

## Configuration

Every option is a **volatile field of this row's Config**: since DSH 0.1.7 the settings domain serves the form from the profile entry itself, so a save applies live — no restart and no plugin remount. Open *dsh-web-fetch-moli* on the DSH Plugins page to edit it:

| Field | Default | Description |
| --- | --- | --- |
| `backend` | `local` | `local` (managed Moli CDP daemon) or `cdp` (remote CDP endpoint). |
| `moliPath` | *(auto)* | Path to `moli` binary. Blank = discover via `MOLI_PATH`, `~/.cache/moli`, then `$PATH`. |
| `cdpEndpoint` | `127.0.0.1:9222` | Remote CDP endpoint (`host:port` or URL, used in `cdp` mode). |
| `shareBrowserContext` | `true` | Preserves cookies and localStorage across fetches in `cdp` mode. Unchecked (and always in `local` mode): fresh isolated context per fetch. |
| `bypassCsp` | `true` | Bypasses Content Security Policy via CDP `Page.setBypassCSP`, unlocking micro-frontend dynamic script loading. |
| `ignoreCertificateErrors` | `false` | Ignores TLS certificate errors via CDP `Security.setIgnoreCertificateErrors`. Off by default: enabling it defeats transport authentication, so a MITM or hijacked CDN can rewrite the page content this provider feeds to the model. Turn it on only for intranet hosts with self-signed or MITM-proxied certificates. |
| `autoScrollSentinel` | `true` | Programmatically triggers `IntersectionObserver` load-more sentinels for structure-first geometry. |
| `denoise` | `true` | Runs LinkeDOM + Readability + mdream to strip ads, navbars, and footers before LLM-optimized Markdown conversion. |
| `timeoutMs` | `90000` | Total deadline budget (ms) for one fetch; heavy micro-frontend pages may need several layout + scroll rounds. The bundled layer ships 60000, the schema default is 90000. |
| `maxConcurrency` | *(auto)* | Max concurrent rendering slots (auto: local 20, remote CDP 50). |
| `challengeWaitMs` | `5000` | Bounded wait (ms) for Cloudflare verification to clear naturally (`0` disables). |
| `challengeRetries` | `0` | Same-page retry attempts after challenge wait. |

## License

MIT
