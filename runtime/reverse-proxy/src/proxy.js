#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const express = require("express");
const proxy = require("express-http-proxy");
const http = require("http");

const BOOTSTRAP_TAG = '<script src="/tt-bootstrap.js"></script>';

function getCspHeader(reportUrl) {
  return (
    "require-trusted-types-for 'script'; " +
    "trusted-types pass-thru monitor default sanitize tt-auto-wrap dompurify 'allow-duplicates'; "

  );
}

function shouldInject(html, userReq) {
  const dest = (userReq.headers["sec-fetch-dest"] || "").toLowerCase();
  if (dest && dest !== "empty") {

    return ["document", "iframe", "frame", "nested-document"].includes(dest);
  }

  if ((userReq.headers["x-requested-with"] || "").toLowerCase() === "xmlhttprequest") {
    return false;
  }

  return /<html[\s>]/i.test(html) || /<!doctype\s+html/i.test(html);
}

function injectBootstrap(html, requestPath) {
  if (html.includes("tt-bootstrap.js")) return html;

  const bom = html.charCodeAt(0) === 0xfeff ? "﻿" : "";
  if (bom) html = html.slice(1);

  const base = requestPath || "/";
  const baseTag = /<base\b/i.test(html) ? "" : `<base href="${base}">`;
  const inject = baseTag + BOOTSTRAP_TAG;

  const headOpen = html.match(/<head\b[^>]*>/i);
  if (headOpen) {
    const idx = headOpen.index + headOpen[0].length;
    return bom + html.slice(0, idx) + inject + html.slice(idx);
  }
  const htmlOpen = html.match(/<html\b[^>]*>/i);
  if (htmlOpen) {
    const idx = htmlOpen.index + htmlOpen[0].length;
    return bom + html.slice(0, idx) + inject + html.slice(idx);
  }
  return bom + inject + html;
}

async function main() {
  const program = new Command();
  program
    .name("tt-reverse-proxy")
    .requiredOption("--target <url>", "Target application URL")
    .option("--port <n>", "HTTP port", "8000")
    .requiredOption("--bootstrap <path>", "Path to tt-bootstrap.js file")
    .option(
      "--report-url <url>",
      "Report server URL",
      "http://localhost:9000/tt-report"
    )
    .option("--mock-homekit", "Return mock JSON for GET /api/homekit (triggers add.html sinks)")
    .parse(process.argv);

  const opts = program.opts();

  if (!fs.existsSync(opts.bootstrap)) {
    console.error(`tt-bootstrap.js not found: ${opts.bootstrap}`);
    process.exit(1);
  }

  const app = express();
  const cspHeader = getCspHeader(opts.reportUrl);

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "PUT, POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Security-Policy-Report-Only", cspHeader);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    if (req.path !== "/" && req.path.endsWith("/") && /\.[^/]+\/$/.test(req.path)) {
      const canonical = req.path.slice(0, -1) + req.url.slice(req.path.length);
      return res.redirect(301, canonical);
    }
    next();
  });

  app.get("/tt-bootstrap.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.sendFile(path.resolve(opts.bootstrap));
  });

  if (opts.mockHomekit) {
    app.get("/api/homekit", (req, res) => {
      res.json({
        sources: [
          {
            id: "mock-cam-1",
            name: "Mock HomeKit Camera",
            info: "category=17 status=1 paired=false",
            url: "homekit://mock-device-1",
            location: "192.168.1.100:51826",
          },
          {
            id: "mock-cam-2",
            name: "Mock HomeKit Doorbell",
            info: "category=18 status=2 paired=true",
            url: "homekit://mock-device-2",
            location: "192.168.1.101:51826",
          },
        ],
      });
    });
  }

  app.use(
    "/",
    proxy(opts.target, {

      proxyReqOptDecorator(proxyReqOpts, srcReq) {
        delete proxyReqOpts.headers["accept-encoding"];
        const externalHost = srcReq.headers.host || `localhost:${opts.port}`;
        proxyReqOpts.headers["host"] = externalHost;
        return proxyReqOpts;
      },

      userResHeaderDecorator(headers, userReq) {

        delete headers.connection;
        delete headers["keep-alive"];
        if (headers.location) {
          const externalHost = userReq.headers.host || `localhost:${opts.port}`;

          if (/^https?:\/\//.test(headers.location)) {
            headers.location = headers.location.replace(
              /^https?:\/\/[^/]*/,
              `http://${externalHost}`
            );
          }

          if (headers.location !== "/" && headers.location.endsWith("/") && /\.[^/]+\/$/.test(headers.location)) {
            headers.location = headers.location.slice(0, -1);
          }
        }
        return headers;
      },

      userResDecorator(proxyRes, proxyResData, userReq, userRes) {

        const send = (body) => {
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
          userRes.setHeader("Content-Length", String(buf.length));
          userRes.removeHeader("Transfer-Encoding");
          return buf;
        };

        const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("text/html")) {

          userRes.setHeader("Cache-Control", "no-store");
          try {
            let html = proxyResData.toString("utf8");

            const externalHost = userReq.headers.host || `localhost:${opts.port}`;
            const targetUrl = new URL(opts.target);
            const internalHost = `${targetUrl.hostname}:${targetUrl.port || 80}`;

            html = html.replace(/https?:\/\/app:(\d+)/g, `http://${externalHost}`);

            html = html.replace(new RegExp(`https?://${internalHost}`, 'g'), `http://${externalHost}`);

            if (shouldInject(html, userReq)) {
              return send(injectBootstrap(html, userReq.originalUrl));
            }
            return send(html);
          } catch (err) {
            console.error("Failed to inject bootstrap:", err.message);
            return send(proxyResData);
          }
        }
        return send(proxyResData);
      },
    })
  );

  const server = http.createServer(app);

  server.on("upgrade", (req, socket, head) => {
    const targetUrl = new URL(opts.target);
    const isHttps = targetUrl.protocol === "https:";
    const targetPort = targetUrl.port || (isHttps ? 443 : 80);

    const proxyReq = (isHttps ? require("https") : http).request(
      {
        host: targetUrl.hostname,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,

          ...(req.headers.origin ? { origin: `${targetUrl.protocol}//${targetUrl.host}` } : {}),
        },
      },
      (proxyRes) => {

        let header = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          header += `${key}: ${value}\r\n`;
        });
        header += "\r\n";
        socket.write(header);
        proxyRes.pipe(socket);
      }
    );

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {

      let header = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        header += `${key}: ${value}\r\n`;
      });
      header += "\r\n";
      socket.write(header);
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy request error:", err);
      socket.end();
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });

    proxyReq.end(head);
  });

  server.listen(Number(opts.port), "0.0.0.0", () => {
    console.log(`tt-reverse-proxy: port ${opts.port} -> ${opts.target}`);
    console.log(`                  bootstrap ${opts.bootstrap}`);
    console.log(`                  report-url ${opts.reportUrl}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { injectBootstrap };
