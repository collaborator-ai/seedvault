#!/usr/bin/env bash
set -euo pipefail

# Seedvault Server uninstaller
# Usage: curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/uninstall-server.sh | bash

UNINSTALLER_VERSION="0.1.0"
PACKAGE_NAME="@seedvault/server"
DATA_DIR="$HOME/.seedvault"
SERVER_PLIST="$HOME/Library/LaunchAgents/ai.seedvault.server.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/ai.seedvault.tunnel.plist"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
REMOVE_DATA=false

for arg in "$@"; do
  case "$arg" in
    --remove-data) REMOVE_DATA=true ;;
    --help|-h)
      cat <<'USAGE'
Seedvault Server uninstaller

Usage:
  curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/uninstall-server.sh | bash
  curl -fsSL https://raw.githubusercontent.com/collaborator-ai/seedvault/main/uninstall-server.sh | bash -s -- [options]

Options:
  --remove-data  Remove data directory (~/.seedvault/)
  --help, -h     Show this help
USAGE
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Colors & UI (gated on TTY)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  RED="\033[31m"
  CYAN="\033[36m"
  RESET="\033[0m"
else
  BOLD="" DIM="" GREEN="" YELLOW="" RED="" CYAN="" RESET=""
fi

ui_info()    { printf "${CYAN}%s${RESET}\n" "$*"; }
ui_success() { printf "${GREEN}%s${RESET}\n" "$*"; }
ui_warn()    { printf "${YELLOW}%s${RESET}\n" "$*"; }
ui_error()   { printf "${RED}%s${RESET}\n" "$*" >&2; }
ui_stage()   { printf "\n${BOLD}${CYAN}%s${RESET}\n" "$*"; }

command_exists() { command -v "$1" &>/dev/null; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
banner() {
  printf "\n"
  printf "${BOLD}${CYAN}"
  cat <<EOF
  ╔═══════════════════════════╗
  ║   Seedvault Server        ║
  ║   Uninstaller v${UNINSTALLER_VERSION}     ║
  ╚═══════════════════════════╝
EOF
  printf "${RESET}\n"
}

# ---------------------------------------------------------------------------
# [1/4] Stop server
# ---------------------------------------------------------------------------
stop_server() {
  ui_stage "[1/4] Stopping server"

  if [[ -f "$SERVER_PLIST" ]]; then
    ui_info "  Unloading launchd service..."
    launchctl unload "$SERVER_PLIST" 2>/dev/null || true
    rm -f "$SERVER_PLIST"
    ui_success "  Server service removed (ai.seedvault.server)"
  else
    ui_info "  No server service found"
  fi
}

# ---------------------------------------------------------------------------
# [2/4] Stop tunnel
# ---------------------------------------------------------------------------
stop_tunnel() {
  ui_stage "[2/4] Stopping tunnel"

  local found=false

  # Quick tunnel (user-level LaunchAgent)
  if [[ -f "$TUNNEL_PLIST" ]]; then
    found=true
    ui_info "  Unloading quick tunnel service..."
    launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
    rm -f "$TUNNEL_PLIST"
    ui_success "  Quick tunnel service removed (ai.seedvault.tunnel)"
  fi

  # Check for system-level cloudflared service (token tunnel)
  if [[ -f "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist" ]]; then
    found=true
    ui_warn "  System-level cloudflared service detected."
    ui_warn "  To remove it, run:"
    printf "    ${BOLD}sudo cloudflared service uninstall${RESET}\n"
  fi

  if ! $found; then
    ui_info "  No tunnel services found"
  fi
}

# ---------------------------------------------------------------------------
# [3/4] Remove package
# ---------------------------------------------------------------------------
remove_package() {
  ui_stage "[3/4] Removing Seedvault server"

  if command_exists bun; then
    ui_info "  Running: bun remove -g $PACKAGE_NAME"
    bun remove -g "$PACKAGE_NAME" 2>/dev/null || true
    ui_success "  Package removed"
  else
    ui_warn "  Bun not found — package may already be removed"
  fi
}

# ---------------------------------------------------------------------------
# [4/4] Data directory
# ---------------------------------------------------------------------------
maybe_remove_data() {
  ui_stage "[4/4] Data directory"

  if [[ ! -d "$DATA_DIR" ]]; then
    ui_info "  No data directory found"
    return
  fi

  if $REMOVE_DATA; then
    ui_info "  Removing $DATA_DIR..."
    rm -rf "$DATA_DIR"
    ui_success "  Data directory removed"
    return
  fi

  # Interactive prompt if TTY available
  if [[ -t 0 ]]; then
    printf "  Remove ${BOLD}$DATA_DIR${RESET}? This deletes all server data. (y/N) "
    local answer
    read -r answer
    if [[ "$answer" == [yY]* ]]; then
      rm -rf "$DATA_DIR"
      ui_success "  Data directory removed"
    else
      ui_info "  Keeping data directory"
    fi
  else
    # Non-interactive: keep data by default (data loss is irreversible)
    ui_info "  Keeping $DATA_DIR (pass --remove-data to delete)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  banner
  stop_server
  stop_tunnel
  remove_package
  maybe_remove_data

  echo ""
  ui_success "Seedvault server has been uninstalled."
  echo ""
  printf "  ${DIM}Note: Bun and cloudflared were not removed.${RESET}\n"
  printf "  ${DIM}To remove them:${RESET}\n"
  printf "    ${BOLD}rm -rf ~/.bun${RESET}                      Remove Bun\n"
  printf "    ${BOLD}brew uninstall cloudflared${RESET}          Remove cloudflared\n"
  echo ""
}

main
