#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/Mu-Linux-0.97k"

# Detecta se houve mudança em arquivos do servidor ANTES de puxar
git fetch origin main
SERVER_CHANGED=$(git diff --name-only HEAD origin/main | grep -cE '^(Dockerfile|Source/|MuServer/|docker/|docker-compose.yml)' || true)

echo "==> git pull"
git pull origin main

echo "==> Rebuild mu-web"
docker compose up -d --build mu-web

if [ "$SERVER_CHANGED" -gt 0 ]; then
  echo "==> Arquivos do servidor mudaram -> rebuild mu-server"
  docker compose up -d --build mu-server
fi

echo "==> Estado final:"
docker compose ps
