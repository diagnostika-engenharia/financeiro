#!/bin/sh
# ── Deploy do Financeiro ──────────────────────────────────────
# Uso:  ./_deploy.sh "mensagem do commit"
#
# Carimba a versao (APP_BUILD + version.json), commita a FONTE (repo financeiro)
# E copia para o Portal (financeiro-app) — que e a URL REAL do app do usuario.
#
# >>> A URL que o usuario abre e https://diagnostika-engenharia.github.io/financeiro-app/
#     servida pelo repo diagnostika-engenharia.github.io (pasta ../Portal Diagnostika/financeiro-app).
#     O repo `financeiro` (/financeiro/) e so a fonte/backup — publicar so nele NAO atualiza o usuario!
#
# O carimbo alimenta a auto-atualizacao do app (PWA detecta version.json novo).
# Commita apenas index.html + version.json em cada repo. Outros arquivos: commite antes.
set -e
MSG="${1:-Atualização do sistema}"
BUILD=$(date +%Y%m%d-%H%M%S)

sed -i "s/const APP_BUILD='[^']*'/const APP_BUILD='$BUILD'/" index.html
printf '{"build":"%s"}\n' "$BUILD" > version.json

grep -q "const APP_BUILD='$BUILD'" index.html || { echo "ERRO: carimbo do APP_BUILD falhou"; exit 1; }
grep -q "\"build\":\"$BUILD\"" version.json || { echo "ERRO: version.json nao carimbado"; exit 1; }

# 1) FONTE — repo `financeiro`
git add index.html version.json
git commit -m "$MSG" -m "APP_BUILD=$BUILD"
git push origin main

# 2) DEPLOY REAL — copia para o Portal (financeiro-app) e publica no repo do Portal
PORTAL_DIR="../Portal Diagnostika"
APP_DIR="$PORTAL_DIR/financeiro-app"
if [ -d "$APP_DIR" ]; then
  cp index.html "$APP_DIR/index.html"
  cp version.json "$APP_DIR/version.json"
  ( cd "$PORTAL_DIR" \
    && git add financeiro-app/index.html financeiro-app/version.json \
    && git commit -m "Financeiro: $MSG (APP_BUILD=$BUILD)" \
    && git push origin main )
  echo ""
  echo "✔ Publicado APP_BUILD=$BUILD em AMBOS:"
  echo "  - fonte:  https://diagnostika-engenharia.github.io/financeiro/"
  echo "  - USUARIO: https://diagnostika-engenharia.github.io/financeiro-app/   <<< o que importa"
else
  echo ""
  echo "!!! ATENCAO: pasta '$APP_DIR' nao encontrada."
  echo "!!! O app do usuario (/financeiro-app/) NAO foi atualizado — so a fonte (/financeiro/)."
  exit 1
fi
echo "  Propagacao no CDN do GitHub Pages: ate ~10 min."
