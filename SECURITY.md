# Security Policy

## Security stance

This plugin takes the same position as the shipped HTTP fetch provider: it implements **no SSRF / private-network protection**. Anything the browser can reach, the provider can fetch — a rendered page, an internal service, or a link-local address. The CDP endpoint and the local browser path are configured from the settings page with no loopback restriction. Deploy it in a trusted environment and do not expose the settings page to untrusted networks.

## Data flow (what actually leaves the machine)

Fetched pages are rendered locally by a local Moli daemon (or by the remote CDP endpoint you configure). **Page content is not sent anywhere by this plugin** — it goes into the session as tool output. No credentials are accepted or stored by this plugin.

Two things do reach the network beyond the pages you fetch, and both are easy to overlook:

1. **Release checks and binary downloads against GitHub.** The local backend periodically asks GitHub for the latest Moli release and, on a cache miss or a newer release, downloads the archive. Concretely it contacts `github.com/GreyRaphael/moli/releases/latest` and `api.github.com`. This happens on a cold start, every 24h (TTL), and whenever the plugin version changes — it does not happen on every fetch. There is no dedicated "offline" or "don't phone home" setting; the only way to avoid the download is to supply a binary yourself via `moliPath` or `MOLI_PATH`, which skips the download path. Blocking that traffic at the network layer is also effective — a failed check logs an offline warning and falls back to the cached or configured binary.
2. **The target page's own subresources.** The browser fetches images, fonts, stylesheets, media, and any third-party script/iframe the page references, exactly as a normal browser would. Those requests reveal the client's IP and reach third-party origins.

## Reporting a vulnerability

If you believe you have found a security issue in this plugin, please open a private advisory on GitHub:

https://github.com/GreyRaphael/dsh-web-fetch-moli/security/advisories/new

Please include:

- the affected version;
- a minimal reproduction (URL, configuration, expected vs actual behavior);
- whether you consider it a security boundary violation or a misconfiguration footgun.

Repair policy: confirmed issues get a fix, a version bump, a `CHANGELOG.md` entry, and a GitHub Security Advisory.

## Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Internal network | Page fetch reaches private/link-local hosts | None by design (provider stance); restrict who may call `web_fetch`, run in a network-scoped environment |
| Settings page | CDP endpoint reconfiguration to an attacker-controlled browser | Trusted-environment deployment only; loopback checks deliberately not enforced |
| Fetched page | Malicious JS runs in the headless browser | Browser is headless, session/context are fresh per fetch, and `BypassServiceWorker` forces live content. **Subresources are not intercepted or blocked** — the provider observes network events to know when a page settled, but it installs no request interceptor (`Fetch.enable` / `Network.setBlockedURLs` are never sent), so image/font/media/script requests from the page go out as the page asks. Page output passes Readability + mdream before conversion, which reduces (does not eliminate) prompt-injection surface |
| Fetched page (transport) | A MITM or a hijacked CDN rewrites the page before it reaches the model | TLS verification is in force by default. The `ignoreCertificateErrors` setting (**default `false`**) disables it via CDP `Security.setIgnoreCertificateErrors`; when enabled, page content is **no longer transport-authenticated** and an on-path attacker can serve arbitrary text to the model. Only enable it for hosts behind a self-signed or MITM-proxied certificate that you control |
| Moli binary | The downloaded binary is executed on the host | The binary is fetched over HTTPS from GitHub Releases, verified against the **per-asset `digest` published by the GitHub Releases API**, and only then extracted, `chmod 0755`'d and spawned. A published digest that does not match aborts the install before extraction. When the release metadata is unreachable or carries no digest (older releases, rate limit, offline first run) the install still proceeds, but logs one explicit `integrity NOT verified` warning rather than passing silently, so the gap is observable. Signing is not verified. Measured on 2026-10-26: all 8 assets of the current release publish a `sha256:` digest, and the downloaded archive matched it exactly |
| Workspace data | Rendered page content stored in sessions | Same as any `web_fetch` output — treat fetched content as untrusted data |

## Supported versions

The latest published release is the only supported version. Users on older releases should upgrade to the newest `dsh-web-fetch-moli`.
