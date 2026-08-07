#!/usr/bin/env bash
# One-shot deploy of the Kondi site to a Lightsail (or any) nginx box.
# Usage:  ./deploy.sh  user@STATIC_IP
# e.g.    ./deploy.sh  ubuntu@203.0.113.10     (Ubuntu image)
#         ./deploy.sh  bitnami@203.0.113.10    (Bitnami image)
set -euo pipefail
TARGET="${1:?usage: ./deploy.sh user@host}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ uploading index.html to $TARGET"
scp "$HERE/index.html" "$TARGET:/tmp/kondi-index.html"

echo "→ installing into /var/www/kondi"
ssh "$TARGET" 'sudo mkdir -p /var/www/kondi && sudo mv /tmp/kondi-index.html /var/www/kondi/index.html && sudo chown -R www-data:www-data /var/www/kondi 2>/dev/null || true'

echo "✓ file is on the server at /var/www/kondi/index.html"
echo "  next: install the nginx server block + run certbot (see DEPLOY.md)"
