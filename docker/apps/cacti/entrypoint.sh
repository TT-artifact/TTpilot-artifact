#!/usr/bin/env bash
set -euo pipefail

DB_NAME="cacti"
DB_USER="cactiuser"
DB_PASS="cactiuser"

mkdir -p /var/lib/mysql /var/run/mysqld
chown -R mysql:mysql /var/lib/mysql /var/run/mysqld

if [ ! -d /var/lib/mysql/mysql ]; then
    echo "[cacti-init] Initializing MariaDB data directory..."
    mariadb-install-db --user=mysql --datadir=/var/lib/mysql >/dev/null
fi

mysqld_safe --datadir=/var/lib/mysql &

echo "[cacti-init] Waiting for MariaDB..."
for i in $(seq 1 30); do
    if mysqladmin ping --silent 2>/dev/null; then
        echo "[cacti-init] MariaDB is ready."
        break
    fi
    echo "[cacti-init] Waiting for MariaDB... ($i/30)"
    sleep 2
done

if ! mysql -e "USE ${DB_NAME}" >/dev/null 2>&1; then
    echo "[cacti-init] Creating database and importing schema..."
    mysql -e "CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
    mysql -e "GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';"
    mysql -e "GRANT SELECT ON mysql.time_zone_name TO '${DB_USER}'@'localhost';"
    mysql -e "FLUSH PRIVILEGES;"
    mysql "${DB_NAME}" < /var/www/html/cacti.sql

    cp /var/www/html/include/config.php.dist /var/www/html/include/config.php
    sed -i "s/\$database_default[[:space:]]*=.*/\$database_default = '${DB_NAME}';/" /var/www/html/include/config.php
    # 'localhost' forces PDO into unix-socket mode, but PHP's pdo_mysql has no
    # default_socket configured and doesn't read /etc/mysql/*.cnf like the
    # mysql CLI does, so it looks in the wrong place and fails with
    # SQLSTATE[HY000] [2002]. Force TCP instead.
    sed -i "s/\$database_hostname[[:space:]]*=.*/\$database_hostname = '127.0.0.1';/" /var/www/html/include/config.php
    sed -i "s/\$database_username[[:space:]]*=.*/\$database_username = '${DB_USER}';/" /var/www/html/include/config.php
    sed -i "s/\$database_password[[:space:]]*=.*/\$database_password = '${DB_PASS}';/" /var/www/html/include/config.php
    # We serve Cacti at the site root, not under a /cacti/ alias.
    sed -i "s#\\\$url_path = '/cacti/';#\\\$url_path = '/';#" /var/www/html/include/config.php

    cd /var/www/html
    # --profile expects a data_source_profiles.id (int), not a name; 1 = the
    # "5 Minute Collection" profile that ships in cacti.sql by default.
    php cli/install_cacti.php --accept-eula --install --profile=1 || echo "[cacti-init] CLI installer returned non-zero; continuing with raw schema import."

    # Default admin ships with must_change_password='on', which would block the
    # crawler's form-based login — reset to the known default hash (md5("admin"))
    # and clear that flag so admin/admin logs straight in.
    mysql "${DB_NAME}" -e "UPDATE user_auth SET password='21232f297a57a5a743894a0e4a801fc3', must_change_password='' WHERE username='admin';"
fi

chown -R www-data:www-data /var/www/html
chmod -R 755 /var/www/html
chmod -R 775 /var/www/html/log /var/www/html/resource /var/www/html/cache 2>/dev/null || true

exec apache2-foreground
