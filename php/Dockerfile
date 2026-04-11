FROM php:8.2-fpm

# ── System dependencies ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpng-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libonig-dev \
    libxml2-dev \
    libzip-dev \
    libicu-dev \
    libcurl4-openssl-dev \
    zip \
    unzip \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── PHP extensions ─────────────────────────────────────────────────────────
RUN docker-php-ext-configure gd \
        --with-freetype \
        --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        gd \
        mysqli \
        pdo \
        pdo_mysql \
        intl \
        zip \
        bcmath \
        opcache \
        mbstring \
        xml \
        curl \
    && pecl install redis \
    && docker-php-ext-enable redis

# ── Composer ────────────────────────────────────────────────────────────────
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# ── Non-root user (security) ────────────────────────────────────────────────
RUN groupadd -g 1000 appgroup \
    && useradd -u 1000 -g appgroup -ms /bin/bash appuser

# ── Working directory ────────────────────────────────────────────────────────
WORKDIR /var/www/html

# ── Healthcheck ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD php-fpm -t || exit 1

USER appuser
