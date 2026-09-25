#!/usr/bin/env python3
"""
Gera o manifesto de atualizacoes do launcher: <client>/update-manifest.json

Uso:
    python3 tools/gen-manifest.py [pasta_do_cliente]

Exclui do manifesto (nunca sao sobrescritos pelo launcher):
  - Config.ini        (configuracao do jogador: resolucao, som, idioma)
  - ScreenShots/      (capturas do jogador)
  - o proprio launcher, o manifesto, logs e arquivos .download temporarios
"""
import datetime
import hashlib
import json
import os
import sys

EXCLUDE_FILES = {"update-manifest.json", "launcher-update.log", "launcher-url.txt"}
EXCLUDE_NAMES = {"Config.ini"}
EXCLUDE_DIRS = {"ScreenShots"}
EXCLUDE_EXT = {".download", ".tmp"}
LAUNCHER_NAME = "Launcher.exe"

# zip com o cliente completo (usado pelo launcher numa instalacao nova)
FULL_PACKAGE_PATH = "/downloads/MuOnline-97k.zip"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(client_dir: str) -> dict:
    files = []
    for root, dirs, names in os.walk(client_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in names:
            if name in EXCLUDE_FILES or name in EXCLUDE_NAMES:
                continue
            if name == LAUNCHER_NAME:
                continue
            if os.path.splitext(name)[1].lower() in EXCLUDE_EXT:
                continue

            full = os.path.join(root, name)
            if not os.path.isfile(full):
                continue

            rel = os.path.relpath(full, client_dir).replace(os.sep, "/")
            files.append({
                "path": rel,
                "size": os.path.getsize(full),
                "sha256": sha256_file(full),
            })

    files.sort(key=lambda item: item["path"])
    now = datetime.datetime.now(datetime.timezone.utc)
    return {
        "version": now.strftime("%Y.%m.%d.%H%M"),
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        # zip do cliente completo: o launcher usa quando quase tudo mudou
        "full": FULL_PACKAGE_PATH,
        "files": files,
    }


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_client = os.path.normpath(os.path.join(here, "..", "Client"))
    client_dir = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else default_client

    if not os.path.isdir(client_dir):
        print("pasta do cliente nao encontrada: " + client_dir, file=sys.stderr)
        return 1

    manifest = build_manifest(client_dir)
    out_path = os.path.join(client_dir, "update-manifest.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    total = sum(item["size"] for item in manifest["files"])
    print("manifest: {0} arquivos ({1:.1f} MB) -> {2}".format(
        len(manifest["files"]), total / (1024 * 1024), out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
