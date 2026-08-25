#!/bin/bash
# Microweber CLI installer (using artisan command)

DB_HOST="${DB_HOST:-db}"
DB_USERNAME="${DB_USERNAME:-microweber}"
DB_PASSWORD="${DB_PASSWORD:-microweber}"
DB_DATABASE="${DB_DATABASE:-microweber}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"

echo "[microweber-install] Starting installation using Artisan CLI..."

cd /var/www/html

# Use Artisan command for installation with verbose output
echo "[microweber-install] Running: php artisan microweber:install"
php artisan microweber:install \
    --db-host="${DB_HOST}" \
    --db-name="${DB_DATABASE}" \
    --db-username="${DB_USERNAME}" \
    --db-password="${DB_PASSWORD}" \
    --db-driver=mysql \
    --db-prefix=mw_ \
    --email="${ADMIN_EMAIL}" \
    --username="${ADMIN_USER}" \
    --password="${ADMIN_PASS}" \
    --default-content=1 \
    -v 2>&1 | tee /tmp/artisan_install.log

INSTALL_RESULT=${PIPESTATUS[0]}
echo "[microweber-install] Artisan exit code: ${INSTALL_RESULT}"

echo "[microweber-install] Installation complete with exit code: ${INSTALL_RESULT}"

# Verify DB was actually created
sleep 2
TABLE_COUNT=$(mysql -h ${DB_HOST} -u ${DB_USERNAME} -p${DB_PASSWORD} ${DB_DATABASE} -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_DATABASE}';" 2>/dev/null || echo "0")
echo "[microweber-install] Post-install DB check: ${TABLE_COUNT} tables"

if [ "$TABLE_COUNT" -gt "5" ]; then
    echo "[microweber-install] ✓ Database successfully initialized"
    exit 0
else
    echo "[microweber-install] ⚠ Database initialization incomplete (${TABLE_COUNT} tables). Continuing anyway..."
    # Don't fail - let init.sh handle DB initialization
    exit 0
fi
