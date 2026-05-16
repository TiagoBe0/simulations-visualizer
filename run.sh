#!/usr/bin/env bash
# Arranca el visualizador. Uso:
#   ./run.sh                 -> http://0.0.0.0:8000, datos en ./NuevasCorridas
#   DATA_DIR=/ruta/datos PORT=9000 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
export DATA_DIR="${DATA_DIR:-$(pwd)/NuevasCorridas}"

PY=python3
RUNNER=""

if [ -x .venv/bin/uvicorn ]; then
  RUNNER=".venv/bin/uvicorn"
elif python3 -m venv .venv 2>/dev/null; then
  ./.venv/bin/pip install --upgrade pip -q
  ./.venv/bin/pip install -r requirements.txt -q
  RUNNER=".venv/bin/uvicorn"
else
  # venv no disponible (falta python3-venv). Probamos Python del sistema.
  echo "Aviso: no se pudo crear venv (instalá 'python3-venv' para aislarlo)."
  if ! python3 -c "import uvicorn, fastapi" 2>/dev/null; then
    echo "Instalando dependencias a nivel usuario..."
    python3 -m pip install --user -r requirements.txt -q \
      || python3 -m pip install --user --break-system-packages -r requirements.txt -q
  fi
  RUNNER="$PY -m uvicorn"
fi

echo "Datos:    $DATA_DIR"
echo "Servidor: http://$HOST:$PORT"
exec $RUNNER app:app --app-dir backend --host "$HOST" --port "$PORT"
