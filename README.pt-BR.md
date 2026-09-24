# Mu Linux 97K

[![Site do projeto](https://img.shields.io/badge/site%20do%20projeto-mu--linux.com-0ea5e9?logo=googlechrome&logoColor=white)](https://mu-linux.com/es/)
[![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k?label=server&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-web?label=web&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-web) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mu-editor?label=editor&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mu-editor) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mysql?label=mysql&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mysql)

[🇪🇸 Español](README.md) | [🇺🇸 English](README.en.md) | 🇧🇷 Português

Port nativo para Linux e stack operacional do MuEmu 0.97k com Docker, painel web e editor opcional.

## Base e referência

Baseado nas sources do Kayito.

[![Ver README original do Kayito](https://img.shields.io/badge/README%20original-Kayito-181717?logo=github)](https://github.com/nicomuratona/MuEmu-0.97k-kayito#readme)

## Créditos e objetivos

- Kayito: sources base MuEmu 0.97k; Trifon Dinev: Simple MU Online Templates usado no `mu-web`.
- Servidor Linux nativo com epoll, MySQL sem MSSQL e Docker pronto para VPS.

## Imagens oficiais

- `emapupi/mu-linux-97k` (server), `emapupi/mu-linux-97k-web` (web).
- `emapupi/mu-linux-97k-mu-editor` (API do editor), `emapupi/mu-linux-97k-mysql` (MySQL/init).

## Update 1 (2026-02-20)

- Editor web para dados, contas, personagens, shops, spawns, gates, configurações, itens, monstros, drops, backups e snapshots.
- Serviço opcional `mu-editor` com recarga automática por `EditorReload.flag`.

## Update 2 (2026-03-26)

- Correções do cliente para staffs, Character Info, guild, macros e quests; drop Divine e Crystal Sword/Morning Star.

## Update 3 (2026-09-20)

- Server: correção do Blood Castle e evento de chuva de joias Tamachan (o cliente baseado nas sources é necessário para vê-lo completamente).
- `MonsterSetBase.txt`: restauração de spawn points normais ausentes e NPCs necessários nos mapas reportados.
- Docker: CMake limitado a um trabalho (`-j1`) para evitar OOM em hosts com pouca memória.
- Arquiteturas: suporte nativo `linux/amd64` e `linux/arm64`, com MySQL 8.4 LTS em ambas.
- Banco de dados: atualização para MySQL 8.4 LTS. Leia o [guia de migração](docs/mysql-8.4-upgrade.md) antes de reutilizar um volume existente.
- ARM64: correção da leitura de scripts e semântica herdada de `char`, evitando parse incorreto e desconexões erradas.
- CI: cada push, pull request e execução manual valida imagem `linux/arm64` e smoke test de início.

## Estado do cliente

O cliente baseado em injeção de DLL está deixando de ser a implementação principal. Seus arquivos permanecem para compatibilidade, referência e manutenção; o desenvolvimento ativo continua em <https://github.com/EmanuelCatania/Mu-97k-Client-Source>.

## Início rápido

1. Copie `.env.example` para `.env` e configure credenciais, `PUBLIC_IP` e secrets.
2. Inicie a stack:

   ```bash
   docker compose up -d --build
   ```

3. Abra `44405/tcp`, `55601/udp` e `55901/tcp`.

Para imagens publicadas sem build:

```bash
docker compose -f docker-compose.images.yml up -d
```

Em ARM com 1 GB de RAM ou menos, ative 2 GB de swap antes do primeiro build. `uname -m`: `x86_64` = amd64, `aarch64` = arm64.

## Ambiente

`.env` usa `.env.example` como base; altere os valores antes de produção.

- MySQL: `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- Servidor: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `PUBLIC_IP`.
- Web: `WEB_PORT`, `SESSION_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `ADMIN_USER`, `ADMIN_PASS`, `TRUST_PROXY`.
- Dados de teste: `SEED_TEST_DATA`; editor: `EDITOR_ENABLED`, `EDITOR_PORT`, `EDITOR_API_URL`, `EDITOR_MAX_BACKUPS`, `EDITOR_MAX_SNAPSHOTS`.

Depois de mudar credenciais MySQL, recrie o volume:

```bash
docker compose down -v
docker compose up -d --build
```

## Editor, painel web e notas

O editor opcional usa os volumes internos do `mu-server`:

```bash
docker compose -f docker-compose.yml -f docker-compose.editor.yml up -d --build
```

Ele mantém backups por arquivo e snapshots de `MuServer/Data` e `MuServer/GameServer/DATA`. `mu-web` oferece registro, login, rankings e notícias na porta externa `8085` (interna `8080`). Admin inicial: `admin / 123456`, com troca obrigatória no primeiro login.

- `MD5Encryption=2` usa MD5 binário; recrie a DB com `docker compose down -v` ao migrar de texto simples.
- Salve TXT do servidor em ANSI / Windows-1252 sem BOM. Shops ficam em `MuServer/Data/Shop/*.txt`; `-1 -1` posiciona `SlotX SlotY` automaticamente.
- Logs: `docker compose logs -f`. Pastas principais: `Source/`, `MuServer/`, `Client/`, `Encoder/`, `docker/`.
