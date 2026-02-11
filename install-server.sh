#!/usr/bin/env bash
set -euo pipefail

# Seedvault Server installer (macOS)
# Usage: curl -fsSL https://seedvault.ai/install-server.sh | bash
#    or: curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- [options]

INSTALLER_VERSION="0.1.0"
PACKAGE_NAME="@seedvault/server"
BUN_INSTALL_URL="https://bun.sh/install"
DATA_DIR="$HOME/.seedvault/data"
LOG_DIR="$HOME/.seedvault"
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
SERVER_PLIST="$HOME/Library/LaunchAgents/ai.seedvault.server.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/ai.seedvault.tunnel.plist"

DEFAULT_PORT=3000

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
TUNNEL_MODE=""        # quick, token, none, or "" (interactive)
TUNNEL_TOKEN=""
PORT="$DEFAULT_PORT"
UPDATE_ONLY=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --tunnel=quick)    TUNNEL_MODE="quick" ;;
    --tunnel=token)    TUNNEL_MODE="token" ;;
    --no-tunnel)       TUNNEL_MODE="none" ;;
    --tunnel-token=*)  TUNNEL_TOKEN="${arg#*=}"; TUNNEL_MODE="token" ;;
    --port=*)          PORT="${arg#*=}" ;;
    --update)          UPDATE_ONLY=true ;;
    --verbose)         VERBOSE=true ;;
    --help|-h)
      cat <<'USAGE'
Seedvault Server installer (macOS)

Usage:
  curl -fsSL https://seedvault.ai/install-server.sh | bash
  curl -fsSL https://seedvault.ai/install-server.sh | bash -s -- [options]

Options:
  --tunnel=quick       Use Cloudflare quick tunnel (URL changes on restart)
  --tunnel=token       Use Cloudflare tunnel token (stable URL)
  --tunnel-token=TOK   Pass tunnel token non-interactively
  --no-tunnel          Skip tunnel, local only
  --port=PORT          Server port (default: 3000)
  --update             Update server + restart, skip tunnel config
  --verbose            Print extra debug output
  --help, -h           Show this help
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
    *)
      ui_error "This installer only supports macOS. Detected: $uname_s"
      ui_error "For Linux/Docker deployment, see: https://seedvault.ai/docs/deploy"
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
  if ! command_exists bun; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}

check_port() {
  if lsof -i :"$PORT" &>/dev/null; then
    ui_warn "  Port $PORT is currently in use."
    ui_warn "  The server may fail to start. Use --port=<PORT> for a different port."
  fi
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
banner() {
  printf "\n"
  printf "${BOLD}${CYAN}"
  cat <<EOF
  ╔═══════════════════════════╗
  ║   Seedvault Server        ║
  ║   Installer v${INSTALLER_VERSION}       ║
  ╚═══════════════════════════╝
EOF
  printf "${RESET}\n"
}

# ---------------------------------------------------------------------------
# Stage 1: Install Bun
# ---------------------------------------------------------------------------
install_bun() {
  ui_stage "[1/4] Installing Bun runtime"

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
# Stage 2: Install Seedvault server
# ---------------------------------------------------------------------------
install_server() {
  ui_stage "[2/4] Installing Seedvault server"

  if $UPDATE_ONLY; then
    ui_info "  Running: bun install -g ${PACKAGE_NAME}@latest"
    bun install -g "${PACKAGE_NAME}@latest"
  else
    ui_info "  Running: bun install -g $PACKAGE_NAME"
    bun install -g "$PACKAGE_NAME"
  fi

  ensure_bun_on_path

  if command_exists seedvault-server; then
    ui_success "  seedvault-server installed"
  else
    ui_warn "  seedvault-server was installed but isn't on your PATH."
    ui_warn "  Add this to your shell profile:"
    ui_warn ""
    ui_warn "    export PATH=\"\$HOME/.bun/bin:\$PATH\""
    ui_warn ""
  fi

  mkdir -p "$DATA_DIR"
  mkdir -p "$LOG_DIR"
  ui_debug "Data directory: $DATA_DIR"
}

# ---------------------------------------------------------------------------
# Stage 3: Cloudflare Tunnel (optional)
# ---------------------------------------------------------------------------
install_cloudflared() {
  if command_exists cloudflared; then
    ui_success "  cloudflared is already installed"
    return
  fi

  ui_info "  Installing cloudflared..."

  if command_exists brew; then
    brew install cloudflared
  else
    ui_info "  Homebrew not found, downloading cloudflared directly..."
    local arch
    arch="$(uname -m)"
    local url
    if [[ "$arch" == "arm64" ]]; then
      url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
    else
      url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
    fi
    local tmpdir
    tmpdir="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmpdir/cloudflared.tgz"
    tar -xzf "$tmpdir/cloudflared.tgz" -C "$tmpdir"
    mkdir -p "$HOME/.local/bin"
    mv "$tmpdir/cloudflared" "$HOME/.local/bin/cloudflared"
    chmod +x "$HOME/.local/bin/cloudflared"
    export PATH="$HOME/.local/bin:$PATH"
    rm -rf "$tmpdir"
  fi

  if command_exists cloudflared; then
    ui_success "  cloudflared installed"
  else
    ui_error "  Failed to install cloudflared."
    ui_error "  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    return 1
  fi
}

setup_tunnel_token() {
  if [[ -z "$TUNNEL_TOKEN" ]]; then
    if [[ -t 0 ]]; then
      printf "  Enter your Cloudflare Tunnel token: "
      read -r TUNNEL_TOKEN </dev/tty
    else
      ui_error "  --tunnel-token=<TOKEN> is required in non-interactive mode."
      exit 1
    fi
  fi

  if [[ -z "$TUNNEL_TOKEN" ]]; then
    ui_error "  No token provided. Skipping tunnel setup."
    return
  fi

  install_cloudflared || return

  ui_info "  Installing cloudflared system service..."
  sudo cloudflared service install "$TUNNEL_TOKEN"
  ui_success "  Cloudflare tunnel service installed (system-level)"
  ui_info "  Manage via: sudo cloudflared service uninstall"
}

setup_tunnel_quick() {
  install_cloudflared || return

  local cloudflared_path
  cloudflared_path="$(command -v cloudflared)"

  # Unload existing tunnel agent if present
  if [[ -f "$TUNNEL_PLIST" ]]; then
    launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  fi

  cat > "$TUNNEL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.seedvault.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cloudflared_path}</string>
    <string>tunnel</string>
    <string>--url</string>
    <string>http://localhost:${PORT}</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${TUNNEL_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${TUNNEL_LOG}</string>
</dict>
</plist>
PLIST

  launchctl load "$TUNNEL_PLIST"
  ui_success "  Quick tunnel started (ai.seedvault.tunnel)"
  ui_warn "  Note: The URL changes each time the tunnel restarts."
  ui_info "  Find your URL with:"
  printf "    ${BOLD}grep trycloudflare.com ~/.seedvault/tunnel.log | tail -1${RESET}\n"
}

configure_tunnel() {
  ui_stage "[3/4] Cloudflare Tunnel"

  if $UPDATE_ONLY; then
    ui_info "  Skipping tunnel config (--update mode)"
    return
  fi

  if [[ "$TUNNEL_MODE" == "none" ]]; then
    ui_info "  Skipping tunnel (local only)"
    return
  fi

  if [[ "$TUNNEL_MODE" == "token" ]]; then
    setup_tunnel_token
    return
  fi

  if [[ "$TUNNEL_MODE" == "quick" ]]; then
    setup_tunnel_quick
    return
  fi

  # Interactive prompt
  if [[ -t 0 ]]; then
    echo ""
    printf "  How should Seedvault be accessible?\n"
    echo ""
    printf "  1) Tunnel token  — stable URL, requires Cloudflare dashboard setup\n"
    printf "  2) Quick tunnel  — instant, but URL changes on restart\n"
    printf "  3) Local only    — no internet exposure\n"
    echo ""
    printf "  Choice [1/2/3]: "
    local choice
    read -r choice </dev/tty

    case "$choice" in
      1) setup_tunnel_token ;;
      2) setup_tunnel_quick ;;
      3) ui_info "  Local only — server at http://localhost:$PORT" ;;
      *)
        ui_warn "  Invalid choice. Defaulting to local only."
        ;;
    esac
  else
    ui_info "  Non-interactive mode, skipping tunnel."
    ui_info "  Use --tunnel=quick or --tunnel=token for tunnel setup."
  fi
}

# ---------------------------------------------------------------------------
# Stage 4: Start server
# ---------------------------------------------------------------------------
start_server() {
  ui_stage "[4/4] Starting server"

  check_port

  local bun_path
  bun_path="$(command -v bun)"
  local server_path
  server_path="$(command -v seedvault-server)"

  if [[ -z "$server_path" ]]; then
    # Try common bun global bin location
    server_path="$HOME/.bun/bin/seedvault-server"
    if [[ ! -f "$server_path" ]]; then
      ui_error "  Cannot find seedvault-server binary."
      exit 1
    fi
  fi

  # Resolve to absolute paths
  bun_path="$(cd "$(dirname "$bun_path")" && pwd)/$(basename "$bun_path")"
  server_path="$(cd "$(dirname "$server_path")" && pwd)/$(basename "$server_path")"

  ui_debug "Bun path: $bun_path"
  ui_debug "Server path: $server_path"

  # Unload existing server agent if present (idempotent)
  if [[ -f "$SERVER_PLIST" ]]; then
    launchctl unload "$SERVER_PLIST" 2>/dev/null || true
  fi

  mkdir -p "$(dirname "$SERVER_PLIST")"

  cat > "$SERVER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.seedvault.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun_path}</string>
    <string>${server_path}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key>
    <string>${DATA_DIR}</string>
    <key>PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${SERVER_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${SERVER_LOG}</string>
</dict>
</plist>
PLIST

  launchctl load "$SERVER_PLIST"
  ui_success "  Server started (ai.seedvault.server)"
  ui_debug "  Log: $SERVER_LOG"
}

# ---------------------------------------------------------------------------
# Celebration
# ---------------------------------------------------------------------------
celebration() {
  echo ""
  ui_success "Done! Seedvault server is running."
  echo ""
  printf "  ${DIM}Next steps:${RESET}\n"
  printf "    ${BOLD}curl http://localhost:${PORT}/health${RESET}  Verify it's running\n"
  printf "    ${BOLD}sv init${RESET}                            Connect your CLI\n"
  echo ""
  printf "  ${DIM}Management:${RESET}\n"
  printf "    ${BOLD}launchctl list ai.seedvault.server${RESET}  Check status\n"
  printf "    ${BOLD}tail -f ~/.seedvault/server.log${RESET}     View logs\n"
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
  install_server
  configure_tunnel
  start_server
  celebration
}

main
