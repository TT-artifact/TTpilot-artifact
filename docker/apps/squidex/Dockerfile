FROM mcr.microsoft.com/dotnet/sdk:7.0 AS backend-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
ARG BRANCH=7.8.2
RUN git clone --branch "${BRANCH}" --depth 1 https://github.com/Squidex/squidex.git /src

RUN dotnet publish backend/src/Squidex/Squidex.csproj -c Release -o /app/publish

FROM squidex/frontend-build:18.10 AS frontend-builder

WORKDIR /src
COPY --from=backend-builder /src/frontend /src/frontend
WORKDIR /src/frontend
RUN npm install --force
# Declares the TT runtime helpers (classifyPolicy, __ttJQueryArg, ...) the sink
# patcher injects into source, which only exist as browser globals at runtime —
# without this, `ng build`'s type-checker fails on the patched .ts files.
COPY tt-globals.d.ts /src/frontend/src/tt-globals.d.ts
# The patcher's receiver-identity duck-typing wrapper (e.g. checking __r.jquery
# / __r.toArray to tell jQuery.append from FormData.append) assumes __r is
# untyped; TS infers a concrete type from the call site instead, so those
# property probes fail to compile. "__r" is a patcher-only placeholder name
# (double-underscore convention), never real Squidex code, so this is safe.
RUN grep -rl '(__r) =>' src --include='*.ts' | xargs -r sed -i 's/(__r) =>/(__r: any) =>/g'
RUN npm run build

FROM mcr.microsoft.com/dotnet/aspnet:7.0-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    && curl -fsSL https://www.mongodb.org/static/pgp/server-6.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-6.0.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg] http://repo.mongodb.org/apt/debian bullseye/mongodb-org/6.0 main" > /etc/apt/sources.list.d/mongodb-org-6.0.list && \
    apt-get update && apt-get install -y --no-install-recommends mongodb-org-server && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-builder /app/publish /app
# Angular build output; Squidex serves it from wwwroot/build (kept separate from
# wwwroot/scripts, where editor-sdk.js / editor-editorjs.html live as static source).
COPY --from=frontend-builder /src/frontend/build /app/wwwroot/build

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && mkdir -p /data/db

ENV ASPNETCORE_URLS=http://+:8080 \
    STORE__MONGODB__CONFIGURATION=mongodb://localhost \
    EVENTSTORE__MONGODB__CONFIGURATION=mongodb://localhost \
    ASSETSTORE__MONGODB__CONFIGURATION=mongodb://localhost \
    IDENTITY__ADMINEMAIL=admin@example.com \
    IDENTITY__ADMINPASSWORD=adminPass123! \
    IDENTITY__ADMINRECREATE=true \
    URLS__BASEURL=http://localhost:8080/

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=12 \
    CMD curl --fail http://localhost:8080/scripts/editor-editorjs.html || exit 1

ENTRYPOINT ["/entrypoint.sh"]
