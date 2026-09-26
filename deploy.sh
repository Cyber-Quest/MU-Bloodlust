#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/Mu-Linux-0.97k"

# Compose com o editor de servidor habilitado (view/API de config no admin)
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.editor.yml"

echo "==> git pull"
git pull origin main

echo "==> Commit em deploy: $(git rev-parse --short HEAD)"

# Site + editor (sempre; o Docker usa cache quando nada mudou)
echo "==> Rebuild mu-web + mu-editor"
$COMPOSE up -d --build mu-web mu-editor

# Servidor: rebuild se Dockerfile / fontes / config do jogo forem mais novos
# que o ultimo build (o config do GameServer fica embutido na imagem).
STAMP="$HOME/.mu-server-built"
if [ ! -f "$STAMP" ] || [ -n "$(find Dockerfile Source MuServer docker -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
  echo "==> Servidor mudou -> rebuild mu-server"
  $COMPOSE up -d --build mu-server
  touch "$STAMP"
else
  echo "==> Servidor sem mudancas"
fi

# IMPORTANTE: /opt/mu/Data e /opt/mu/GameServer/Data sao VOLUMES nomeados do Docker.
# Um volume ja existente NAO recebe os arquivos novos da imagem, entao mudancas em
# MuServer/Data (Item.txt, ItemOption.txt, Shop, EventItemBag, ...) e em
# MuServer/GameServer/DATA (XP, StartUp, eventos) ficariam sem efeito.
# Sincronizamos do host para o container e reiniciamos apenas quando algo muda.
CFG_STAMP="$HOME/.mu-config-synced"
CFG_HASH=$(find MuServer/Data MuServer/GameServer/DATA -type f -print0 \
  | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)
if [ ! -f "$CFG_STAMP" ] || [ "$(cat "$CFG_STAMP" 2>/dev/null)" != "$CFG_HASH" ]; then
  echo "==> Config do servidor mudou -> sincronizando para o container"
  CID=$($COMPOSE ps -q mu-server)
  if [ -n "$CID" ]; then
    docker cp MuServer/Data/. "$CID:/opt/mu/Data/"
    docker cp MuServer/GameServer/DATA/. "$CID:/opt/mu/GameServer/Data/"
    docker restart "$CID" >/dev/null
    echo "$CFG_HASH" > "$CFG_STAMP"
    echo "==> mu-server reiniciado com a config nova"
  fi
else
  echo "==> Config do servidor sem mudancas"
fi

# Cliente: regenera o manifesto do launcher e o zip de download
if [ ! -f Client/update-manifest.json ] || [ ! -f downloads/MuOnline-97k.zip ] || \
   [ -n "$(find Client Encoder tools -newer downloads/MuOnline-97k.zip -print -quit 2>/dev/null)" ]; then
  echo "==> Cliente mudou -> regenerando manifesto e zip de download"
  python3 tools/gen-manifest.py Client
  # OBS: 'zip' atualiza o arquivo e NAO remove entradas de arquivos apagados,
  # entao o zip precisa ser recriado do zero a cada vez.
  rm -f downloads/MuOnline-97k.zip
  ( cd Client && zip -r -q ../downloads/MuOnline-97k.zip . -x 'ScreenShots/*' -x 'update-manifest.json' )
  ls -lh downloads/MuOnline-97k.zip
else
  echo "==> Cliente sem mudancas"
fi

echo "==> Containers:"
$COMPOSE ps
