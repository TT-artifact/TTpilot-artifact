#!/bin/bash
set -e

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-3306}"
DB_DATABASE="${DB_DATABASE:-microweber}"
DB_USERNAME="${DB_USERNAME:-microweber}"
DB_PASSWORD="${DB_PASSWORD:-microweber}"

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
DB_PREFIX="mw_"

MYSQL_OPTS="-h $DB_HOST -P $DB_PORT -u $DB_USERNAME -p$DB_PASSWORD --skip-ssl"

echo "[microweber-init] Waiting for MySQL..."
for i in $(seq 1 30); do
    if mysqladmin ping $MYSQL_OPTS --silent 2>/dev/null; then
        echo "[microweber-init] MySQL is ready."
        break
    fi
    echo "[microweber-init] Waiting for MySQL... ($i/30)"
    sleep 2
done

# Configure .env for Laravel
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || true
fi

if [ -f .env ]; then
    sed -i "s|DB_HOST=.*|DB_HOST=${DB_HOST}|" .env
    sed -i "s|DB_PORT=.*|DB_PORT=${DB_PORT}|" .env
    sed -i "s|DB_DATABASE=.*|DB_DATABASE=${DB_DATABASE}|" .env
    sed -i "s|DB_USERNAME=.*|DB_USERNAME=${DB_USERNAME}|" .env
    sed -i "s|DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" .env
    sed -i "s|DB_CONNECTION=.*|DB_CONNECTION=mysql|" .env
fi

chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache /var/www/html/config && \
chmod -R 775 /var/www/html/config

# Check if already installed
TABLE_COUNT=$(mysql $MYSQL_OPTS "$DB_DATABASE" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_DATABASE';" 2>/dev/null || echo "0")

if [ "$TABLE_COUNT" -lt "5" ] || [ ! -f /var/www/html/config/local/microweber.php ]; then
    echo "[microweber-init] Fresh install — starting Apache in background for web installer..."
    apache2-foreground &
    APACHE_PID=$!

    # Wait for Apache to be ready
    for i in $(seq 1 30); do
        if curl -sf http://localhost:8080/ > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    echo "[microweber-init] Running web installer..."
    /var/www/html/install.sh
    INSTALL_RESULT=$?
    echo "[microweber-init] install.sh exit code: ${INSTALL_RESULT}"

    # Fix config file permissions after installation
    chown -R www-data:www-data /var/www/html/config && \
    chmod -R 755 /var/www/html/config

    # Check if DB needs to be migrated
    sleep 2
    TABLE_COUNT=$(mysql $MYSQL_OPTS "$DB_DATABASE" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_DATABASE';" 2>/dev/null || echo "0")

    if [ "$TABLE_COUNT" -lt "5" ]; then
        echo "[microweber-init] Database not initialized (${TABLE_COUNT} tables). Running migrations..."
        cd /var/www/html
        php artisan migrate --force 2>&1 | head -50
        TABLE_COUNT=$(mysql $MYSQL_OPTS "$DB_DATABASE" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_DATABASE';" 2>/dev/null || echo "0")
        echo "[microweber-init] After migration: ${TABLE_COUNT} tables"
    fi

    # Create admin user if not exists
    ADMIN_HASH=$(php -r "echo password_hash('${ADMIN_PASS}', PASSWORD_BCRYPT);")
    ADMIN_COUNT=$(mysql $MYSQL_OPTS "$DB_DATABASE" -N -e "SELECT COUNT(*) FROM ${DB_PREFIX}users WHERE is_admin=1;" 2>/dev/null || echo "0")
    if [ "$ADMIN_COUNT" -lt "1" ]; then
        echo "[microweber-init] Creating admin user..."
        mysql $MYSQL_OPTS "$DB_DATABASE" -e "INSERT INTO ${DB_PREFIX}users (username, email, password, is_admin, is_active, is_verified, created_at) VALUES ('${ADMIN_USER}', '${ADMIN_EMAIL}', '${ADMIN_HASH}', 1, 1, 1, NOW());" 2>/dev/null
    fi

    echo "[microweber-init] Microweber installed successfully (${ADMIN_USER}/${ADMIN_PASS})"

    # Stop background Apache and restart in foreground
    kill $APACHE_PID 2>/dev/null
    wait $APACHE_PID 2>/dev/null || true
    sleep 1
else
    echo "[microweber-init] Database already initialized ($TABLE_COUNT tables found)."
fi

echo "[microweber-init] Starting Apache..."
exec apache2-foreground
