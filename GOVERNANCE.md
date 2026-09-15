# Governance

This document describes how the `vcoder-bot` repository is maintained. It is a
living document; substantive changes should be proposed in a pull request.

## Project status

This is an unofficial, independent research reconstruction of a publicly shipped
application. It is not maintained by, affiliated with, or endorsed by Anysphere,
Cursor, xAI, or any other upstream party. Public redistribution must respect the
boundaries documented in `NOTICE.md` and `PROVENANCE.md`.

## Maintainers

The repository owner is the lead maintainer. The lead maintainer has final
decision authority on release and moderation matters, including:

- accepting or rejecting contributions that risk the project's publication
  boundaries (restoring upstream identifiers, weakening checksum/signing
  checks, or redistributing upstream material beyond what the repository
  already ships);
- managing releases and version tags;
- enforcing the [Code of Conduct](CODE_OF_CONDUCT.md).

Current lead maintainer: `weank1984` (reachable through GitHub, or via a GitHub
issue if preference is privacy / public record).

## How decisions are made

- **Small, focused changes** (docs, small fixes, clear regressions): reviewed
  and merged through ordinary pull requests.
- **Structural or behavioral changes** (new provider routes, packaging changes,
  changes to the evidence-only reconstruction rules): open a discussion issue
  first, then a pull request. Consensus among regular contributors is sought;
  the lead maintainer decides when consensus is not reached.
- **Release decisions**: only the lead maintainer cuts releases; see
  [`RELEASING.md`](RELEASING.md).

## Contributions

- Contributions are welcome and handled through GitHub pull requests. Read
  [`CONTRIBUTING.md`](CONTRIBUTING.md) first.
- By submitting a contribution you agree to license it under the same terms as
  the project: the Apache License, Version 2.0 (inbound = outbound). See
  `LICENSE`. This does *not* extend to preserving or reintroducing neutralized
  upstream material — see the publication boundaries in `CONTRIBUTING.md`.
- Contributions that violate the [Code of Conduct](CODE_OF_CONDUCT.md) will be
  rejected or removed under its enforcement guidelines.

## Repository boundaries

The following are never acceptable in contributed content:

- restoring proprietary client IDs, endpoints, or telemetry destinations that
  were neutralized for the public release;
- weakening checksum, bundle identity, code-signing, or clean-export checks to
  make a build pass;
- adding product behavior that cannot be anchored to an inspectable artifact
  (see `PROVENANCE.md`, "Evidence-only reconstruction rule");
- committing generated payloads, recovery material, local credentials, or
  absolute machine paths.

## Moderation

Code of Conduct issues and abusive behavior are handled by the maintainer
according to the enforcement guidelines in `CODE_OF_CONDUCT.md`. Complaints may
be raised privately through the GitHub issue tracker or the contact listed
above.

## Changes to this document

Changes to governance are proposed as pull requests and take effect after the
lead maintainer approves. Historically material changes should be noted briefly
below.

### History

- 2026-09-15: Initial governance document for the public release.