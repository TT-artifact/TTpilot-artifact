#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/db

mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017 --fork --logpath /var/log/mongod.log

echo "[squidex-init] Waiting for MongoDB..."
for i in $(seq 1 30); do
    if (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; then
        exec 3<&- 3>&-
        echo "[squidex-init] MongoDB is ready."
        break
    fi
    echo "[squidex-init] Waiting for MongoDB... ($i/30)"
    sleep 2
done

exec dotnet /app/Squidex.dll
