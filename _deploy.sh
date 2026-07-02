#!/bin/sh
# ── Deploy do Financeiro ──────────────────────────────────────
# Uso:  ./_deploy.sh "mensagem do commit"
#
# Carimba a versão (APP_BUILD + version.json), commita e publica.
# O carimbo alimenta a auto-atualização do app: PWA/navegador detectam
# a versão nova e se atualizam sozinhos.
#
# REGRA: TODO deploy deste repo passa por este script. Um push sem carimbo
# publica código novo com versão velha e os clientes NÃO detectam a atualização.
#
# Atenção: o script commita APENAS index.html + version.json. Se você mudou
# outros arquivos (assets/, etc.), commite-os antes ou junte no mesmo commit.
set -e
MSG="${1:-Atualização do sistema}"
BUILD=$(date +%Y%m%d-%H%M%S)

sed -i "s/const APP_BUILD='[^']*'/const APP_BUILD='$BUILD'/" index.html
printf '{"build":"%s"}\n' "$BUILD" > version.json

# Guard: aborta se o carimbo não pegou (ex.: linha do APP_BUILD reformatada)
grep -q "const APP_BUILD='$BUILD'" index.html || { echo "ERRO: carimbo do APP_BUILD falhou — verifique a linha 'const APP_BUILD=' no index.html"; exit 1; }
grep -q "\"build\":\"$BUILD\"" version.json || { echo "ERRO: version.json não foi carimbado"; exit 1; }

git add index.html version.json
git commit -m "$MSG" -m "APP_BUILD=$BUILD"
git push origin main

echo ""
echo "✔ Publicado com APP_BUILD=$BUILD"
echo "  Propagação no CDN do GitHub Pages: até ~10 min."
echo "  Build do Pages: gh api repos/diagnostika-engenharia/financeiro/pages/builds/latest"
