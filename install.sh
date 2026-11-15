#!/bin/sh
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zxsmind/openbutler/main/install.sh | bash -s -- --daemon --web
#   curl -fsSL https://raw.githubusercontent.com/zxsmind/openbutler/main/install.sh | bash -s -- --client
#   ./install.sh (--daemon|--client) [--web] [--version <x.y.z>] [--binary <file>] [--no-modify-path]
set -eu

APP="openbutler"
REPO="${OPENBUTLER_GITHUB_REPO:-zxsmind/openbutler}"
INSTALL_DIR="${OPENBUTLER_INSTALL_DIR:-$HOME/.openbutler}"
BIN_DIR="$INSTALL_DIR/bin"

requested_version=""
binary_path=""
no_modify_path="false"
role=""
web="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      requested_version="${2:-}"
      if [ -z "$requested_version" ]; then
        echo "Error: --version needs a value (e.g. --version 0.6.1)." >&2
        exit 1
      fi
      shift 2
      ;;
    --binary)
      binary_path="${2:-}"
      if [ -z "$binary_path" ]; then
        echo "Error: --binary needs a file path." >&2
        exit 1
      fi
      shift 2
      ;;
    --daemon | --client)
      requested_role="${1#--}"
      if [ -n "$role" ] && [ "$role" != "$requested_role" ]; then
        echo "Error: --daemon and --client cannot be combined." >&2
        exit 1
      fi
      role="$requested_role"
      shift
      ;;
    --web) web="true"; shift ;;
    --no-modify-path) no_modify_path="true"; shift ;;
    --help | -h)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *)
      echo "Error: unknown flag $1 (see --help)." >&2
      exit 1
      ;;
  esac
done

if [ -z "$role" ]; then
  if [ "$web" = "true" ]; then
    echo "Error: --web needs --daemon or --client." >&2
  else
    echo "Error: choose what to install:" >&2
    echo "  --daemon        background host for a server or desktop (agent, pairing, remote API)" >&2
    echo "  --client        client-only machine (CLI connects to a paired backend)" >&2
    echo "  --web           with either role: also install the web UI overlay" >&2
  fi
  exit 1
fi
if [ "$web" = "true" ] && [ -n "$binary_path" ]; then
  echo "Error: --binary cannot be combined with --web." >&2
  exit 1
fi
# The marker records this composition; only exact equality may short-circuit.
config="$role"
if [ "$web" = "true" ]; then config="${role}+web"; fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but not installed." >&2
    exit 1
  fi
}
need curl

say() {
  printf '%s\n' "$1"
}

BAR_TTY=""
if [ -t 2 ]; then BAR_TTY=1; fi

ORANGE=""
RESET=""
if [ -n "$BAR_TTY" ] && [ -z "${NO_COLOR:-}" ]; then
  esc=$(printf '\033')
  ORANGE="${esc}[38;5;214m"
  RESET="${esc}[0m"
fi

hide_cursor() {
  if [ -n "$BAR_TTY" ]; then printf '\033[?25l' >&2; fi
}

show_cursor() {
  if [ -n "$BAR_TTY" ]; then printf '\033[?25h' >&2; fi
}

repeat_char() {
  rc_n="$1"
  rc_char="$2"
  rc_out=""
  rc_i=0
  while [ "$rc_i" -lt "$rc_n" ]; do
    rc_out="$rc_out$rc_char"
    rc_i=$(( rc_i + 1 ))
  done
  printf '%s' "$rc_out"
}

render_single() {
  rs_done="$1"
  rs_total="$2"
  rs_label="$3"
  rs_width=50
  if [ -z "$rs_total" ] || [ "$rs_total" = "0" ]; then
    printf '\r%s[%s] %-11s%s' "$ORANGE" "$(repeat_char "$rs_width" '-')" "$rs_label" "$RESET" >&2
    return
  fi
  rs_percent=$(( rs_done * 100 / rs_total ))
  if [ "$rs_percent" -gt 100 ]; then rs_percent=100; fi
  rs_filled=$(( rs_percent * rs_width / 100 ))
  rs_empty_n=$(( rs_width - rs_filled ))
  rs_bar="$(repeat_char "$rs_filled" '=')$(repeat_char "$rs_empty_n" '-')"
  printf '\r%s[%s] %3d%% %-11s%s' "$ORANGE" "$rs_bar" "$rs_percent" "$rs_label" "$RESET" >&2
}

file_kb() {
  fb_out="$(wc -c <"$1" 2>/dev/null || true)"
  set -- $fb_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo $(( $1 / 1024 )) ;;
  esac
}

dir_kb() {
  db_out="$(du -sk "$1" 2>/dev/null || true)"
  set -- $db_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

head_bytes() {
  hb_out="$(curl -fsSLI "$1" 2>/dev/null | tr -d '\r' | grep -i -o 'content-length: *[0-9]*' | grep -o '[0-9]*' | tail -n 1)"
  case "$hb_out" in
    '' | *[!0-9]* | 0) echo '' ;;
    *) echo "$hb_out" ;;
  esac
}

fetch_meta() {
  META_D_KB=""
  META_U_KB=""
  if ! curl -fsSL -o "$2" "$1.meta" 2>/dev/null; then return; fi
  md_d="$(grep '^archive_bytes=' "$2" 2>/dev/null | cut -d= -f2)"
  md_u="$(grep '^payload_du_kb=' "$2" 2>/dev/null | cut -d= -f2)"
  case "$md_d" in
    '' | *[!0-9]* | 0) return ;;
  esac
  case "$md_u" in
    '' | *[!0-9]* | 0) return ;;
  esac
  META_D_KB=$(( (md_d + 1023) / 1024 ))
  META_U_KB="$md_u"
}

download_to() {
  dl_url="$1"
  dl_output="$2"
  dl_total="$3"
  dl_base="$4"
  if [ -z "$BAR_TTY" ]; then
    curl -fL --progress-bar -o "$dl_output" "$dl_url"
    return $?
  fi
  : >"$dl_output"
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  curl -fL -s -o "$dl_output" "$dl_url" &
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_single $(( dl_base + $(file_kb "$dl_output") )) "$dl_total" Downloading
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    return "$BG_RET"
  fi
  render_single $(( dl_base + $(file_kb "$dl_output") )) "$dl_total" Downloading
}

extract_to() {
  ex_archive="$1"
  ex_dest="$2"
  ex_total="$3"
  ex_base="$4"
  case "$ex_archive" in
    *.zip) archive_ext=".zip" ;;
    *) archive_ext=".tar.gz" ;;
  esac
  if [ -z "$BAR_TTY" ]; then
    case "$ex_archive" in
      *.zip) unzip -q "$ex_archive" -d "$ex_dest" ;;
      *) tar -xzf "$ex_archive" -C "$ex_dest" ;;
    esac
    return $?
  fi
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  case "$ex_archive" in
    *.zip) unzip -q "$ex_archive" -d "$ex_dest" & ;;
    *) tar -xzf "$ex_archive" -C "$ex_dest" & ;;
  esac
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_single $(( ex_base + $(dir_kb "$ex_dest") )) "$ex_total" Extracting
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    echo "Error: extraction failed." >&2
    return 1
  fi
  render_single $(( ex_base + $(dir_kb "$ex_dest") )) "$ex_total" Extracting
}

copy_to() {
  cp_src="$1"
  cp_dest="$2"
  cp_total="$3"
  cp_base="$4"
  mkdir -p "$cp_dest"
  CP_BASE0="$(dir_kb "$cp_dest")"
  if [ -z "$BAR_TTY" ]; then
    cp -r "$cp_src/." "$cp_dest/"
    return $?
  fi
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  cp -r "$cp_src/." "$cp_dest/" &
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    cp_now="$(dir_kb "$cp_dest")"
    cp_grown=$(( cp_now - CP_BASE0 ))
    if [ "$cp_grown" -lt 0 ]; then cp_grown=0; fi
    render_single $(( cp_base + cp_grown )) "$cp_total" Installing
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    echo "Error: install copy failed." >&2
    return 1
  fi
  cp_now="$(dir_kb "$cp_dest")"
  cp_grown=$(( cp_now - CP_BASE0 ))
  if [ "$cp_grown" -lt 0 ]; then cp_grown=0; fi
  render_single $(( cp_base + cp_grown )) "$cp_total" Installing
}

installed_version() {
  if [ -x "$BIN_DIR/$APP" ]; then
    "$BIN_DIR/$APP" --version 2>/dev/null || true
  fi
}

LEAVE_ALONE="Leaving the running host alone: it was started by another installation."

# The daemon endpoint is keyed by the data directory, so `daemon status` from
# ANY install on this machine resolves the same process: an install into
# another directory used to stop the running host and then restart only its own
# tree, replacing files under a different install (2026-11-15 incident). The
# JSON verdict answers whether that host runs from THIS install directory;
# only then may this script stop it. An answer outside the JSON contract is a
# CLI older than --json, handled below with the textual probe.
read_host_status() {
  HOST_RUNNING="false"
  HOST_OURS="false"
  if [ ! -x "$BIN_DIR/$APP" ]; then
    return 1
  fi
  hr_json=""
  hr_json="$("$BIN_DIR/$APP" daemon status --json 2>/dev/null || true)"
  case "$hr_json" in
    *'"running":true'*'"ours":true'*)
      HOST_RUNNING="true"
      HOST_OURS="true"
      ;;
    *'"running":true'*)
      HOST_RUNNING="true"
      ;;
    *'"running":'*)
      return 0
      ;;
    *)
      return 2
      ;;
  esac
  return 0
}

# Every release download is verified before a running host is touched: a
# missing asset or an unreachable GitHub must fail with a message, never stop
# the host and then die inside curl.
verify_release_asset() {
  va_url="$1"
  va_name="$2"
  va_status="$(curl -fsSL -o /dev/null -w "%{http_code}" "$va_url" || true)"
  if [ "$va_status" = "404" ]; then
    echo "Error: release v${specific_version} does not carry $va_name." >&2
    echo "Available releases: https://github.com/$REPO/releases" >&2
    exit 1
  fi
  if [ "$va_status" != "200" ]; then
    echo "Error: could not reach GitHub to download $va_name (status $va_status)." >&2
    echo "Check the connection and retry once GitHub answers." >&2
    exit 1
  fi
}

# The running host holds its node binary open, so it must stop before the files
# under the install directory are replaced; restarting only after the copy is
# too late. 0 = stopped our host, 1 = nothing to stop (or a foreign host left
# alone with a message), 2 = no JSON verdict, the legacy probe takes over.
stop_running_host() {
  lh_rc=0
  read_host_status || lh_rc=$?
  if [ "$lh_rc" -eq 0 ]; then
    if [ "$HOST_RUNNING" != "true" ]; then return 1; fi
    if [ "$HOST_OURS" != "true" ]; then
      say "$LEAVE_ALONE"
      return 1
    fi
    say "Stopping the background host so its files can be replaced."
    "$BIN_DIR/$APP" daemon stop >/dev/null 2>&1 || true
    return 0
  fi
  if [ "$lh_rc" -eq 1 ]; then return 1; fi
  # A CLI too old for --json cannot name its install directory; the historical
  # one-install contract only ever covered the default directory, so no other
  # directory may stop a host this script cannot identify.
  if "$BIN_DIR/$APP" daemon status 2>/dev/null | grep -q "Background host running"; then
    if [ "$INSTALL_DIR" != "$HOME/.openbutler" ]; then
      say "$LEAVE_ALONE"
      return 1
    fi
    say "Stopping the background host so its files can be replaced."
    "$BIN_DIR/$APP" daemon stop >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

start_running_host() {
  say "Starting the background host on the new version."
  "$BIN_DIR/$APP" daemon start >/dev/null 2>&1 || say "Start it later with: openbutler daemon start"
}

if [ -n "$binary_path" ]; then
  if [ ! -f "$binary_path" ]; then
    echo "Error: binary archive not found at $binary_path" >&2
    exit 1
  fi
  specific_version="local"
else
  raw_os="$(uname -s)"
  case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) os="windows" ;;
    *) echo "Error: unsupported OS: $raw_os" >&2; exit 1 ;;
  esac
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo "Error: unsupported CPU: $arch" >&2; exit 1 ;;
  esac

  if [ "$os" = "linux" ]; then
    if [ -f /etc/alpine-release ]; then
      echo "Error: musl Linux (Alpine) builds are not published yet." >&2
      exit 1
    fi
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      echo "Error: musl Linux builds are not published yet." >&2
      exit 1
    fi
    need tar
  elif [ "$os" = "darwin" ]; then
    echo "Error: macOS builds are not published yet. Follow the releases page for updates." >&2
    exit 1
  else
    need unzip
  fi

  target="$os-$arch"
  if [ "$os" = "windows" ]; then
    archive_ext=".zip"
  else
    archive_ext=".tar.gz"
  fi

  if [ -z "$requested_version" ]; then
    specific_version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
    if [ -z "$specific_version" ]; then
      echo "Error: could not determine the latest release version." >&2
      exit 1
    fi
    filename="$APP-daemon-$specific_version-$target$archive_ext"
    filename_web="$APP-web-$specific_version.tar.gz"
    url="https://github.com/$REPO/releases/latest/download/$filename"
    url_web="https://github.com/$REPO/releases/latest/download/$filename_web"
  else
    requested_version="${requested_version#v}"
    specific_version="$requested_version"
    filename="$APP-daemon-$specific_version-$target$archive_ext"
    filename_web="$APP-web-$specific_version.tar.gz"
    url="https://github.com/$REPO/releases/download/v${specific_version}/$filename"
    url_web="https://github.com/$REPO/releases/download/v${specific_version}/$filename_web"
    status="$(curl -fsSL -o /dev/null -w "%{http_code}" "https://github.com/$REPO/releases/tag/v${specific_version}" || true)"
    if [ "$status" = "404" ]; then
      echo "Error: release v${specific_version} not found." >&2
      echo "Available releases: https://github.com/$REPO/releases" >&2
      exit 1
    fi
  fi
fi

current="$(installed_version)"
marker_config=""
if [ -f "$INSTALL_DIR/.openbutler-flavor" ]; then
  marker_config="$(cat "$INSTALL_DIR/.openbutler-flavor" 2>/dev/null || true)"
fi
if [ -n "$current" ] && [ "$current" = "$specific_version" ] && [ "$marker_config" = "$config" ]; then
  say "openbutler $current is already installed at $INSTALL_DIR."
  exit 0
fi
# An installed base at the same version with only the overlay missing fetches
# the overlay alone; the exact match above already covered the full repeat.
skip_base="false"
if [ "$web" = "true" ] && [ -n "$current" ] && [ "$current" = "$specific_version" ] && [ "$marker_config" = "$role" ]; then
  skip_base="true"
fi

# Pre-flight before the host is touched: a missing asset or an unreachable
# GitHub fails with a message while the running host is still running. Both
# version branches share this one check; skip_base skips the base fetch, not
# the overlay it is about to download.
if [ -z "$binary_path" ]; then
  if [ "$skip_base" != "true" ]; then verify_release_asset "$url" "$filename"; fi
  if [ "$web" = "true" ]; then verify_release_asset "$url_web" "$filename_web"; fi
fi

is_update=0
if [ -z "$binary_path" ] && [ -n "$current" ] && [ "$current" != "$specific_version" ]; then
  is_update=1
fi

tmp_dir="${TMPDIR:-/tmp}/openbutler_install_$$"
mkdir -p "$tmp_dir"

host_was_running=0
host_restored=0
# A failure after the host was stopped must not leave it dead: the EXIT path
# brings it back before reporting the failure. Normal completion marks the
# restart done, so the trap never starts a second copy.
trap 'rc=$?; show_cursor; rm -rf "$tmp_dir"; if [ "$rc" -ne 0 ] && [ "$host_was_running" = "1" ] && [ "$host_restored" = "0" ]; then echo "The install failed after the host was stopped; starting it again." >&2; start_running_host || true; host_restored=1; fi; exit $rc' EXIT INT TERM
if stop_running_host; then host_was_running=1; fi

DO_COPY=1
if [ -n "$binary_path" ]; then
  say "Installing openbutler from $binary_path"
  archive="$tmp_dir/$(basename "$binary_path")"
  cp "$binary_path" "$archive"
  mkdir -p "$tmp_dir/extract"
  extract_to "$archive" "$tmp_dir/extract" "" 0
  if [ -n "$BAR_TTY" ]; then printf '\n' >&2; fi
else
  if [ "$is_update" = "1" ]; then
    say "Updating openbutler $current -> $specific_version ($target)"
  else
    say "Downloading openbutler $specific_version ($target)"
  fi
  fetch_base="true"
  if [ "$skip_base" = "true" ]; then
    fetch_base="false"
    say "Base already installed at this version; fetching only the web overlay."
  fi

  mkdir -p "$tmp_dir/extract"
  archive="$tmp_dir/$filename"
  archive_web="$tmp_dir/$filename_web"

  # One bar spans both archives: every download first, then every extraction,
  # then a single copy of the merged tree. Fancy progress needs both .meta
  # files; a missing one falls back to the plain path, which downloads and
  # extracts per archive and leaves the copy to the common merge below.
  FANCY=0
  BASE_D_KB=0
  BASE_U_KB=0
  WEB_D_KB=0
  WEB_U_KB=0
  if [ -n "$BAR_TTY" ]; then
    FANCY=1
    if [ "$fetch_base" = "true" ]; then
      fetch_meta "$url" "$tmp_dir/meta-base"
      if [ -z "$META_D_KB" ] || [ -z "$META_U_KB" ]; then
        FANCY=0
      else
        BASE_D_KB="$META_D_KB"
        BASE_U_KB="$META_U_KB"
      fi
    fi
    if [ "$web" = "true" ] && [ "$FANCY" = 1 ]; then
      fetch_meta "$url_web" "$tmp_dir/meta-web"
      if [ -z "$META_D_KB" ] || [ -z "$META_U_KB" ]; then
        FANCY=0
      else
        WEB_D_KB="$META_D_KB"
        WEB_U_KB="$META_U_KB"
      fi
    fi
  fi

  if [ "$FANCY" = 1 ]; then
    BAR_TOTAL=$(( BASE_D_KB + WEB_D_KB + BASE_U_KB + WEB_U_KB + BASE_U_KB + WEB_U_KB ))
    hide_cursor
    if [ "$fetch_base" = "true" ]; then
      download_to "$url" "$archive" "$BAR_TOTAL" 0
      BASE_D="$(file_kb "$archive")"
    else
      BASE_D=0
    fi
    if [ "$web" = "true" ]; then
      download_to "$url_web" "$archive_web" "$BAR_TOTAL" "$BASE_D"
      WEB_D="$(file_kb "$archive_web")"
    else
      WEB_D=0
    fi
    EX_OFF=$(( BASE_D + WEB_D ))
    if [ "$fetch_base" = "true" ]; then
      EX_BEFORE="$(dir_kb "$tmp_dir/extract")"
      extract_to "$archive" "$tmp_dir/extract" "$BAR_TOTAL" "$EX_OFF"
      EX_AFTER="$(dir_kb "$tmp_dir/extract")"
      EX_OFF=$(( EX_OFF + EX_AFTER - EX_BEFORE ))
    fi
    if [ "$web" = "true" ]; then
      EX_BEFORE="$(dir_kb "$tmp_dir/extract")"
      extract_to "$archive_web" "$tmp_dir/extract" "$BAR_TOTAL" "$EX_OFF"
      EX_AFTER="$(dir_kb "$tmp_dir/extract")"
      EX_OFF=$(( EX_OFF + EX_AFTER - EX_BEFORE ))
    fi
    mkdir -p "$INSTALL_DIR"
    copy_to "$tmp_dir/extract/$APP" "$INSTALL_DIR" "$BAR_TOTAL" "$EX_OFF"
    render_single "$BAR_TOTAL" "$BAR_TOTAL" Done
    printf '\n' >&2
    show_cursor
    DO_COPY=0
  else
    if [ "$fetch_base" = "true" ]; then
      DL_KNOWN=""
      if [ -n "$BAR_TTY" ]; then
        DL_BYTES="$(head_bytes "$url")"
        case "$DL_BYTES" in
          '' | *[!0-9]* | 0) ;;
          *) DL_KNOWN=$(( (DL_BYTES + 1023) / 1024 )) ;;
        esac
      fi
      download_to "$url" "$archive" "$DL_KNOWN" 0
      extract_to "$archive" "$tmp_dir/extract" "" 0
      if [ -n "$BAR_TTY" ]; then printf '\n' >&2; fi
    fi
    if [ "$web" = "true" ]; then
      DL_KNOWN=""
      if [ -n "$BAR_TTY" ]; then
        DL_BYTES="$(head_bytes "$url_web")"
        case "$DL_BYTES" in
          '' | *[!0-9]* | 0) ;;
          *) DL_KNOWN=$(( (DL_BYTES + 1023) / 1024 )) ;;
        esac
      fi
      download_to "$url_web" "$archive_web" "$DL_KNOWN" 0
      extract_to "$archive_web" "$tmp_dir/extract" "" 0
      if [ -n "$BAR_TTY" ]; then printf '\n' >&2; fi
    fi
  fi
fi

if [ "$DO_COPY" = 1 ]; then
  mkdir -p "$INSTALL_DIR"
  cp -r "$tmp_dir/extract/$APP/." "$INSTALL_DIR/"
fi
mkdir -p "$BIN_DIR"
if [ "$archive_ext" = ".zip" ]; then
  cat > "$BIN_DIR/$APP" <<EOF
#!/bin/sh
# Generated by the openbutler installer. Uses the bundled Node.js runtime.
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
exec "\$ROOT/node/bin/node.exe" "\$ROOT/app/dist/cli.js" "\$@"
EOF
else
  cat > "$BIN_DIR/$APP" <<EOF
#!/bin/sh
# Generated by the openbutler installer. Uses the bundled Node.js runtime.
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
exec "\$ROOT/node/bin/node" "\$ROOT/app/dist/cli.js" "\$@"
EOF
fi
chmod 755 "$BIN_DIR/$APP"

installed="$(installed_version)"
if [ -z "$installed" ]; then
  echo "Error: installation finished but \`openbutler --version\` does not run." >&2
  exit 1
fi
printf '%s\n' "$config" > "$INSTALL_DIR/.openbutler-flavor"
if [ "$is_update" = "1" ]; then
  say "Updated openbutler $current -> $installed."
else
  say "Installed openbutler $installed to $INSTALL_DIR."
fi
if [ "$host_was_running" = "1" ]; then start_running_host; host_restored=1; fi

case "$config" in
  daemon)
    say "Next: choose a model with  openbutler setup  then start the host with  openbutler daemon start  (add --listen <addr:port> for remote clients) and pair them with  openbutler pair"
    ;;
  daemon+web)
    say "Next: choose a model with  openbutler setup  then start host and UI together with  openbutler daemon start --web  (add  --listen <addr:port>  for CLI clients and  --hostname <address>  for phones and browsers)"
    say "Pair a CLI or desktop against this host with  openbutler pair"
    ;;
  client)
    say "Next: pair a backend with  openbutler connect <host:port> --code <code>"
    ;;
  client+web)
    say "Next: pair a backend with  openbutler connect <host:port> --code <code>  then open the UI with  openbutler web --backend <name>"
    ;;
esac

if [ "$no_modify_path" = "true" ]; then
  say "Skipped PATH setup (--no-modify-path). Add $BIN_DIR to PATH manually."
  exit 0
fi

if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$BIN_DIR" >> "$GITHUB_PATH"
  say "Added $BIN_DIR to GITHUB_PATH."
  exit 0
fi

current_shell="$(basename "${SHELL:-sh}")"
case "$current_shell" in
  fish) config_files="$HOME/.config/fish/config.fish" ;;
  zsh) config_files="$HOME/.zshenv $HOME/.zshrc" ;;
  bash) config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
  ash | dash) config_files="$HOME/.profile" ;;
  *) config_files="$HOME/.profile" ;;
esac

export_line="export PATH=\"$BIN_DIR:\$PATH\""
config_file=""
for file in $config_files; do
  if [ -f "$file" ]; then
    config_file="$file"
    break
  fi
done

if [ -z "$config_file" ]; then
  say "No shell startup file found. Add this to your shell configuration:"
  say "  $export_line"
  exit 0
fi

if grep -qF "$BIN_DIR" "$config_file" 2>/dev/null; then
  say "PATH already contains $BIN_DIR ($config_file)."
else
  printf '\n# Added by the openbutler installer.\n%s\n' "$export_line" >> "$config_file"
  say "Added $BIN_DIR to PATH in $config_file."
fi
say "Restart your shell (or run: export PATH=\"$BIN_DIR:\$PATH\") then try: openbutler --version"
