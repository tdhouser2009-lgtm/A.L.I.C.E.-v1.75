#!/usr/bin/env bash
set -euo pipefail

workspace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ollama_base_url="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is required. Install Ollama, then open Local Assistant again." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check the local Ollama service." >&2
  exit 1
fi

if ! curl --silent --fail --max-time 2 "${ollama_base_url}/api/tags" >/dev/null; then
  nohup ollama serve >/dev/null 2>&1 </dev/null &
  for attempt in {1..20}; do
    if curl --silent --fail --max-time 2 "${ollama_base_url}/api/tags" >/dev/null; then
      break
    fi
    sleep 1
  done
fi

python="${workspace_dir}/.venv/bin/python"
if [[ ! -x "${python}" ]]; then
  python="$(command -v python3 || true)"
fi
if [[ -z "${python}" || ! -x "${python}" ]]; then
  echo "Python 3 is required to open the Local Assistant GUI." >&2
  exit 1
fi

exec "${python}" "${workspace_dir}/local_assistant_gui.py"
