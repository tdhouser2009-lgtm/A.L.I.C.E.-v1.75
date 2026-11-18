#!/usr/bin/env bash
# Installs a Local Assistant menu entry that points at this checkout's absolute path.
set -euo pipefail
workspace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "${target_dir}"
cat > "${target_dir}/local-assistant.desktop" <<ENTRY
[Desktop Entry]
Version=1.0
Type=Application
Name=Local Assistant
Comment=Private local instruction-following and coding assistant
Exec="${workspace_dir}/scripts/launch-local-assistant.sh"
TryExec=${workspace_dir}/scripts/launch-local-assistant.sh
Icon=utilities-terminal
Terminal=false
Categories=Development;Utility;
ENTRY
chmod +x "${workspace_dir}/scripts/launch-local-assistant.sh"
echo "Installed ${target_dir}/local-assistant.desktop"
