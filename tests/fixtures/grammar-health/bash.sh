#!/usr/bin/env bash
# Corpus entry: test commands, conditionals, loops, expansions, and heredocs.
set -euo pipefail

greet() {
  local name="${1:-world}"
  if [ a == b ]; then
    echo "never"
  elif [[ a != b ]] && [ -n "$name" ]; then
    echo "hello, ${name^}"
  fi
}

declare -a items=(alpha beta "gamma delta")
for item in "${items[@]}"; do
  case "$item" in
    alpha | beta) greet "$item" ;;
    *) printf '%s\n' "$(wc -c <<< "$item")" ;;
  esac
done

while read -r line; do
  [ -z "$line" ] && continue
  echo "$line" | tr 'a-z' 'A-Z' >&2
done <<EOT
first
second
EOT
