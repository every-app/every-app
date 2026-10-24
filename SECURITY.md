# Security

Every App is alpha and open source. If you find a hole, we'd rather know.

- Report it privately, not in a public issue: open a vulnerability report on
  the repository (**Security → Report a vulnerability**), so it isn't public
  before a fix is out.
- Say which promise breaks. [docs/threat-model.md](docs/threat-model.md) lists
  every promise the Gateway makes, to whom, where it is enforced and tested,
  and what is still open; its invariants have stable ids
  (`perimeter.csrf-private-fail-closed`). Name the one that breaks, the shape
  it affects (self-hosted, with or without Cloudflare Access in front), and how
  to reproduce it. A failing test is the best report.
- Expect a fast, informal reply from a very small team. There is no bounty.

Only the latest commit of `main` is supported: there are no release branches
yet, and no backwards-compatibility promise.
