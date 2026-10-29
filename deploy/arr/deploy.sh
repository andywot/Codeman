#!/bin/sh
# Deploy the checked-out branch on arr: pull, build, restart, reload SWAG, then drop the
# untagged image the rebuild replaced. Run from anywhere: /srv/codeman/deploy/arr/deploy.sh
set -eu
cd "$(dirname "$0")"
t0=$(date +%s)
git -C ../.. pull -q
docker compose build -q
t1=$(date +%s)
docker compose up -d --no-build 2>&1 | tail -n 1
docker exec swag nginx -s reload
# Only dangling images (the previous build's); tagged and running images stay.
docker image prune -f >/dev/null
echo "deployed $(git -C ../.. log --oneline -1) | build $((t1 - t0))s, total $(($(date +%s) - t0))s"
