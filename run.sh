#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
export DATA_DIR="${DATA_DIR:-$(pwd)/simulations}"
mkdir -p "$DATA_DIR"

# Usar conda directamente
source /home/simaf/miniconda3/etc/profile.d/conda.sh
conda activate base

# Asegurar dependencias
pip install -r requirements.txt -q

echo "Datos:    $DATA_DIR"
echo "Servidor: http://$HOST:$PORT"
echo "Python:   $(python --version)"

# Ejecutar la aplicación
python -m uvicorn backend.app:app --host "$HOST" --port "$PORT"
