# FAQ

## What is this project?

An unofficial, source-oriented reconstruction of the publicly shipped Grok Bot
0.18.0 macOS application. It contains readable TypeScript implementations of the
app's Electron-main, host, coordinator, local-execution, protocol, and renderer
boundaries, plus a deterministic toolchain that turns those sources back into a
working macOS application, and a set of practical experiments (inference router,
local Docker sandbox, usage tracking). See `README.md` for the full picture.

## Why a "reconstruction"? Why not just upstream source?

The distributed application did not include its original source or source maps.
The reconstruction was built from inspectable artifacts (bundles, IPC/RPC
contracts, shipped strings and assets, observable runtime behavior) and is
governed by the evidence-only rule in `PROVENANCE.md`: recovered source may only
express behavior supported by at least one inspectable artifact anchor.

## Why does the app keep the shipped renderer?

The original frontend source was not shipped. Rebuilding the entire polished UI
was out of scope, so packaged builds retain the checksum-pinned shipped renderer
and apply only a narrow, hash-recorded transform to add the Router settings UI.
The readable tree under `frontend/` is a partial reconstruction and design
workspace, not the original frontend source.

## What is the legal status?

The reconstructed source under `source/`, `frontend/`, and `scripts/` is
licensed under the Apache License, Version 2.0. That license does **not** cover:

- the preserved upstream installers in `research-archives/original/`,
- the upstream application and renderer material,
- "Grok Bot", "Cursor", "Anysphere", or any other trademarks.

See `NOTICE.md` and `PROVENANCE.md`. If you plan to redistribute or commercialize
this repository, obtain an independent rights review first — the absence of the
original payload in Git does not by itself make the reconstruction free to
redistribute.

## Can I use it?

Yes, for research, learning, and experimentation, under the Apache-2.0 license
for the reconstructed code. It is not an official Grok Bot release and is not
guaranteed to stay compatible with future upstream versions.

## Do I need real provider accounts?

The router routes to Cursor, Claude Code, Codex, OpenRouter, and VCoder. Claude
Code, Codex, and VCoder routes reuse your existing local logins; OpenRouter
needs an API key saved through the app's secrets bridge. For the Cursor route,
the public build neutralized upstream endpoints — you supply your own
configuration via environment variables (`SAND_BACKEND_URL`,
`SAND_AUTH_CLIENT_ID`, `SAND_CURSOR_WEBSITE_URL`, `SAND_SENTRY_DSN`).

## Why does the app not phone home?

Runtime connection defaults that pointed at upstream infrastructure were
neutralized for the public release: telemetry, the updater, experiment flagging,
and client identifiers default to disabled or `*.example.com` placeholders
unless you configure your own endpoints.

## How do I report a bug or request a feature?

Open a GitHub issue using the templates. For security vulnerabilities, use
GitHub's private security advisories (see `SECURITY.md`) instead of a public
issue.

## How do I contribute?

Read `CONTRIBUTING.md` first, then open a pull request. Run the required checks
locally and keep the publication boundaries in mind (no restoring neutralized
upstream identifiers, no weakening checksum/signing checks).

## How are releases versioned and cut?

`0.18.0-reconstructed.X` — see `RELEASING.md` and `GOVERNANCE.md`.

## What happened to the "clean history" publication?

`docs/PUBLISHING.md` documents the procedure used to export the repository as a
fresh Git history without recovery material, and `npm run publication:check`
verifies the export is lossless. This exists so the public history does not
carry the internal recovery workspace.