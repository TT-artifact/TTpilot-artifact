#!/bin/bash
set -e

plugin_slug="${WORDPRESS_PLUGIN_SLUG:-elementor}"

# MySQL's healthcheck can report healthy during its brief internal restart on
# first-time initialization, right before it's actually ready to accept
# connections — wait it out here instead of letting a transient "Connection
# refused" from the first `wp` command kill the container (set -e above).
echo "[elementor-init] Waiting for MySQL..."
for i in $(seq 1 30); do
    if mysqladmin ping -h "$WORDPRESS_DB_HOST" -u "$WORDPRESS_DB_USER" -p"$WORDPRESS_DB_PASSWORD" --skip-ssl --silent 2>/dev/null; then
        echo "[elementor-init] MySQL is ready."
        break
    fi
    echo "[elementor-init] Waiting for MySQL... ($i/30)"
    sleep 2
done

if [ ! -f wp-config.php ]; then
  wp config create \
    --dbname="$WORDPRESS_DB_NAME" \
    --dbuser="$WORDPRESS_DB_USER" \
    --dbpass="$WORDPRESS_DB_PASSWORD" \
    --dbhost="$WORDPRESS_DB_HOST" \
    --allow-root
fi

# Without this, WP_Scripts/Elementor's get_assets_url() append '.min' to every
# enqueued script by default (module.php's $is_test_mode check), so the browser
# loads e.g. dialog.min.js / frontend.min.js instead of the TT-patched
# dialog.js / frontend.js — the sink instrumentation never executes and CVE
# PoCs that route through those files can't be detected/blocked at all.
if ! grep -q "SCRIPT_DEBUG" wp-config.php; then
  wp config set SCRIPT_DEBUG true --raw --type=constant --allow-root
fi

if ! wp core is-installed --allow-root; then
  wp core install \
    --url="$WORDPRESS_SITE_URL" \
    --title="My Site" \
    --admin_user="admin" \
    --admin_password="adminpass" \
    --admin_email="admin@example.com" \
    --skip-email \
    --allow-root

  if ! grep -q "WP_AUTO_UPDATE_CORE" wp-config.php; then
    echo "define('WP_AUTO_UPDATE_CORE', false);" >> wp-config.php
  fi

  # Activate the app-specific plugin when available.
  if wp plugin is-installed "$plugin_slug" --allow-root; then
    wp plugin activate "$plugin_slug" --allow-root
  else
    echo "Plugin '$plugin_slug' is not installed; skipping activation."
  fi

  # Create an Elementor-built page so that elementor-frontend.min.js loads on the frontend.
  # Without this page, the lightbox hash handler (#elementor-action:...) never registers,
  # and CVE-2021-24891 / CVE-2022-29455 payloads cannot trigger.
  if [ "$plugin_slug" = "elementor" ]; then
    echo "Creating Elementor page for CVE trigger..."
    PAGE_ID=$(wp post create --post_type=page --post_title="Elementor Page" \
      --post_status=publish --porcelain --allow-root)
    if [ -n "$PAGE_ID" ]; then
      wp post meta update "$PAGE_ID" _elementor_edit_mode builder --allow-root
      wp post meta update "$PAGE_ID" _elementor_version "3.4.7" --allow-root
      wp post meta update "$PAGE_ID" _elementor_data \
        '[{"id":"a1","elType":"section","settings":{},"elements":[{"id":"b1","elType":"column","settings":{"_column_size":100},"elements":[{"id":"c1","elType":"widget","settings":{"title":"Test"},"elements":[],"widgetType":"heading"}]}]}]' \
        --allow-root
      # _elementor_page_settings must be a serialized PHP array, not a literal string.
      # Use wp eval to set it properly to avoid Elementor sanitize_settings() type error.
      wp eval "update_post_meta($PAGE_ID, '_elementor_page_settings', array());" --allow-root
      # Set this page as the front page so payloads work on /
      wp option update show_on_front page --allow-root
      wp option update page_on_front "$PAGE_ID" --allow-root
      echo "Elementor page created (ID=$PAGE_ID) and set as front page."
    fi
  fi
fi

# Keep URL settings in sync when host port/domain changes between runs.
if wp core is-installed --allow-root; then
  wp option update home "$WORDPRESS_SITE_URL" --allow-root
  wp option update siteurl "$WORDPRESS_SITE_URL" --allow-root
fi

exec apache2-foreground