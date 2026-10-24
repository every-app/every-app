---
title: Internal docs
description: Notes for the people building Every App. Not part of the user docs, and not polished.
---

These pages explain how Every App works inside, for the people building it. They
can lag behind the code; when a page and the code disagree, the code wins and
the page needs a fix. Since 2026-10-24 they are not served on everyapp.com (the
gateway pages were last verified against the code on 2026-07-15 and name
private repositories); read them here, and see the agent docs
(`landing-page/content/agent/`) for what is kept true by tests.

The pages live in `landing-page/content/internal/`. Add one as a markdown file
there and list it in `meta.json` next to it.

## Apps

- [First-party and third-party apps](/docs/internal/first-party-and-third-party-apps):
  read this before you put an app behind the Every App gateway, especially a
  shared app like OpenSEO.

## Gateway

- [CLI and deployment](/docs/internal/gateway/cli-deployment): how the CLI
  provisions, deploys, registers and runs everything locally.
- [File map](/docs/internal/gateway/file-map): what each production source file
  in the gateway and perimeter does.
- [Security boundary](/docs/internal/gateway/security-boundary): where trust is
  established and what apps receive.
- [End-user experience](/docs/internal/gateway/end-user-experience): what users
  see, from first visit to admin.
