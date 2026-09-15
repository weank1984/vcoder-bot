# Security notes

This is an experimental reconstruction, not a supported production distribution.
Do not reuse real credentials or sensitive accounts while experimenting with it.

## Reporting a vulnerability

Please report security issues **privately** through the repository's GitHub
security advisories rather than opening a public issue:

<https://github.com/weank1984/vcoder-bot/security/advisories/new>

Include the affected version/commit, the steps to reproduce, and the impact you
observed. Reported issues will be acknowledged and investigated as soon as
possible. Do not attempt to exploit the issue on any machine you do not own.

## Scope and known boundaries

Reconstructed packages default the official updater, Sentry, and upstream
telemetry off at the Electron-main packaging boundary. The bootstrap download
and hydrated `app.asar` are checksum-pinned.

`npm audit` still reports compatibility-bound advisories in the pinned Electron
42.1 runtime, Undici 5 / Connect 1 stack, AI SDK 4, and OpenTelemetry stack.
Patch-level fixes are applied where they do not change reconstructed runtime
contracts. The remaining major upgrades are intentionally tracked as follow-up
work rather than silently changing application behavior during publication
cleanup.