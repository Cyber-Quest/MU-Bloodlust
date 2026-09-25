#!/usr/bin/env python3
"""
Troca os textos de copyright do cliente (Webzen / kayito) pela marca do servidor.

Edite MARCA / ANO abaixo se quiser mudar o texto.
"""
import os
import shutil
import sys

KEY = [0xFC, 0xCF, 0xAB]
SLOT = 300

MARCA = 'Bloodlust MU Online'
ANO = '2026'


def xor(data):
    return bytes(b ^ KEY[i % 3] for i, b in enumerate(data))


REPL = {
    'Text_Eng.bmd': {
        454: f'(c) Copyright {ANO} {MARCA}.',
        455: ' All Rights Reserved.',
        456: f'Version: %s - {MARCA}',
        458: MARCA,
    },
    'Text_Por.bmd': {
        454: f'(c) Copyright {ANO} {MARCA}.',
        455: ' Todos os direitos reservados.',
        456: f'Versão: %s - {MARCA}',
        458: MARCA,
    },
    'Text_Spn.bmd': {
        454: f'(c) Copyright {ANO} {MARCA}.',
        455: ' Todos los derechos reservados.',
        456: f'Version: %s - {MARCA}',
        458: MARCA,
    },
}


def aplicar(path, mudancas):
    data = bytearray(open(path, 'rb').read())
    dec = bytearray(xor(bytes(data)))
    for slot, texto in mudancas.items():
        raw = texto.encode('cp1252', 'strict')
        if len(raw) > SLOT - 1:
            raise SystemExit(f'texto grande demais para o slot {slot}: {texto!r}')
        bloco = raw + b'\x00' * (SLOT - len(raw))
        dec[slot * SLOT:(slot + 1) * SLOT] = bloco
    open(path, 'wb').write(xor(bytes(dec)))


def mostrar(path, slots):
    dec = xor(open(path, 'rb').read())
    for slot in slots:
        raw = dec[slot * SLOT:(slot + 1) * SLOT]
        print(f"    slot {slot}: {raw.split(b'\x00')[0].decode('cp1252', 'replace')!r}")


os.chdir(os.environ.get('REPO', '.'))
base = 'Client/Data/Local'

for nome, mudancas in REPL.items():
    path = os.path.join(base, nome)
    shutil.copy(path, f'/tmp/{nome}.bak')
    print(f"\n=== {nome} (backup em /tmp/{nome}.bak) ===")
    print("  ANTES:")
    mostrar(path, sorted(mudancas))
    aplicar(path, mudancas)
    print("  DEPOIS:")
    mostrar(path, sorted(mudancas))

print("\nOK: textos de copyright atualizados.")
