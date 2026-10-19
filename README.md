# pi-setup

Reproducible [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) setup: one command
installs a pinned pi plus the extensions and configuration this setup depends on.

```bash
git clone git@github.com:lukolszewski/pi-setup.git && cd pi-setup
./install.sh --dry-run   # see every planned action, write nothing
./install.sh
```

Then start `pi`, run `/login` for your model provider and `/model` to pick a default.

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
search through Serper with Exa as fallback:

```bash
export SERPER_API_KEY=...   # 2,500 free credits on signup, then roughly $1 per 1k queries
./install.sh
```

An existing `web-search.json` is never overwritten. Note the tool is `fetch_content`, not `web_read`.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | print every action, write nothing |
| `--check` | only verify an existing install |
| `--force` | replace files that differ (previous copy saved as `*.bak-*`) |
| `--with-trust` | also install `trust.json` (project trust paths, normally per-machine) |
| `--pi-version V` | pin a different pi version |
| `--pi-dir DIR` | install into a different config dir (`PI_CODING_AGENT_DIR` also works) |

Without `--force`, a file that already exists and differs is kept and the repo copy is written beside it as
`<name>.from-repo`. Nothing is ever deleted. `models.json` and `auth.json` are never written.

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
