#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/Mu-Linux-0.97k"

echo "==> git pull"
git pull origin main

echo "==> Commit em deploy: $(git rev-parse --short HEAD)"

# Site (sempre; o Docker usa cache quando nada mudou)
echo "==> Rebuild mu-web"
docker compose up -d --build mu-web

# Servidor: rebuild se Dockerfile / fontes / config do jogo forem mais novos
# que o ultimo build (o config do GameServer fica embutido na imagem).
STAMP="$HOME/.mu-server-built"
if [ ! -f "$STAMP" ] || [ -n "$(find Dockerfile Source MuServer docker -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
  echo "==> Servidor mudou -> rebuild mu-server"
  docker compose up -d --build mu-server
  touch "$STAMP"
else
  echo "==> Servidor sem mudancas"
fi

# Cliente: regenera o manifesto do launcher e o zip de download
if [ ! -f Client/update-manifest.json ] || [ ! -f downloads/MuOnline-97k.zip ] || \
   [ -n "$(find Client Encoder tools -newer downloads/MuOnline-97k.zip -print -quit 2>/dev/null)" ]; then
  echo "==> Cliente mudou -> regenerando manifesto e zip de download"
  python3 tools/gen-manifest.py Client
  ( cd Client && zip -r -q ../downloads/MuOnline-97k.zip . -x 'ScreenShots/*' -x 'update-manifest.json' )
  ls -lh downloads/MuOnline-97k.zip
else
  echo "==> Cliente sem mudancas"
fi

echo "==> Containers:"
docker compose ps
