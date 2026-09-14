# Contributing

Thanks for taking an interest in `dsh-web-fetch-moli`! This document covers how to work on the plugin, how to verify a change, and how a release goes out.

## Project layout

```
src/
├── index.ts           # host entry: registers provider + settings section
├── config.ts          # schemastery schema, CDP endpoint normalizer
├── provider.ts        # WebFetchProvider: navigation, deadline, semaphore, caps
├── markdown.ts        # denoise pipeline (Readability + DOMPurify + Turndown/GFM)
├── moli-resolve.ts    # local backend discovery and auto-download
├── moli-process.ts    # local managed Moli daemon lifecycle
├── cli-runner.ts      # direct one-shot CLI execution
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
- Bump the version for every user-visible change; update `CHANGELOG.md` in the same commit.

## Commit conventions

Small, focused commits that describe the change in the imperative mood (`fix: …`, `test: …`, `docs: …`). Squash before merging if a branch has accumulated fix-up commits.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Push to `main`; CI (typecheck, test, build, pack verification) must be green.
3. `pnpm publish` — `prepublishOnly` builds the shipped `lib/`; the npm package is the prebuilt distribution, so `dsh plugin add dsh-web-fetch-moli` needs no build permission.
4. Tag and release: `git tag -a v<version> -m "Release …" && git push origin v<version>`, then a GitHub Release pointing at the same commit.
5. Registry indexes (npm `latest`, marketplace topic scans) update on their own schedules; no manual step.

## License

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
