FROM php:7.4-apache

RUN docker-php-ext-install mysqli

RUN apt-get update && apt-get install -y wget vim curl git unzip default-mysql-client

RUN curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar && \
    chmod +x wp-cli.phar && \
    mv wp-cli.phar /usr/local/bin/wp

RUN sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf && \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf

RUN echo 'ServerName web' >> /etc/apache2/apache2.conf

WORKDIR /var/www/html
ARG BRANCH=5.8.1
RUN git clone --branch ${BRANCH} https://github.com/WordPress/WordPress.git /var/www/html
RUN wget https://downloads.wordpress.org/plugin/elementor.3.4.7.zip -O /var/www/html/wp-content/plugins/elementor.zip && \
    unzip /var/www/html/wp-content/plugins/elementor.zip -d /var/www/html/wp-content/plugins/ && \
    rm /var/www/html/wp-content/plugins/elementor.zip
RUN chown www-data:www-data /var/www/html -R
RUN chmod 755 /var/www/html -R

WORKDIR /var/www/html
ENV WORDPRESS_PLUGIN_SLUG=elementor

COPY init.sh /var/www/html/init.sh
RUN chmod +x /var/www/html/init.sh

# Expose the default port
EXPOSE 8080

# Run the application
# ENTRYPOINT ["/usr/sbin/apache2ctl", "-D", "FOREGROUND"]
ENTRYPOINT ["/var/www/html/init.sh"]
