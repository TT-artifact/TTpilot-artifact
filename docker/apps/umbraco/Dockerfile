FROM mcr.microsoft.com/dotnet/sdk:7.0 AS builder

# Install Node 18 (needed for frontend build)
RUN apt-get update && apt-get install -y git curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Clone vulnerable Umbraco source
ARG BRANCH=release-12.3.0
RUN git clone --branch ${BRANCH} \
    https://github.com/umbraco/Umbraco-CMS.git /src

WORKDIR /src

# Build the BackOffice frontend (AngularJS)
WORKDIR /src/src/Umbraco.Web.UI.Client
RUN npm install --no-fund --no-audit 2>&1

# Patch gulp-imagemin (ESM incompatibility with gulp 4 / CJS)
RUN printf '%s\n' \
  "var through = require('through2');" \
  "var fn = function() { return through.obj(); };" \
  "fn.gifsicle = function() { return null; };" \
  "fn.mozjpeg = function() { return null; };" \
  "fn.optipng = function() { return null; };" \
  "fn.svgo = function() { return null; };" \
  "module.exports = fn;" \
  > node_modules/gulp-imagemin/index.js

# Disable ESLint
RUN node -e "var fs=require('fs'),c=require('./gulp/config');c.compile.build.lint=false;fs.writeFileSync('./gulp/config.js','module.exports='+JSON.stringify(c,null,2)+';')"

RUN npm run build:skip-tests

# Build the .NET application
WORKDIR /src
RUN git config --global user.email "build@local" && git config --global user.name "Build" && git add -A && git commit -m "build" --quiet || true
RUN dotnet restore src/Umbraco.Web.UI/Umbraco.Web.UI.csproj
RUN dotnet publish src/Umbraco.Web.UI/Umbraco.Web.UI.csproj -c Release -o /app --no-restore

# Configure for SQLite (no external DB needed)
RUN echo '{ \
  "ConnectionStrings": { "umbracoDbDSN": "Data Source=|DataDirectory|/Umbraco.sqlite.db;Cache=Shared;Foreign Keys=True;Pooling=True", "umbracoDbDSN_ProviderName": "Microsoft.Data.Sqlite" }, \
  "Umbraco": { "CMS": { "Unattended": { "InstallUnattended": true, "UnattendedUserName": "Admin", "UnattendedUserPassword": "adminpassword1!", "UnattendedUserEmail": "admin@example.com" }, "Global": { "InstallMissingDatabase": true } } } \
}' > /app/appsettings.json

# Runtime
FROM mcr.microsoft.com/dotnet/aspnet:7.0

WORKDIR /app
COPY --from=builder /app .

ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Development

EXPOSE 8080
ENTRYPOINT ["dotnet", "Umbraco.Web.UI.dll"]
