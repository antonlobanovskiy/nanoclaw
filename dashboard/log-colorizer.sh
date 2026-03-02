#!/usr/bin/env bash
# Pipe filter: colorizes log lines. Red for ERROR, orange for WARN, dim for rest.
while IFS= read -r line; do
  if [[ "$line" =~ ERROR|ERR ]]; then
    printf '\e[31m%s\e[0m\n' "$line"
  elif [[ "$line" =~ WARN|WARNING ]]; then
    printf '\e[38;5;208m%s\e[0m\n' "$line"
  else
    printf '\e[2m%s\e[0m\n' "$line"
  fi
done
