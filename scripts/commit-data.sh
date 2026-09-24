#!/usr/bin/env bash
# Sube a main lo que haya avanzado en data/, aunque main haya cambiado mientras
# el workflow corría (por ejemplo, un push de código a media corrida).
# Uso: scripts/commit-data.sh "mensaje del commit"
set -u
MSG="${1:-chore: refresh brand data [automated]}"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
rm -f data/*/.meta-ads-state.json   # formato viejo con token: nunca se sube
git add data/
if git diff --cached --quiet; then
  echo "Sin cambios en data/, nada que subir."
  exit 0
fi
git commit -q -m "$MSG" -m "$(node scripts/kb-stats.mjs)"
for i in 1 2 3 4; do
  # --autostash: si algún paso dejó otros archivos modificados (fuera de data/),
  # no bloquean el rebase. -X theirs: en conflicto de data/ gana lo recién bajado.
  if git pull --rebase --autostash -X theirs origin main && git push origin HEAD:main; then
    echo "✅ Avance subido a main."
    exit 0
  fi
  echo "Push falló (intento $i), reintentando..."
  git rebase --abort 2>/dev/null || true
  sleep $((i * 5))
done
echo "❌ No se pudo subir el avance."
exit 1
