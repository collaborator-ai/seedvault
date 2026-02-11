#!/usr/bin/env bash
set -euo pipefail

# Seedvault CLI uninstaller
# Usage: curl -fsSL https://seedvault.ai/uninstall-cli.sh | bash

UNINSTALLER_VERSION="0.1.0"
PACKAGE_NAME="@seedvault/cli"
CONFIG_DIR="$HOME/.config/seedvault"
PID_FILE="$CONFIG_DIR/daemon.pid"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
KEEP_CONFIG=false

for arg in "$@"; do
  case "$arg" in
    --keep-config) KEEP_CONFIG=true ;;
    --help|-h)
      cat <<'USAGE'
Seedvault CLI uninstaller

Usage:
  curl -fsSL https://seedvault.ai/uninstall-cli.sh | bash
  curl -fsSL https://seedvault.ai/uninstall-cli.sh | bash -s -- [options]

Options:
  --keep-config  Keep config files (~/.config/seedvault/)
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
  ║     Seedvault CLI         ║
  ║   Uninstaller v${UNINSTALLER_VERSION}     ║
  ╚═══════════════════════════╝
EOF
  printf "${RESET}\n"
}

# ---------------------------------------------------------------------------
# Stop daemon
# ---------------------------------------------------------------------------
stop_daemon() {
  ui_stage "[1/3] Stopping daemon"

  # Unregister OS service if present
  local service_found=false

  # macOS: launchd
  local plist="$HOME/Library/LaunchAgents/ai.seedvault.daemon.plist"
  if [[ -f "$plist" ]]; then
    service_found=true
    ui_info "  Unloading launchd service..."
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ui_success "  launchd service removed"
  fi

  # Linux: systemd
  local unit="$HOME/.config/systemd/user/seedvault.service"
  if [[ -f "$unit" ]]; then
    service_found=true
    ui_info "  Disabling systemd service..."
    systemctl --user disable --now seedvault.service 2>/dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    ui_success "  systemd service removed"
  fi

  # Windows (Git Bash / MSYS2): Task Scheduler
  if command_exists schtasks.exe; then
    if schtasks.exe /Query /TN SeedvaultDaemon &>/dev/null; then
      service_found=true
      ui_info "  Removing scheduled task..."
      schtasks.exe /End /TN SeedvaultDaemon 2>/dev/null || true
      schtasks.exe /Delete /TN SeedvaultDaemon /F 2>/dev/null || true
      ui_success "  Scheduled task removed"
    fi
  fi

  # Fallback: kill by PID file
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      ui_info "  Stopping daemon process (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  if ! $service_found && [[ ! -f "$PID_FILE" ]]; then
    ui_info "  No daemon running"
  else
    ui_success "  Daemon stopped"
  fi
}

# ---------------------------------------------------------------------------
# Remove package
# ---------------------------------------------------------------------------
remove_package() {
  ui_stage "[2/3] Removing sv CLI"

  if command_exists bun; then
    ui_info "  Running: bun remove -g $PACKAGE_NAME"
    bun remove -g "$PACKAGE_NAME" 2>/dev/null || true
    ui_success "  Package removed"
  else
    ui_warn "  Bun not found — package may already be removed"
  fi
}

# ---------------------------------------------------------------------------
# Remove config
# ---------------------------------------------------------------------------
maybe_remove_config() {
  ui_stage "[3/3] Config files"

  if $KEEP_CONFIG; then
    ui_info "  Keeping config (--keep-config)"
    return
  fi

  if [[ ! -d "$CONFIG_DIR" ]]; then
    ui_info "  No config directory found"
    return
  fi

  # Interactive confirmation if TTY available; otherwise remove by default
  if [[ -t 0 ]]; then
    printf "  Remove ${BOLD}$CONFIG_DIR${RESET}? (y/N) "
    read -r answer
    if [[ "$answer" != [yY]* ]]; then
      ui_info "  Keeping config"
      return
    fi
  else
    ui_info "  Removing $CONFIG_DIR (pass --keep-config to preserve)"
  fi

  rm -rf "$CONFIG_DIR"
  ui_success "  Config removed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  banner
  stop_daemon
  remove_package
  maybe_remove_config

  echo ""
  ui_success "Seedvault CLI has been uninstalled."
  echo ""
  printf "  ${DIM}Note: Bun was not removed. If you no longer need it:${RESET}\n"
  printf "    ${BOLD}rm -rf ~/.bun${RESET}\n"
  echo ""
}

main
