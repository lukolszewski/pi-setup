# Manifest — what this repo ships and what it deliberately does not

Derived from an audited `~/.pi/agent` tree. "Shipped" means `install.sh` places it in your pi config dir.

## Shipped

| File | Why |
|---|---|
| `payload/.pi/agent/settings.json` | package list + editor/behaviour settings, with per-machine keys removed |
| `payload/.pi/agent/keybindings.json` | thinking-block cycle on `ctrl+shift+t` |
| `payload/.pi/agent/APPEND_SYSTEM.md` | standing instruction appended to the system prompt |
| `payload/.pi/agent/model-profiles.json` | empty per-mode model profiles (present so the file exists) |
| `payload/.pi/agent/stall-recovery.json` | `maxAttempts: 2` for the stall-recovery package |
| `payload/.pi/agent/pi-waiting-for.json` | `traceTurns` for the waiting-for extension |
| `payload/.pi/agent/themes/gruvbox.json` | custom theme |
| `payload/.pi/agent/extensions/waiting-for.ts` | single-file built bundle, upstream source lives in a private dev repo |
| `payload/.pi/agent/extensions/copilot-auto.ts` | GitHub Copilot "Auto" model selection |
| `payload/.pi/agent/extensions/approval-gate.ts` | write/edit approval gate; shipped **disabled** (`-extensions/…` in settings) |

Packages installed by `install.sh`, pinned: `@ayulab/pi-rewind@0.4.6`,
`pi-stall-recovery` at a pinned commit (GPL-3, referenced as an install source, no code copied here),
`pi-schedule-prompt@0.4.1`, `pi-web-access@0.42.0`.

## Not shipped, and why

| Item | Reason |
|---|---|
| `models.json` | model providers and their keys are per-machine; the repo must not know them |
| `auth.json` | OAuth tokens for a provider login; recreated by `/login` |
| `sessions/` | conversation history, hundreds of MB |
| `ayu/` | rewind checkpoints; can grow to hundreds of GB |
| `models-store.json` | refreshed model catalog cache |
| `pi-waiting-for-turns.jsonl`, `*.log`, `*.bak*` | runtime data and editor backups |
| `bin/rg`, `bin/fd` | pi downloads these itself on first use |
| `npm/node_modules`, `git/` clones | produced by `pi install` |
| `trust.json` | project trust paths, specific to one filesystem; opt in with `--with-trust` |
| `pi-web-search-rerank` | requires a self-hosted SearXNG + reranker + Crawl4AI; replaced by `pi-web-access`. Also cannot coexist: pi requires unique tool names and both register `web_search` |
| permission-modes configuration and its bash-confirm companion | the version in use is a local dev checkout of a fork; this repo installs no permission modes, so ask/plan/auto modes and the classifier are absent on new machines |
| a Langfuse tracing extension | telemetry plumbing specific to one observability stack |
| `lastChangelogVersion`, `defaultProvider`, `defaultModel` from settings | machine-local values; pi writes them itself |

## Licences

Repo content (scripts, theme, three extensions, docs) is MIT — see `LICENSE`. `pi-stall-recovery` is GPL-3 and is
only named as an install source. Third-party npm packages keep their own licences.
