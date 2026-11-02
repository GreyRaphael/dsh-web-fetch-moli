# Contributing

Thanks for taking an interest in `dsh-web-fetch-moli`! This document covers how to work on the plugin, how to verify a change, and how a release goes out.

## Project layout

```
src/
├── index.ts           # host entry: registers provider + settings section
├── config.ts          # schemastery schema, CDP endpoint normalizer
├── provider.ts        # WebFetchProvider: navigation, deadline, semaphore, caps
├── markdown.ts        # denoise pipeline (LinkeDOM + Readability + mdream)
├── moli-resolve.ts    # local backend discovery and auto-download
├── moli-process.ts    # local managed Moli daemon lifecycle
├── hooks.ts           # CSP bypass and IntersectionObserver sentinels
├── cdp-pool.ts        # pooled and shared CDP browser sessions
├── types.ts           # structural CDP/Moli types
└── client/            # browser half: settings card, form model, locales
tests/                 # unit + provider + browser integration + benchmarks
```

The host half is a [Cordis](https://github.com/shigma/cordis) function plugin registering into the web seam's fetch registry; the browser half is a self-contained client bundle registered with `window.__ModuleLoader__.load`.

## Development

Requirements: Node.js ≥ 22, pnpm ≥ 11.

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run; real-browser smokes self-skip when no binary is found
pnpm build       # tsc declarations + tsdown (host ESM + client module-registration bundle)
```

The test suite deliberately needs no Moli binary on CI for pure unit tests; live torture benchmarks are opt-in via `RUN_ONLINE_BENCHMARK=true`.

## Verifying a change

- `pnpm typecheck` and `pnpm test` must pass.
- Any behavior change to the fetch pipeline (navigation, denoise, caps, error taxonomy) needs a test: a unit case where pure, or a fake-browser case in `tests/provider.spec.ts` where not.
- Browser-half changes (settings card, form model, locales) need no browser, but keep the client bundle self-contained: `tsdown.config.ts` enforces that at build time — no Node builtins, no `@deepseek-ai/*` value imports.
- If you touch `cordis.patch.yml`: a patch replaces the targeted row's **whole** `config`, so every key the base bundle sets on that row must be restated or it is silently dropped. The file's header comment documents the two rows this package overrides and why each key is present.
- Bump the version for every user-visible change; update `CHANGELOG.md` in the same commit.

CI runs `pnpm typecheck`, `pnpm test`, `pnpm build`, and a pack-content verification on Linux and Windows across Node 22 and 24. The pack check asserts the tarball actually contains `lib/index.js`, `lib/client.js`, both `lib/types/**` entries, and `cordis.patch.yml`, and that `dsh.client.external` matches the `require` specifiers found in `lib/client.js`. Only the Linux runners additionally install a real Moli binary, so browser-integration specs self-skip on Windows — a green Windows job does not prove the browser path works.

## Commit conventions

Small, focused commits that describe the change in the imperative mood (`fix: …`, `test: …`, `docs: …`). Squash before merging if a branch has accumulated fix-up commits.

## Releasing

There are **two separate, deliberately manual paths**. GitHub Releases are automated from a tag; npm is not.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Update `.github/release-notes.md` so it carries a `## [<version>]` heading for the version being released. `release.yml` fails the release otherwise — that file is otherwise version-independent and every tag would reuse the same body.
3. Push to `main`; CI (typecheck, test, build, pack verification) must be green.
4. **npm (manual):** `pnpm publish` — `prepublishOnly` builds the shipped `lib/`; the npm package is the prebuilt distribution, so `dsh plugin add dsh-web-fetch-moli` needs no build permission. No workflow publishes to npm and there is no `npm publish` step in this repository, so this is a local action against your own npm credentials.
5. **GitHub Release (automated from the tag):** `git tag -a v<version> -m "Release …" && git push origin v<version>`. The `Release` workflow then verifies the tag matches `package.json`, both version anchors exist, builds, packs, and attaches the `.tgz` with `.github/release-notes.md` as the body.
6. Registry indexes (npm `latest`, marketplace topic scans) update on their own schedules; no manual step.

Because npm and GitHub Releases are independent, they can drift: a tag can ship without the npm package being published, and vice versa. The README documents the GitHub install path as the reliable one until a version is actually on npm.

## License

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
