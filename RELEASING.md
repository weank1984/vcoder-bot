# Releasing

This project uses a modified version of [Semantic Versioning](https://semver.org):
`0.18.0-reconstructed.X`. The fixed `0.18.0` prefix tracks the pinned upstream
Grok Bot 0.18.0 release; the `reconstructed.X` suffix increments for project
releases. Only the lead maintainer cuts releases.

## Version rules

- **Patch / maintenance** (`reconstructed.2`, `.3`, ...): bug fixes, docs,
  packaging fixes that do not change the pinned baseline or the router surface.
- **Minor / feature** (next full version such as `0.19.0-reconstructed.1`): new
  provider routes, behavioral changes to the router, or a baseline bump to a new
  pinned upstream release. Changing the baseline requires updating
  `PROVENANCE.md` and the preserved-archive manifest.

## Release procedure

Releases are cut from `main`. Before tagging:

1. Confirm the tree is clean and on `main`:
   ```sh
   git status
   git branch --show-current
   ```
2. Run the full local checks from a state after `npm ci`:
   ```sh
   npm ci
   npm run check
   npm run frontend:build
   npm run publication:check
   ```
   On macOS, also run the packaging path when it is affected:
   ```sh
   npm run bootstrap
   npm run package
   npm run verify
   ```
3. Confirm publication boundaries with `docs/PUBLISHING.md`:
   - `git status --ignored` shows no generated payload selected for Git.
   - `git lfs ls-files` still lists both preserved 0.18.0 installers.
   - No credentials or absolute machine paths entered the tree since the last
     scan.
4. Update `CHANGELOG.md` and `package.json` version (if it changed from the
   last release), commit, then tag:
   ```sh
   git tag 0.18.0-reconstructed.X
   git push origin main --tags
   git lfs push --all origin
   ```

## Release notes

Release descriptions must not imply that this project is an official upstream
release or that upstream trademarks are transferable. `NOTICE.md` and
`PROVENANCE.md` should be cited when downloading release assets. If a release
downloads the preserved installers, note their independent upstream terms.