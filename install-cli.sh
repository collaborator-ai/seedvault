#!/usr/bin/env bash
set -euo pipefail

# Seedvault CLI installer
# Usage: curl -fsSL https://seedvault.ai/install-cli.sh | bash
#    or: curl -fsSL https://seedvault.ai/install-cli.sh | bash -s -- --no-onboard

INSTALLER_VERSION="0.2.0"
PACKAGE_NAME="@seedvault/cli"
BUN_INSTALL_URL="https://bun.sh/install"
CONFIG_DIR="$HOME/.config/seedvault"
CONFIG_FILE="$CONFIG_DIR/config.json"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
NO_ONBOARD=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --no-onboard) NO_ONBOARD=true ;;
    --verbose)    VERBOSE=true ;;
    --help|-h)
      cat <<'USAGE'
Seedvault CLI installer

Usage:
  curl -fsSL https://seedvault.ai/install-cli.sh | bash
  curl -fsSL https://seedvault.ai/install-cli.sh | bash -s -- [options]

Options:
  --no-onboard   Skip interactive onboarding (for CI / agents)
  --verbose      Print extra debug output
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
ui_debug()   { $VERBOSE && printf "${DIM}  %s${RESET}\n" "$*" || true; }

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
command_exists() { command -v "$1" &>/dev/null; }

detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) OS="macOS" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        OS="WSL"
      else
        OS="Linux"
      fi
      ;;
    *)
      ui_error "Unsupported OS: $uname_s"
      exit 1
      ;;
  esac
  ui_debug "Detected OS: $OS"
}

check_prerequisites() {
  if ! command_exists curl; then
    ui_error "curl is required but not found. Please install curl and try again."
    exit 1
  fi
  ui_debug "Prerequisites OK (curl found)"
}

ensure_bun_on_path() {
  # Bun's installer adds to rc files, but in a piped-bash context those
  # aren't sourced. Ensure ~/.bun/bin is on PATH for the rest of this script.
  if ! command_exists bun; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}

# ---------------------------------------------------------------------------
# Stage 1: Install Bun
# ---------------------------------------------------------------------------
install_bun() {
  ui_stage "[1/3] Installing Bun runtime"

  if command_exists bun; then
    ui_success "  Bun is already installed ($(bun --version))"
    return
  fi

  ui_info "  Downloading Bun..."
  curl -fsSL "$BUN_INSTALL_URL" | bash
  ensure_bun_on_path

  if ! command_exists bun; then
    ui_error "Bun installation failed — bun not found on PATH."
    ui_error "Try installing manually: https://bun.sh"
    exit 1
  fi

  ui_success "  Bun installed ($(bun --version))"
}

# ---------------------------------------------------------------------------
# Stage 2: Install sv CLI
# ---------------------------------------------------------------------------
install_sv() {
  ui_stage "[2/3] Installing Seedvault CLI"

  # Check if daemon is running before upgrade so we can restart it after
  DAEMON_WAS_RUNNING=false
  if command_exists sv; then
    if sv status 2>/dev/null | grep -qi "running"; then
      DAEMON_WAS_RUNNING=true
      ui_debug "Daemon is running — will restart after install"
    fi
  fi

  ui_info "  Running: bun install -g $PACKAGE_NAME"
  bun install -g "$PACKAGE_NAME"

  ensure_bun_on_path

  if command_exists sv; then
    local version
    version="$(sv --version 2>/dev/null || echo "unknown")"
    ui_success "  sv installed (v$version)"

    # Restart daemon if it was running before the upgrade
    if $DAEMON_WAS_RUNNING; then
      ui_info "  Restarting daemon..."
      sv start 2>/dev/null || true
      ui_success "  Daemon restarted"
    fi
  else
    ui_warn "  sv was installed but isn't on your PATH."
    ui_warn "  Add this to your shell profile:"
    ui_warn ""
    ui_warn "    export PATH=\"\$HOME/.bun/bin:\$PATH\""
    ui_warn ""
  fi
}

# ---------------------------------------------------------------------------
# Stage 3: Onboarding
# ---------------------------------------------------------------------------
run_onboarding() {
  ui_stage "[3/3] Setup"

  if $NO_ONBOARD; then
    ui_info "  Skipping onboarding (--no-onboard)"
    ui_info "  Run 'sv init' when you're ready to configure."
    return
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    ui_success "  Already configured ($CONFIG_FILE exists)"
    return
  fi

  # sv init opens /dev/tty directly for input, so this works even via curl | bash.
  ui_info "  Starting interactive setup..."
  echo ""
  sv init
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
banner() {
  printf "\n"
  printf "${BOLD}${CYAN}"
  cat <<EOF
  ╔═══════════════════════════╗
  ║     Seedvault CLI         ║
  ║     Installer v${INSTALLER_VERSION}     ║
  ╚═══════════════════════════╝
EOF
  printf "${RESET}\n"
}

# ---------------------------------------------------------------------------
# Celebration
# ---------------------------------------------------------------------------
celebration() {
  echo ""
  ui_success "Done! Seedvault CLI is ready."
  echo ""
  printf "  ${DIM}Quick start:${RESET}\n"
  printf "    ${BOLD}sv status${RESET}     Check connection\n"
  printf "    ${BOLD}sv add ~/dir${RESET}  Add a collection\n"
  printf "    ${BOLD}sv start${RESET}      Start syncing\n"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  banner
  detect_os
  check_prerequisites
  install_bun
  install_sv
  run_onboarding
  celebration
}

main
