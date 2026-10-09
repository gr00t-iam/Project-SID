#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f config/runtime.env || -f config/plugin-config.yml ]]; then
  echo 'Configuration already exists. Edit it manually; this script will not rotate your token.'
  exit 1
fi
umask 077
bridge_secret=$(openssl rand -hex 32)
sed "s/REPLACE_WITH_RANDOM_64_HEX_CHARACTERS/$bridge_secret/" config/runtime.env.example > config/runtime.env
sed "s/REPLACE_WITH_RANDOM_64_HEX_CHARACTERS/$bridge_secret/" server-plugin/src/main/resources/config.yml > config/plugin-config.yml
unset bridge_secret
printf 'Paste the existing LM Studio API token (hidden): '
IFS= read -rs local_lm_token
printf '\n'
if [[ ! "$local_lm_token" =~ ^[A-Za-z0-9._-]+$ ]]; then echo 'Token format is unusual; edit LM_API_TOKEN manually in config/runtime.env.'; exit 1; fi
sed -i "s/^LM_API_TOKEN=$/LM_API_TOKEN=$local_lm_token/" config/runtime.env
unset local_lm_token
echo 'Wrote paired bridge configurations. Run scripts/models.mjs to get exact model IDs.'
