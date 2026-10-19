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
DEFAULT_MODEL=""
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
    --default-model) DEFAULT_MODEL="${2:?--default-model needs provider/model}"; shift ;;
    --pi-version)   PI_VERSION="${2:?--pi-version needs a value}"; shift ;;
    --pi-dir)       PI_DIR="${2:?--pi-dir needs a value}"; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      printf '\nusage: install.sh [--dry-run] [--force] [--check] [--with-trust] [--default-model provider/model] [--pi-version V] [--pi-dir DIR]\n'
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
    rel="${src#"$PAYLOAD"/}"
    case "$rel" in
      trust.json)
        if (( ! WITH_TRUST )); then log "  skipped    trust.json (per-machine trust; use --with-trust)"; continue; fi ;;
      settings.json)
        merge_settings "$src"; continue ;;
    esac
    copy_one "$src" "$PI_DIR/$rel"
  done < <(find "$PAYLOAD" -type f | sort)
}

# settings.json is shared with pi itself (defaults, changelog marker, project overrides), so never treat a
# difference as a conflict: only the keys this repo owns are compared and, with --force, merged in.
merge_settings() {
  local repo="$1" live="$PI_DIR/settings.json"
  if [ ! -f "$live" ]; then
    run install -D -m 644 "$repo" "$live"
    return
  fi
  REPO="$repo" LIVE="$live" FORCE="$FORCE" DRY="$DRY" node -e '
    const fs = require("fs");
    const OWNED = ["packages", "extensions", "skills", "prompts", "themes", "compaction", "retry",
                   "hideThinkingBlock", "tuiMode", "theme"];
    const repo = JSON.parse(fs.readFileSync(process.env.REPO, "utf8"));
    const live = JSON.parse(fs.readFileSync(process.env.LIVE, "utf8"));
    const ownedDrift = OWNED.filter((k) => JSON.stringify(repo[k]) !== JSON.stringify(live[k]));
    const localEdits = Object.keys(live).filter((k) => !OWNED.includes(k) && JSON.stringify(repo[k]) !== JSON.stringify(live[k]));
    if (ownedDrift.length === 0) {
      console.log("  ok       settings.json (pi-managed keys left alone"
        + (localEdits.length ? ": " + localEdits.join(", ") : "") + ")");
      process.exit(0);
    }
    if (process.env.FORCE === "1") {
      for (const k of ownedDrift) if (k in repo) live[k] = repo[k]; else delete live[k];
      if (process.env.DRY === "1") { console.log("DRY: merge " + ownedDrift.join(", ") + " into settings.json"); process.exit(0); }
      fs.writeFileSync(process.env.LIVE + ".tmp", JSON.stringify(live, null, 2) + "\n");
      fs.renameSync(process.env.LIVE + ".tmp", process.env.LIVE);
      console.log("  merged   settings.json repo keys: " + ownedDrift.join(", ") + " (others preserved)");
      process.exit(0);
    }
    if (process.env.DRY === "1") { console.log("DRY: settings.json repo keys differ: " + ownedDrift.join(", ")); process.exit(0); }
    fs.copyFileSync(process.env.REPO, process.env.LIVE + ".from-repo");
    console.log("  KEPT     settings.json (repo keys differ: " + ownedDrift.join(", ")
      + ") -> repo copy at settings.json.from-repo; --force merges those keys");
  '
}

install_packages() {
  log "installing packages (idempotent)"
  local p
  for p in "${PKGS[@]}"; do
    log "  $p"
    run pi install "$p"
  done
}

# pi defaults to provider "google" when settings.json names no default, which fails on a fresh box with a
# bare "Connection error". --default-model writes the two keys that /model itself would write.
apply_default_model() {
  if [ -z "$DEFAULT_MODEL" ]; then
    log "no --default-model given; pi keeps its built-in default until you pick one in /model"
    return
  fi
  case "$DEFAULT_MODEL" in
    */*) : ;;
    *) die "--default-model wants provider/model, got: $DEFAULT_MODEL" ;;
  esac
  local settings="$PI_DIR/settings.json"
  [ -f "$settings" ] || die "no settings.json at $settings (run without --dry-run first)"
  log "setting default model: $DEFAULT_MODEL"
  if (( DRY )); then printf 'DRY: write defaultProvider/defaultModel into %s\n' "$settings"; return; fi
  DEFAULT_MODEL="$DEFAULT_MODEL" SETTINGS="$settings" node -e '
    const fs = require("fs");
    const [prov, ...rest] = process.env.DEFAULT_MODEL.split("/");
    const path = process.env.SETTINGS;
    const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
    cfg.defaultProvider = prov;
    cfg.defaultModel = rest.join("/");
    fs.writeFileSync(path + ".tmp", JSON.stringify(cfg, null, 2) + "\n");
    fs.renameSync(path + ".tmp", path);
  '
}

# pi-web-access does NOT fall back when a provider key is rejected: web_search just fails. So probe the key
# once before writing a config that routes through it (the probe costs one of the 2,500 free credits).
serper_key_ok() {
  if (( DRY )); then printf 'DRY: probe SERPER_API_KEY against google.serper.dev\n'; return 0; fi
  SERPER_API_KEY="${SERPER_API_KEY:-}" node -e '
    fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "ping", num: 1 }),
      signal: AbortSignal.timeout(10000),
    }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(2));
  ' 2>/dev/null
}

write_search_config() {
  # pi-web-access needs no config to work (zero-config Exa). Serper (google.com SERP) is opt-in via env.
  local dest="$PI_DIR/web-search.json"
  if [ -e "$dest" ]; then log "web-search.json already present, leaving it alone"; return; fi
  if [ -z "${SERPER_API_KEY:-}" ]; then
    log "SERPER_API_KEY unset -> no web-search.json; pi-web-access uses zero-config search (no Google results)"
    return
  fi
  if ! serper_key_ok; then
    printf 'warning: serper.dev rejected SERPER_API_KEY, so web-search.json was NOT written.\n'
    printf '         Routing through a rejected key makes web_search fail outright, so zero-config\n'
    printf '         search is kept. Check the key, then re-run ./install.sh.\n'
    return
  fi
  log "SERPER_API_KEY accepted -> writing web-search.json (serper first, exa on transient errors)"
  if (( DRY )); then printf 'DRY: write %s\n' "$dest"; return; fi
  cat >"$dest" <<'JSON'
{
  "serperApiKey": "$SERPER_API_KEY",
  "searchRouting": {
    "providers": ["serper", "exa"],
    "fallbackOn": ["unsupported", "transient", "quota", "network", "invalid-response"]
  }
}
JSON
  chmod 600 "$dest"
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
  apply_default_model
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
  log "  2. /model            # pick a default, or pass --default-model provider/model next run"
  log "  3. optional: export SERPER_API_KEY=... for Google results, then re-run ./install.sh"
  log "  note: rg and fd are downloaded by pi itself on first grep/find use"
}

main
