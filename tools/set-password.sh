#!/usr/bin/env bash
# Prompts (silently) for the admin password and stores its scrypt hash in .env. The password itself is never saved.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -s -p "New admin password: " pw; echo
read -r -s -p "Repeat: " pw2; echo
[ "$pw" = "$pw2" ] && [ ${#pw} -ge 8 ] || { echo "Passwords differ or are shorter than 8 characters"; exit 1; }
hash=$(PW="$pw" docker run --rm -e PW -v "$PWD/server/src:/s:ro" node:22-alpine \
  node --input-type=module -e "import {hashPassword} from '/s/auth.js'; console.log(hashPassword(process.env.PW))")
grep -v '^ADMIN_PASSWORD_HASH=' .env > .env.new || true
echo "ADMIN_PASSWORD_HASH=$hash" >> .env.new
mv .env.new .env; chmod 600 .env
echo "Saved. Restart with: docker compose up -d server"
