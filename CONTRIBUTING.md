# Contributing

Thanks for helping with this reconstruction project. Please read
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [GOVERNANCE.md](GOVERNANCE.md)
before contributing, and keep changes reviewable. Do not commit generated
application payloads or local evidence.

Before sharing a change, run:

```sh
npm ci
npm run check
npm run frontend:build
```

On macOS, after `npm run bootstrap`, package changes should also pass:

```sh
npm run package
npm run verify
```

Use focused commits. Explain whether a change affects reviewed runtime source,
the editable frontend, the checksum-pinned packaged renderer, or packaging only.
Do not weaken checksum, bundle identity, code-signing, or clean-export checks to
make a build pass.

By contributing to this repository you agree that your contributions are
licensed under the same terms as the project (the Apache License, Version 2.0 —
see `LICENSE`). This agreement does not extend to preserving or reintroducing
upstream identifiers: do not restore proprietary client IDs, endpoints, or
telemetry destinations that have been neutralized for the public release.

## What to work on

Good starting points are open issues labeled `good first issue` or `bug`. If a
change is structural or behavioral (new provider routes, packaging changes, or
anything that touches the evidence-only reconstruction rules in
`PROVENANCE.md`), open a discussion issue before writing the pull request.

## Pull request checklist

- [ ] `npm ci && npm run check` passes.
- [ ] `npm run frontend:build` passes.
- [ ] `npm run publication:check` passes (if the tracked tree changed).
- [ ] The PR template is filled in and the affected layer is explicit.
- [ ] No neutralized upstream identifiers were restored and no checks were
      weakened.