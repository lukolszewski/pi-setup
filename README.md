# pi-setup

Reproducible [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) setup: one command
installs a pinned pi plus the extensions and configuration this setup depends on.

```bash
git clone https://github.com/lukolszewski/pi-setup.git && cd pi-setup
./install.sh --dry-run   # see every planned action, write nothing
./install.sh --default-model yourprovider/yourmodel
```

Model provider setup: either `/login` inside `pi`, or point `--default-model` at a provider you have configured
yourself in `~/.pi/agent/models.json` (yours, not the repo's). Without that, pi falls back to its built-in
default provider and fails with a bare "Connection error".

## What you get

| Package | Version | What it does |
|---|---|---|
| `@ayulab/pi-rewind` | 0.4.6 | checkpoint / rewind sessions |
| [`pi-stall-recovery`](https://github.com/lukolszewski/pi-stall-recovery) | pinned commit | retries a stalled agent loop |
| `pi-schedule-prompt` | 0.4.1 | schedule prompts during a session |
| [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) | 0.42.0 | `web_search`, `fetch_content`, `source_check` |

Plus three local extensions in `payload/.pi/agent/extensions/`: `waiting-for.ts` (honest working indicator),
`copilot-auto.ts` (GitHub Copilot "Auto" model selection), `approval-gate.ts` (write/edit approval, shipped
**disabled** — see below).

Model providers are deliberately **not** part of this repo. There is no `models.json` here, `install.sh` never
creates or touches one, and API keys never appear in the tree. Configure providers per machine with `/login`
(or your own `~/.pi/agent/models.json`).

## Web search

`pi-web-access` works with no key at all (zero-config Exa). For literal Google results, export a
[Serper](https://serper.dev) key and re-run the installer — it then writes `~/.pi/agent/web-search.json` routing
search through Serper with Exa for transient failures:

```bash
export SERPER_API_KEY=...   # 2,500 free credits on signup, then roughly $1 per 1k queries
./install.sh
```

The installer **probes the key against serper.dev first** (one query) and writes nothing if it is rejected:
`pi-web-access` treats a provider auth error as final rather than falling back, so writing a config that routes
through a bad key would break `web_search` outright. Verify with:

```bash
pi -p "Call web_search with query 'pi coding agent' and print the first result title"
```

Two caveats worth knowing: the page reader is called `fetch_content` (there is no `web_read` here), and
`pi-web-access` prints "Dynamic tool activation requires Pi 0.86.0 or newer" on pi 0.84.4 — harmless, the web
tools are simply always loaded; pass `--pi-version` if you want a newer pi.

## Tested

Clean `node:24-bookworm-slim` container with only this repo mounted read-only: `install.sh` installs pi 0.84.4
and all four packages including the commit-pinned git one; `pi list` resolves them; a real model turn returns;
`web_search` returns live results with no key configured; a rejected Serper key is detected and skipped instead
of breaking search; re-running is a no-op; a locally modified file is preserved with `.from-repo`; `--check`
passes.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | print every action, write nothing |
| `--check` | only verify an existing install |
| `--force` | replace files that differ (`*.bak-*` backup) and merge repo-owned `settings.json` keys |
| `--default-model provider/model` | write `defaultProvider` / `defaultModel` into `settings.json` |
| `--with-trust` | also install `trust.json` (project trust paths, normally per-machine) |
| `--pi-version V` | pin a different pi version (default 0.84.4) |
| `--pi-dir DIR` | install into a different config dir (`PI_CODING_AGENT_DIR` also works) |

Without `--force`, a file that exists and differs is kept, and the repo copy is written beside it as
`<name>.from-repo`. Nothing is ever deleted. `models.json` and `auth.json` are never written.

`settings.json` is treated differently because pi edits it too: only the keys this repo owns
(`packages`, `extensions`, `compaction`, `retry`, `theme`, …) are compared. A difference in `defaultProvider`,
`lastChangelogVersion` or anything else pi manages is reported as fine and left alone; a difference in a
repo-owned key produces `.from-repo`, and `--force` merges just those keys.

## Layout

```
payload/.pi/agent/   the files installed into your pi config dir
install.sh           the provisioner
sync.sh              refresh payload/ from a machine already running this setup
MANIFEST.md          what is shipped, what is not, and why
.githooks/           pre-commit secret scan (enable: git config core.hooksPath .githooks)
```

## Refreshing the repo

`./sync.sh` compares `payload/` against a live `~/.pi/agent`, prints a filtered `settings.json` diff and runs a
secret scan; `./sync.sh --apply` writes the payload. It copies from a fixed allowlist only, never from
`models.json`, `auth.json`, `sessions/`, or caches. Enable the hook before committing:

```bash
git config core.hooksPath .githooks
```

## Troubleshooting

* **`pi: command not found`** — npm's global bin isn't on `PATH` (`npm prefix -g`/bin), common with nvm.
* **node too old** — pi needs node >= 22.19; this setup is exercised on 24.x.
* **`pi install git:…` fails on the pinned commit** — the ref was garbage-collected upstream; install unpinned
  (`pi install git:github.com/lukolszewski/pi-stall-recovery`) and bump the pin.
* **`web_search` returns nothing** — `pi-web-access` is zero-config but rate-limited; export `SERPER_API_KEY`.
* **`rg`/`fd` missing** — nothing to do, pi downloads them into its own `bin/` on first use.
* **`approval-gate` seems inactive** — intentional: `settings.json` carries `-extensions/approval-gate.ts`.
  Change it to `+extensions/approval-gate.ts` to enable write/edit approval prompts.
