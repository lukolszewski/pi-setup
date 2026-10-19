#!/usr/bin/env bash
# pi-setup/install.sh — provision a pi coding agent with the configuration in this repo.
#
# Safe by construction:
#   * writes only inside the pi config dir (PI_CODING_AGENT_DIR, default ~/.pi/agent)
#   * never creates, overwrites or reads ~/.pi/agent/models.json or auth.json (providers are per-machine)
#   * never deletes anything; a conflicting file is kept and the repo copy lands beside it as *.from-repo
#   * --dry-run prints every planned action and writes nothing
set -euo pipefail

PI_VERSION="0.84.4"
NODE_MIN="22.19"

# Keep in sync with payload/.pi/agent/settings.json -> "packages".
PKGS=(
  "npm:@ayulab/pi-rewind@0.4.6"
  "git:github.com/lukolszewski/pi-stall-recovery@38112576e9595dc7e7ae9c0e93b605078771f966"
  "npm:pi-schedule-prompt@0.4.1"
  "npm:pi-web-access@0.42.0"
)

DRY=0 FORCE=0 CHECK_ONLY=0 WITH_TRUST=0
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$REPO_ROOT/payload/.pi/agent"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

log()  { printf '%s\n' "$*"; }
run()  { if (( DRY )); then printf 'DRY: %s\n' "$*"; else "$@"; fi; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while (( $# )); do
  case "$1" in
    --dry-run)      DRY=1 ;;
    --force)        FORCE=1 ;;
    --check)        CHECK_ONLY=1 ;;
    --with-trust)   WITH_TRUST=1 ;;
    --pi-version)   PI_VERSION="${2:?--pi-version needs a value}"; shift ;;
    --pi-dir)       PI_DIR="${2:?--pi-dir needs a value}"; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      printf '\nusage: install.sh [--dry-run] [--force] [--check] [--with-trust] [--pi-version V] [--pi-dir DIR]\n'
      exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

version_ge() { # version_ge A B -> true when A >= B (dotted numeric)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

preflight() {
  command -v node >/dev/null || die "node not found; install Node.js >= $NODE_MIN (this setup uses nvm)"
  command -v npm  >/dev/null || die "npm not found"
  command -v git  >/dev/null || die "git not found"

  local nv; nv="$(node --version | sed 's/^v//')"
  version_ge "$nv" "$NODE_MIN" || die "node $nv is too old; need >= $NODE_MIN"
  log "node  $nv"
  log "npm   $(npm --version)"
  log "git   $(git --version | cut -d' ' -f3)"
  log "config dir: $PI_DIR"
}

install_pi() {
  if command -v pi >/dev/null && [ "$(pi --version 2>/dev/null || echo none)" = "$PI_VERSION" ]; then
    log "pi    $PI_VERSION already installed"
    return
  fi
  log "installing pi $PI_VERSION globally"
  run npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
}

# copy_one SRC DEST
copy_one() {
  local src="$1" dest="$2" rel
  rel="${dest#"$PI_DIR"/}"
  if [ ! -e "$dest" ]; then
    run install -D -m 644 "$src" "$dest"
    return
  fi
  if cmp -s "$src" "$dest"; then
    log "  ok       $rel (identical)"
    return
  fi
  if (( FORCE )); then
    run cp -p "$dest" "$dest.bak-$(date +%Y%m%d-%H%M%S)"
    run install -D -m 644 "$src" "$dest"
    log "  replaced $rel (previous file kept as *.bak-*)"
  else
    run install -D -m 644 "$src" "$dest.from-repo"
    log "  KEPT     $rel -> repo copy written to ${rel}.from-repo (use --force to replace)"
  fi
}

copy_payload() {
  log "copying payload"
  local src rel dest
  while IFS= read -r src; do
    rel="${src#$PAYLOAD/}"
    case "$rel" in
      trust.json)
        if (( ! WITH_TRUST )); then log "  skipped    trust.json (per-machine trust; use --with-trust)"; continue; fi ;;
    esac
    copy_one "$src" "$PI_DIR/$rel"
  done < <(find "$PAYLOAD" -type f | sort)
}

install_packages() {
  log "installing packages (idempotent)"
  local p
  for p in "${PKGS[@]}"; do
    log "  $p"
    run pi install "$p"
  done
}

write_search_config() {
  # pi-web-access needs no config to work (zero-config Exa). Serper (google.com SERP) is opt-in via env.
  local dest="$PI_DIR/web-search.json"
  if [ -e "$dest" ]; then log "web-search.json already present, leaving it alone"; return; fi
  if [ -n "${SERPER_API_KEY:-}" ]; then
    log "SERPER_API_KEY is set -> writing web-search.json (serper first, exa fallback)"
    if (( DRY )); then
      printf 'DRY: write %s\n' "$dest"
    else
      cat >"$dest" <<'JSON'
{
  "serperApiKey": "$SERPER_API_KEY",
  "searchRouting": {
    "providers": ["serper", "exa"],
    "fallbackOn": ["transient", "quota", "network", "invalid-response"]
  }
}
JSON
      chmod 600 "$dest"
    fi
  else
    log "SERPER_API_KEY unset -> no web-search.json; pi-web-access uses zero-config search (no Google results)"
  fi
}

verify() {
  local rc=0
  log "verification"
  if command -v pi >/dev/null; then
    local pv; pv="$(pi --version 2>/dev/null || echo FAILED)"
    log "  pi --version: $pv"
    [ "$pv" != "FAILED" ] || rc=1
  else
    log "  pi: NOT ON PATH (check npm global bin / PATH)"; rc=1
  fi
  local p name
  for p in "${PKGS[@]}"; do
    case "$p" in
      npm:*)
        name="${p#npm:}"; name="${name%@*}"
        if [ -d "$PI_DIR/npm/node_modules/$name" ]; then log "  package ok: $p"
        else log "  package MISSING: $p"; rc=1; fi ;;
      git:*)
        name="${p#git:}"; name="${name%@*}"
        if [ -d "$PI_DIR/git/$name" ]; then log "  package ok: $p"
        else log "  package MISSING: $p"; rc=1; fi ;;
    esac
  done
  local f
  for f in settings.json extensions/waiting-for.ts extensions/copilot-auto.ts extensions/approval-gate.ts themes/gruvbox.json; do
    [ -f "$PI_DIR/$f" ] && log "  file ok: $f" || { log "  file MISSING: $f"; rc=1; }
  done
  if [ ! -f "$PI_DIR/models.json" ]; then
    log "  note: no models.json -> no model providers yet. Run 'pi' then /login, or copy a models.json of your own."
  fi
  return $rc
}

main() {
  preflight
  if (( CHECK_ONLY )); then
    verify || die "check failed"
    log "check passed"
    return
  fi
  install_pi
  copy_payload
  install_packages
  write_search_config
  if (( DRY )); then
    log "dry run complete: nothing was written"
    return
  fi
  verify || die "verification failed; see above"
  log ""
  log "done. Next steps on this machine:"
  log "  1. pi                # then /login for your provider (and GitHub Copilot if you use it)"
  log "  2. /model            # pick a default; pi records it in settings.json itself"
  log "  3. optional: export SERPER_API_KEY=... for Google results, then re-run ./install.sh"
  log "  note: rg and fd are downloaded by pi itself on first grep/find use"
}

main
