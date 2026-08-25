FROM php:7.4-apache

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    default-mysql-client \
    mariadb-server \
    libgd-dev \
    libgmp-dev \
    libicu-dev \
    libldap2-dev \
    libsnmp-dev \
    libonig-dev \
    snmp \
    rrdtool \
    && rm -rf /var/lib/apt/lists/*

RUN docker-php-ext-configure gd --with-freetype --with-jpeg && \
    docker-php-ext-configure ldap --with-libdir=lib/x86_64-linux-gnu && \
    docker-php-ext-install -j"$(nproc)" \
        gd gmp intl ldap mbstring mysqli pdo pdo_mysql pcntl sockets snmp

# Apache: listen on 8080 so it matches the reverse-proxy convention used
# throughout this repo's targets (host port is decided by the proxy, not here).
RUN sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf && \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf && \
    echo 'ServerName web' >> /etc/apache2/apache2.conf && \
    a2enmod rewrite

ARG BRANCH=release/1.2.25
RUN git clone --branch "${BRANCH}" --depth 1 https://github.com/Cacti/cacti.git /tmp/cacti

RUN rm -rf /var/www/html && mv /tmp/cacti /var/www/html

WORKDIR /var/www/html

COPY my-cacti.cnf /etc/mysql/mariadb.conf.d/99-cacti.cnf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=90s --retries=12 \
    CMD curl --fail http://localhost:8080/index.php || exit 1

ENTRYPOINT ["/entrypoint.sh"]
