#!/usr/bin/env bash
# Copyright 2026 Memlia. All rights reserved.
set -euo pipefail
scanner="${1:?Indiquer le chemin du binaire Gitleaks vérifié}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$("$scanner" version)" != '8.30.1' ]]; then
  printf '%s\n' 'Publication refusée : version du scanner différente de la revue.' >&2
  exit 2
fi
# Gitleaks charge aussi ce fichier à la racine même avec --gitleaks-ignore-path.
if [[ -e .gitleaksignore || -L .gitleaksignore ]]; then
  printf '%s\n' 'Publication refusée : exemptions automatiques .gitleaksignore interdites.' >&2
  exit 1
fi
# Le dépôt ne décide ni des règles du scanner ni de ses exemptions implicites.
# Une éventuelle fixture doit d'abord recevoir une admission exacte et revue.
empty_config="$(mktemp -d)"
trap 'rm -rf -- "$empty_config"' EXIT
unset GITLEAKS_CONFIG_TOML GITLEAKS_CONFIG
# Ne pas laisser des refs de remplacement masquer les objets réellement publiés.
export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
if [[ -n "${GIT_GRAFT_FILE:-}" ]]; then
  printf '%s\n' 'Publication refusée : historique Git greffé.' >&2
  exit 2
fi
grafts="$(git rev-parse --path-format=absolute --git-path info/grafts)"
if [[ -e "$grafts" || -L "$grafts" ]]; then
  printf '%s\n' 'Publication refusée : historique Git greffé.' >&2
  exit 2
fi
printf '[extend]\nuseDefault = true\n' > "$empty_config/default.toml"
review="$PWD/compliance/reviewed-gitleaks.json"
if [[ ! -e "$review" ]]; then
  review="$empty_config/review.json"
  printf '%s\n' '{"scanner":"gitleaks","version":"8.30.1","findings":[]}' > "$review"
fi
for mode in dir git; do
  arguments=("$mode" --redact --no-banner --ignore-gitleaks-allow
    --config "$empty_config/default.toml" --gitleaks-ignore-path "$empty_config"
    --report-format json --report-path "$empty_config/$mode.json")
  classification='repository'
  if [[ "$mode" == git ]]; then
    arguments+=(--log-opts='--all --full-history --root -m --text --no-ext-diff --no-textconv')
    classification='history'
  fi
  status=0
  "$scanner" "${arguments[@]}" . \
    > "$empty_config/$mode.log" 2>&1 || status=$?
  if [[ "$status" != 0 && "$status" != 1 ]]; then
    printf '%s\n' 'Publication refusée : le scanner ne termine pas normalement.' >&2
    exit 2
  fi
  # Le rapport vient de cette exécution. Le mode historique lit commit:path,
  # sans refs de remplacement ; le contenu du checkout ne l'autorise jamais.
  python3 "$script_dir/../compliance/source_policy.py" --root . \
    --report "$empty_config/$mode.json" --review "$review" --mode "$classification"
done
