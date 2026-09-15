## Summary

<!-- What does this change do, and why? -->

## Affected area

<!-- Tick what this change touches. Be explicit so reviewers know what to check. -->

- [ ] Reviewed runtime source (`source/`)
- [ ] Editable frontend reconstruction (`frontend/`)
- [ ] Checksum-pinned packaged renderer / settings transform
- [ ] Packaging / signing / publication tooling (`scripts/`)
- [ ] Documentation

## Testing

<!-- What did you run? Include the local checks from CONTRIBUTING.md where relevant. -->

- [ ] `npm ci && npm run check`
- [ ] `npm run frontend:build`
- [ ] `npm run publication:check` (if the change affects the tracked tree)
- [ ] `npm run package && npm run verify` (macOS, if packaging changed)

## Checklist

- [ ] Does not weaken checksum, bundle identity, code-signing, or clean-export checks.
- [ ] Does not restore upstream identifiers or endpoints that were neutralized for the public release.
- [ ] Commits are focused and explain which layer the change affects.