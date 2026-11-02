## What this change does

<!-- One or two sentences: the behavior or file it changes, and why. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (new behavior has a test)
- [ ] `pnpm build` succeeds and the client bundle stays self-contained
- [ ] `CHANGELOG.md` updated and `package.json` version bumped if user-visible
- [ ] The packed tarball contains `lib/index.js`, `lib/client.js`, `lib/types/**`, and `cordis.patch.yml` — CI's "Verify package contents" step enforces exactly this list (run `pnpm pack` locally to check)
- [ ] If this touches `cordis.patch.yml`: every key the base bundle sets on an overridden row is restated, because a patch replaces the row's **whole** `config` (see the file's own header comment)

## Notes for the reviewer

<!-- Anything the maintainer should look at carefully: a subtle resolution path, a cap change, an error-taxonomy decision, … -->
