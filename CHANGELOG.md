# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
a modified version of [Semantic Versioning](https://semver.org): patch-minor
features are tracked as `0.18.0-reconstructed.X`, since the underlying product
baseline is the pinned Grok Bot 0.18.0 release.

## [0.18.0-reconstructed.1] - 2026-09-15

### Added

- Source-oriented reconstruction of the Grok Bot 0.18.0 macOS application:
  Electron-main, host, coordinator, local-execution, protocol, and renderer
  boundaries.
- Inference router for Cursor, Claude Code, Codex, OpenRouter, and VCoder
  provider routes.
- Routed Grok Bot plugin/MCP tools and local usage tracking for routed
  inference.
- Optional local Docker sandbox that runs turns natively inside a local
  container.
- Reconstructed Router settings surface integrated into the shipped renderer.
- Clean-history publication tooling and checks (`docs/PUBLISHING.md`,
  `npm run publication:check`).
- Neutralized runtime defaults for the public release (telemetry, updater,
  experiment flagging, and client identifiers default to disabled or
  `*.example.com` placeholders).

### Notes

- The preserved upstream installers under `research-archives/original/0.18.0/`
  are research archives, not covered by this repository's license. See
  `NOTICE.md` and `PROVENANCE.md`.

[0.18.0-reconstructed.1]: https://github.com/weank1984/vcoder-bot/releases/tag/0.18.0-reconstructed.1