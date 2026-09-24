# Mu Linux 97K

[![Sitio web](https://img.shields.io/badge/sitio%20web-mu--linux.com-0ea5e9?logo=googlechrome&logoColor=white)](https://mu-linux.com/es/)
[![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k?label=server&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-web?label=web&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-web) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mu-editor?label=editor&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mu-editor) [![Docker Pulls](https://img.shields.io/docker/pulls/emapupi/mu-linux-97k-mysql?label=mysql&logo=docker)](https://hub.docker.com/r/emapupi/mu-linux-97k-mysql)

🇪🇸 Español | [🇺🇸 English](README.en.md) | [🇧🇷 Português](README.pt-BR.md)

Proyecto para operar MuEmu 0.97k en Linux de forma nativa, con Docker, web y editor opcional.

## Base y referencia

Basado en las sources de Kayito.

[![Ver README original de Kayito](https://img.shields.io/badge/README%20original-Kayito-181717?logo=github)](https://github.com/nicomuratona/MuEmu-0.97k-kayito#readme)

## Créditos

- Kayito: sources base MuEmu 0.97k.
- Trifon Dinev: Simple MU Online Templates usado en `mu-web`.

## Objetivo

- Servidor Linux nativo con epoll y ajustes de compatibilidad.
- MySQL sin dependencias MSSQL.
- Docker listo para VPS y conexión desde el cliente.

## Imágenes oficiales

- `emapupi/mu-linux-97k` (server), `emapupi/mu-linux-97k-web` (web).
- `emapupi/mu-linux-97k-mu-editor` (editor API), `emapupi/mu-linux-97k-mysql` (MySQL e init).

## Update 1 (2026-02-20)

- Editor web de data, cuentas, personajes, shops, spawns, gates, CFG, items, monsters, drops, backups y snapshots.
- Servicio opcional `mu-editor` con recarga automática mediante `EditorReload.flag`.

## Update 2 (2026-03-26)

- Fixes de cliente para staffs, Character Info, guild, macros y quests; drop Divine y Crystal Sword/Morning Star.

## Update 3 (2026-09-20)

- Server: corrección de Blood Castle y evento de lluvia de joyas con Tamachan (requiere cliente basado en sources para verse completo).
- `MonsterSetBase.txt`: restaurados spawn points normales faltantes y NPCs necesarios en los mapas reportados.
- Docker: CMake limitado a un trabajo (`-j1`) para evitar OOM en hosts con poca memoria.
- Arquitecturas: soporte nativo `linux/amd64` y `linux/arm64`, con MySQL 8 para ambas.
- ARM64: corrección de lectura de scripts y semántica heredada de `char`, evitando errores de parseo y desconexiones incorrectas.
- CI: cada push, PR y ejecución manual valida una imagen `linux/arm64` y un smoke test de inicio.

## Estado del cliente

El cliente basado en inyección de DLL está entrando en desuso como implementación principal. Sus archivos permanecen aquí por compatibilidad, referencia y mantenimiento; el desarrollo activo continúa en <https://github.com/EmanuelCatania/Mu-97k-Client-Source>.

## Inicio rápido

1. Copiá `.env.example` a `.env` y ajustá credenciales, `PUBLIC_IP` y secretos.
2. Levantá el stack:

   ```bash
   docker compose up -d --build
   ```

3. Abrí `44405/tcp`, `55601/udp` y `55901/tcp`.

Para imágenes publicadas sin build:

```bash
docker compose -f docker-compose.images.yml up -d
```

En ARM con 1 GB de RAM o menos, habilitá 2 GB de swap antes del primer build. `uname -m`: `x86_64` = amd64, `aarch64` = arm64.

## Variables de entorno

`.env` se basa en `.env.example`. Cambiá los valores antes de producción.

- MySQL: `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
- Servidor: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `PUBLIC_IP`.
- Web: `WEB_PORT`, `SESSION_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `ADMIN_USER`, `ADMIN_PASS`, `TRUST_PROXY`.
- Datos de prueba: `SEED_TEST_DATA` (`1` carga cuentas, `0` deja DB limpia).
- Editor: `EDITOR_ENABLED`, `EDITOR_PORT`, `EDITOR_API_URL`, `EDITOR_MAX_BACKUPS`, `EDITOR_MAX_SNAPSHOTS`.

Al cambiar credenciales MySQL tras el primer inicio, recreá el volumen:

```bash
docker compose down -v
docker compose up -d --build
```

## Editor y panel web

El editor es opcional y usa los volúmenes internos de `mu-server`:

```bash
docker compose -f docker-compose.yml -f docker-compose.editor.yml up -d --build
```

Mantiene backups por archivo y snapshots de `MuServer/Data` y `MuServer/GameServer/DATA`. `mu-web` ofrece registro, login, rankings y noticias en el puerto externo `8085` (interno `8080`). Admin inicial: `admin / 123456`, con cambio obligatorio al primer login. Incluye editores gráficos para cuentas, personajes, inventario, shops, spawns, gates, configuración, GM, eventos, drops y customs.

## Datos, seguridad y logs

- `MD5Encryption=2` usa MD5 binario. Al migrar desde texto plano, recreá la DB con `docker compose down -v`.
- Guardá TXT del servidor en ANSI / Windows-1252 sin BOM; UTF-8 puede romper acentos del cliente.
- Shops: `MuServer/Data/Shop/*.txt`; `SlotX SlotY` en `-1 -1` autoubica el ítem.
- Mensajes: `MuServer/Data/Message_Eng.txt`, `Message_Spn.txt`, `Message_Por.txt` y `MuServer/Data/Util/Notice.txt`.
- Logs: `docker compose logs -f`.

Estructura: `Source/` (fuentes), `MuServer/` (data), `Client/` y `Encoder/` (componentes históricos), `docker/` (imágenes y scripts).
