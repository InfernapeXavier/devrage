# devrage (personal fork)

Measure rage, API-equivalent token costs, and AI slop in coding-agent sessions.
Forked from [gricha/devrage](https://github.com/gricha/devrage) with support for
current, server-backed Amp threads.

## Run with Amp

Install and authenticate the [Amp CLI](https://ampcode.com/docs/cli), then use
Node.js 20 or newer:

```sh
npx --ignore-scripts=false github:InfernapeXavier/devrage scan --agent amp --week
npx --ignore-scripts=false github:InfernapeXavier/devrage slop --agent amp --week
npx --ignore-scripts=false github:InfernapeXavier/devrage cost --agent amp --week
```

Use the GitHub package above, not `npx devrage`, which still installs the upstream
npm release. The GitHub install builds the CLI automatically. The command-scoped
`--ignore-scripts=false` permits that build even if your npm configuration disables
install scripts; it does not change your global configuration.

If `~/.local/share/amp/threads/` (or `$XDG_DATA_HOME/amp/threads/`) contains JSON
files, the adapter reads only those files, preserving offline/manual-export use.
Otherwise it calls `amp threads list --json --include-archived` with pagination
and `amp threads export` for each relevant thread. This requires network access
and uses your existing Amp authentication. It includes your archived threads,
not just threads for the current repository. Older Amp CLIs without these
commands need updating.

Exports are processed in memory, not saved to disk or sent to a separate service.
Cost reports still use devrage's existing pricing-cache and local HTML-report
behavior. `--week`, `--month`, or `--since YYYY-MM-DD` avoids exporting threads
last updated before that range; individual messages and usage are also filtered.
An unrestricted first scan can take a while for accounts with many threads.
CLI/export failures emit warnings; results after a warning may be incomplete.

Costs use assistant-message token usage, or the legacy `usageLedger` when
available. These are API-equivalent estimates, not your Amp bill. Models absent
from the pricing catalog remain unpriced.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run lint
```
