FROM php:8.1-apache

RUN apt-get update && apt-get install -y \
    git unzip curl libzip-dev libicu-dev libgmp-dev default-mysql-client \
    libpng-dev libjpeg-dev libfreetype6-dev libwebp-dev \
    libonig-dev libexif-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install zip intl pdo pdo_mysql gd mbstring exif bcmath \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Apache: listen on 8080, enable rewrite
RUN sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf && \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf && \
    echo 'ServerName web' >> /etc/apache2/apache2.conf

RUN echo '<Directory /var/www/html>\n    AllowOverride All\n</Directory>' \
    >> /etc/apache2/sites-available/000-default.conf && \
    a2enmod rewrite

# Clone vulnerable version of Microweber (v1.3.1, CVE-2022-0698)
ARG BRANCH=v1.3.1
RUN git clone --depth=1 --branch ${BRANCH} \
    https://github.com/microweber/microweber.git /tmp/microweber

RUN rm -rf /var/www/html && mv /tmp/microweber /var/www/html

WORKDIR /var/www/html

# Configure composer and install dependencies
# 1. Use older composer (2.5) to avoid audit-blocking feature
# 2. Remove private/deleted dependency from both json and lock
# 3. Install from lockfile (no GitHub OAuth needed: all remaining packages are public)
RUN composer self-update 2.5.8 && \
    sed -i '/"ticketswap\/omnipay-przelewy24"/d' composer.json && \
    php -r "\$lock=json_decode(file_get_contents('composer.lock'),true); \
      \$lock['packages']=array_values(array_filter(\$lock['packages'],fn(\$p)=>\$p['name']!=='ticketswap/omnipay-przelewy24')); \
      file_put_contents('composer.lock',json_encode(\$lock,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));" && \
    COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --ignore-platform-reqs --no-scripts 2>&1

# Ensure required directories exist
RUN mkdir -p storage/framework/{sessions,views,cache} storage/logs bootstrap/cache

COPY init.sh /var/www/html/init.sh
COPY install.sh /var/www/html/install.sh
RUN chmod +x /var/www/html/init.sh /var/www/html/install.sh

RUN chown -R www-data:www-data /var/www/html && \
    chmod -R 755 /var/www/html && \
    chmod -R 775 storage bootstrap/cache

EXPOSE 8080
CMD ["/var/www/html/init.sh"]
