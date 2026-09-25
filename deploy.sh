#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/Mu-Linux-0.97k"

echo "==> git pull"
git pull origin main

echo "==> Commit em deploy: $(git rev-parse --short HEAD)"

# Site (sempre; o Docker usa cache quando nada mudou)
echo "==> Rebuild mu-web"
docker compose up -d --build mu-web

# Cliente: regenera o zip de download se algum arquivo do cliente for mais novo
if [ ! -f downloads/MuOnline-97k.zip ] || [ -n "$(find Client Encoder -newer downloads/MuOnline-97k.zip -print -quit 2>/dev/null)" ]; then
  echo "==> Cliente mudou -> regenerando zip de download"
  ( cd Client && zip -r -q ../downloads/MuOnline-97k.zip . -x 'ScreenShots/*' )
  ls -lh downloads/MuOnline-97k.zip
fi

echo "==> Containers:"
docker compose ps
