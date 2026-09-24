# Mu Linux 97K

[![Project website](https://img.shields.io/badge/project%20website-mu--linux.com-0ea5e9?logo=googlechrome&logoColor=white)](https://mu-linux.com/es/)
[![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k?label=server&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-web?label=web&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-web) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mu-editor?label=editor&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mu-editor) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mysql?label=mysql&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mysql)

[🇪🇸 Español](README.md) | 🇺🇸 English | [🇧🇷 Português](README.pt-BR.md)

Native Linux port and operational MuEmu 0.97k stack with Docker, web panel and optional editor.

## Base and reference

Based on Kayito's sources.

[![View Kayito's original README](https://img.shields.io/badge/original%20README-Kayito-181717?logo=github)](https://github.com/nicomuratona/MuEmu-0.97k-kayito#readme)

## Credits and goals

- Kayito: MuEmu 0.97k base sources; Trifon Dinev: Simple MU Online Templates used by `mu-web`.
- Native Linux server with epoll and compatibility fixes, MySQL instead of MSSQL, and Docker for VPS deployment.

## Official images

- `emapupi/mu-linux-97k` (server), `emapupi/mu-linux-97k-web` (web).
- `emapupi/mu-linux-97k-mu-editor` (editor API), `emapupi/mu-linux-97k-mysql` (MySQL/init).

## Update 1 (2026-02-20)

- Web editor for data, accounts, characters, shops, spawns, gates, configuration, items, monsters, drops, backups and snapshots.
- Optional `mu-editor` service with `EditorReload.flag` automatic reload.

## Update 2 (2026-03-26)

- Client fixes for staffs, Character Info, guild, macros and quests; Divine drop and Crystal Sword/Morning Star fixes.

## Update 3 (2026-09-20)

- Server: Blood Castle fix and Tamachan jewel-rain event (the source-based client is required to see it fully).
- `MonsterSetBase.txt`: restored missing normal spawn points and required NPCs in reported maps.
- Docker: CMake uses one job (`-j1`) to prevent OOM on low-memory hosts.
- Architectures: native `linux/amd64` and `linux/arm64` support, using MySQL 8 on both.
- ARM64: fixed script parsing and inherited `char` semantics, preventing parsing errors and incorrect disconnects.
- CI: every push, pull request and manual run validates a `linux/arm64` image and startup smoke test.

## Client status

The DLL injection-based client is being phased out as the main implementation. Its files remain for compatibility, reference and maintenance; active development continues at <https://github.com/EmanuelCatania/Mu-97k-Client-Source>.

## Quick start

1. Copy `.env.example` to `.env` and set credentials, `PUBLIC_IP` and secrets.
2. Start the stack:

   ```bash
   docker compose up -d --build
   ```

3. Open `44405/tcp`, `55601/udp` and `55901/tcp`.

For published images without a build:

```bash
docker compose -f docker-compose.images.yml up -d
```

On ARM with 1 GB RAM or less, enable 2 GB swap before the first build. `uname -m`: `x86_64` = amd64, `aarch64` = arm64.

## Environment

`.env` is based on `.env.example`; change values before production.

- MySQL: `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- Server: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `PUBLIC_IP`.
- Web: `WEB_PORT`, `SESSION_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `ADMIN_USER`, `ADMIN_PASS`, `TRUST_PROXY`.
- Test data: `SEED_TEST_DATA`; editor: `EDITOR_ENABLED`, `EDITOR_PORT`, `EDITOR_API_URL`, `EDITOR_MAX_BACKUPS`, `EDITOR_MAX_SNAPSHOTS`.

After changing MySQL credentials, recreate the volume:

```bash
docker compose down -v
docker compose up -d --build
```

## Editor, web panel and notes

The optional editor uses `mu-server` internal volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.editor.yml up -d --build
```

It keeps per-file backups and snapshots of `MuServer/Data` and `MuServer/GameServer/DATA`. `mu-web` provides registration, login, rankings and news on external port `8085` (internal `8080`). Initial admin is `admin / 123456` and must change password at first login.

- `MD5Encryption=2` uses binary MD5; recreate the DB with `docker compose down -v` when migrating from plain text.
- Save server TXT files as ANSI / Windows-1252 without BOM. Shops live in `MuServer/Data/Shop/*.txt`; `-1 -1` auto-places `SlotX SlotY`.
- Use `docker compose logs -f` for logs. Main folders: `Source/`, `MuServer/`, `Client/`, `Encoder/`, `docker/`.
