#!/usr/bin/env bash
# pi-setup/sync.sh — refresh payload/ from a machine that already runs this setup.
#
# Allowlist only: nothing is copied unless it is listed below. models.json, auth.json, sessions/, ayu/,
# bin/, npm/, git/ are never read or copied. settings.json is never overwritten automatically - the script
# prints a filtered diff and a human decides.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DEST="$REPO_ROOT/payload/.pi/agent"

COPY_FILES=(
  keybindings.json
  APPEND_SYSTEM.md
  model-profiles.json
  stall-recovery.json
  pi-waiting-for.json
  themes/gruvbox.json
  extensions/approval-gate.ts
  extensions/copilot-auto.ts
  extensions/waiting-for.ts
)

# Keys that are per-machine and must not reach the repo copy of settings.json.
STRIP_KEYS=('lastChangelogVersion' 'defaultProvider' 'defaultModel' 'webSearchRerank' 'npmCommand' 'shellPath')

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) printf 'usage: sync.sh [--apply]\n'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

[ -d "$SRC" ] || { printf 'error: pi config dir not found: %s\n' "$SRC" >&2; exit 1; }
printf 'source: %s\n' "$SRC"

changed=0
for rel in "${COPY_FILES[@]}"; do
  src="$SRC/$rel"
  dst="$DEST/$rel"
  if [ ! -f "$src" ]; then printf 'MISSING  %-32s (not present on this machine)\n' "$rel"; changed=1; continue; fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then printf 'same     %-32s\n' "$rel"; continue; fi
  printf 'DIFFERS  %-32s\n' "$rel"
  changed=1
  if (( APPLY )); then install -D -m 644 "$src" "$dst"; fi
done

printf '\nsettings.json (live minus per-machine keys) vs repo copy:\n'
if command -v python3 >/dev/null; then
  python3 - "$SRC/settings.json" "$DEST/settings.json" <<'PY'
import json, sys
strip = {'lastChangelogVersion','defaultProvider','defaultModel','webSearchRerank','npmCommand','shellPath'}
def load(p):
    try:
        with open(p) as fh: return json.load(fh)
    except FileNotFoundError:
        return None
live, repo = load(sys.argv[1]), load(sys.argv[2])
if live is None:
    print("  live settings.json not found"); raise SystemExit
live = {k: v for k, v in live.items() if k not in strip}
if repo is None:
    print("  repo settings.json not found"); raise SystemExit
diff = []
for k in sorted(set(live) | set(repo)):
    a, b = live.get(k, "<absent>"), repo.get(k, "<absent>")
    if a != b:
        diff.append(f"  {k}\n    live: {json.dumps(a)}\n    repo: {json.dumps(b)}")
print("\n".join(diff) if diff else "  identical after stripping per-machine keys")
PY
else
  printf '  python3 not available, skipping\n'
fi

printf '\nsecret / privacy scan over the whole repo:\n'
pattern='kam\.lan|/home/luk|sk-[A-Za-z0-9]{20,}|gh[op]_[A-Za-z0-9]{20,}|BSA_[A-Za-z0-9]{10,}|"apiKey"[[:space:]]*:[[:space:]]*"[^$!"{][^"]*"'
if hits=$(grep -rnE "$pattern" "$REPO_ROOT" --exclude-dir=.git --exclude=sync.sh 2>/dev/null); then
  printf '%s\n' "$hits"
  printf 'SCAN FAILED: strip the above before committing\n'
  exit 1
else
  printf '  clean\n'
fi

if (( ! APPLY )); then
  printf '\nnothing written (dry run). Re-run with --apply to update payload/.\n'
elif (( changed )); then
  printf '\npayload/ updated. Review with: git -C %s diff\n' "$REPO_ROOT"
fi
