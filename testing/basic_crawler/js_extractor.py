import re
from urllib.parse import urlparse, urljoin
from playwright.sync_api import Page
import requests

def _is_valid_link(url: str, base_url: str) -> bool:

    try:
        parsed = urlparse(url)
        path = parsed.path.lower()
        full_url_lower = url.lower()
        full_path = parsed.path + (parsed.fragment or "")

        bad_patterns = [
            '/src/', '/dist/', '/node_modules/', '/.next/', '/.vite/',
            '/test/', '/tests/', '/spec/',
            '.js.map', '.css.map', '.webpack', 'sourcemap',
            '/Umbraco.Web.UI.Client/',
        ]
        if any(pattern in full_url_lower for pattern in bad_patterns):
            return False

        if any(path.endswith(ext) for ext in [
            '.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.svg',
            '.woff', '.woff2', '.ttf', '.eot', '.ico', '.webp', '.html'
        ]):

            if '#' not in url:
                return False

        if len(full_path.strip('/#')) < 1:
            return False

        if ':' in path and not any(c.isdigit() for c in path):
            return False

        return True
    except Exception:
        return False

def extract_spa_links(page: Page) -> list[str]:

    try:
        links = page.evaluate(
            """
            () => {
              const links = new Set();


              try {
                document.querySelectorAll('a[href*="#/"], a[href*="#!/"]').forEach(el => {
                  if (el.href && !el.href.includes('/src/')) links.add(el.href);
                });
              } catch(e) {}

              try {
                document.querySelectorAll('[ui-sref]').forEach(el => {
                  if (el.href && !el.href.includes('/src/')) links.add(el.href);
                });
              } catch(e) {}

              if (window.angular) {
                try {
                  const elems = document.querySelectorAll('[ng-app], [data-ng-app]');
                  elems.forEach(el => {
                    try {
                      const $injector = angular.element(el).injector();
                      if (!$injector) return;

                      try {
                        const $route = $injector.get('$route');
                        const routes = $route.routes || {};
                        Object.keys(routes).forEach(path => {
                          if (path && path.length > 1 && !path.includes(':')
                              && path !== '/' && path !== 'null'
                              && !path.includes('/src') && !path.includes('/lib')) {
                            const url = window.location.origin
                              + window.location.pathname
                              + '#' + path;
                            links.add(url);
                          }
                        });
                      } catch(e) {}

                      try {
                        const $state = $injector.get('$state');
                        const states = $state.get() || [];
                        states.forEach(state => {
                          if (state && state.url && !state.abstract && state.url !== '/'
                              && !state.url.includes('/src') && !state.url.includes('/lib')) {
                            const resolved = state.url
                              .replace(/:[^/]+/g, ':id')
                              .replace(/{[^}]+}/g, 'id');
                            const url = window.location.origin
                              + window.location.pathname
                              + '#' + resolved;
                            links.add(url);
                          }
                        });
                      } catch(e) {}
                    } catch(e) {}
                  });
                } catch(e) {}
              }


              try {
                const selectors = [
                  'nav a',
                  '[role="navigation"] a',
                  '.sidebar a',
                  '#sidebar a',
                  '.menu a',
                  'header a',
                  '[data-testid*="nav"] a'
                ];
                selectors.forEach(sel => {
                  try {
                    document.querySelectorAll(sel).forEach(el => {
                      if (el.href && !el.href.includes('/src/') && !el.href.includes('/lib/')) links.add(el.href);
                    });
                  } catch(e) {}
                });
              } catch(e) {}

              try {
                const roots = [
                  document.getElementById('root'),
                  document.getElementById('app'),
                  document.querySelector('[data-reactroot]')
                ].filter(Boolean);

                roots.forEach(root => {
                  try {
                    const fiberKey = Object.keys(root).find(k =>
                      k.startsWith('__reactFiber')
                      || k.startsWith('__reactInternalInstance')
                    );
                    if (!fiberKey) return;

                    const visited = new WeakSet();
                    const queue = [root[fiberKey]];
                    let count = 0;

                    while (queue.length > 0 && count < 500) {
                      count++;
                      const node = queue.pop();
                      if (!node || visited.has(node)) continue;
                      visited.add(node);

                      try {
                        const to = node.memoizedProps?.to;
                        if (typeof to === 'string' && to.startsWith('/')
                            && !to.includes('/src/') && !to.includes('/lib/')) {
                          links.add(window.location.origin + to);
                        }
                      } catch(e) {}

                      if (node.child) queue.push(node.child);
                      if (node.sibling) queue.push(node.sibling);

                      if (links.size > 200) break;
                    }
                  } catch(e) {}
                });
              } catch(e) {}

              try {
                document.querySelectorAll('form[action]').forEach(form => {
                  const action = form.action;
                  if (action && !action.startsWith('javascript:') && !action.startsWith('mailto:')) {
                    links.add(action);
                  }
                });
              } catch(e) {}

              try {
                document.querySelectorAll('iframe[src], frame[src]').forEach(el => {
                  if (el.src) links.add(el.src);
                });
              } catch(e) {}

              try {
                document.querySelectorAll('link[rel~="prefetch"][href], link[rel~="prerender"][href], link[rel~="modulepreload"][href]').forEach(el => {
                  if (el.href) links.add(el.href);
                });
              } catch(e) {}

              try {
                document.querySelectorAll('meta[http-equiv="refresh"][content]').forEach(el => {
                  const m = el.content.match(/url=([^\\s;]+)/i);
                  if (m) {
                    try {
                      links.add(new URL(m[1], location.href).href);
                    } catch(e) {}
                  }
                });
              } catch(e) {}

              try {
                function collectShadowLinks(root) {
                  root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) {
                      el.shadowRoot.querySelectorAll('a[href]').forEach(a => {
                        if (a.href) links.add(a.href);
                      });
                      collectShadowLinks(el.shadowRoot);
                    }
                  });
                }
                collectShadowLinks(document);
              } catch(e) {}

              try {
                document.querySelectorAll('[data-url], [data-href], [data-route], [data-src]').forEach(el => {
                  const url = el.dataset.url || el.dataset.href || el.dataset.route || el.dataset.src;
                  if (url && url.startsWith('/')) {
                    try { links.add(new URL(url, location.href).href); } catch(e) {}
                  }
                });
              } catch(e) {}

              try {
                document.querySelectorAll('[onclick]').forEach(el => {
                  const handler = el.getAttribute('onclick') || '';
                  const matches = handler.match(/["']([^"']+)["']/g) || [];
                  matches.forEach(quoted => {
                    const path = quoted.slice(1, -1);
                    if (path.startsWith('/') && !path.includes('://')) {
                      try { links.add(new URL(path, location.href).href); } catch(e) {}
                    }
                  });
                });
              } catch(e) {}

              return Array.from(links);
            }
            """
        )
        base_url = page.url
        filtered = [url for url in (links or []) if _is_valid_link(url, base_url)]
        return filtered
    except Exception:

        return []

def extract_js_urls(page: Page, base_url: str) -> list[str]:

    try:
        scripts = page.eval_on_selector_all(
            "script:not([src])",
            "els => els.map(e => e.textContent)"
        )
        results = set()
        pattern = re.compile(r"""["'`](\/[a-zA-Z0-9_\-\/?=&#.]+)["'`]""")

        for content in scripts:
            if not content:
                continue
            for m in pattern.finditer(content):
                path = m.group(1)

                if len(path) < 3 or re.search(r'\.(js|css|jpg|png|svg|woff|map)$', path):
                    continue
                try:

                    parsed = urlparse(base_url)
                    origin = f"{parsed.scheme}://{parsed.netloc}"
                    full_url = origin + path
                    if _is_valid_link(full_url, base_url):
                        results.add(full_url)
                except Exception:
                    pass
        return list(results)
    except Exception:
        return []

def extract_hydration_routes(page: Page, base_url: str) -> list[str]:

    try:
        texts = page.eval_on_selector_all(
            "script#__NEXT_DATA__, script#__NUXT_DATA__, script[type='application/json']",
            "els => els.map(e => e.textContent)"
        )
        results = set()
        path_pattern = re.compile(r'"(\/[a-zA-Z0-9_\-\/?=&#.]+)"')

        for text in texts:
            if not text:
                continue
            for m in path_pattern.finditer(text):
                path = m.group(1)
                if len(path) >= 3:
                    full_url = urljoin(base_url, path)
                    if _is_valid_link(full_url, base_url):
                        results.add(full_url)
        return list(results)
    except Exception:
        return []

def fetch_seed_urls(base_url: str) -> list[str]:

    results = []

    try:
        robots_url = urljoin(base_url, "/robots.txt")
        r = requests.get(robots_url, timeout=5)
        if r.status_code == 200:
            for line in r.text.splitlines():
                m = re.match(r"(?:Allow|Disallow):\s*(/\S+)", line)
                if m:
                    path = m.group(1)
                    if not path.endswith("*"):
                        full_url = urljoin(base_url, path)
                        results.append(full_url)
    except Exception:
        pass

    def parse_sitemap(url: str, depth: int = 0) -> None:
        if depth > 2:
            return
        try:
            r = requests.get(url, timeout=5)
            if r.status_code != 200:
                return
            for m in re.finditer(r"<loc>(.*?)</loc>", r.text):
                loc = m.group(1).strip()
                if "sitemap" in loc.lower():
                    parse_sitemap(loc, depth + 1)
                else:
                    results.append(loc)
        except Exception:
            pass

    for path in ["/sitemap.xml", "/sitemap_index.xml"]:
        parse_sitemap(urljoin(base_url, path))

    return results

def inject_history_hook(page: Page) -> None:

    try:
        page.evaluate(
            """
            () => {
              if (window.__historyHookInstalled) return;
              window.__historyHookInstalled = true;
              window.__discoveredRoutes = [];

              const _push = history.pushState.bind(history);
              const _replace = history.replaceState.bind(history);

              history.pushState = function(state, title, url) {
                if (url) window.__discoveredRoutes.push(String(url));
                return _push(state, title, url);
              };

              history.replaceState = function(state, title, url) {
                if (url) window.__discoveredRoutes.push(String(url));
                return _replace(state, title, url);
              };
            }
            """
        )
    except Exception:
        pass

def drain_history_routes(page: Page, base_url: str) -> list[str]:

    try:
        routes = page.evaluate(
            """
            () => {
              const routes = window.__discoveredRoutes || [];
              window.__discoveredRoutes = [];
              return routes;
            }
            """
        )
        results = []
        for route in (routes or []):
            try:
                full_url = urljoin(base_url, route)
                if _is_valid_link(full_url, base_url):
                    results.append(full_url)
            except Exception:
                pass
        return results
    except Exception:
        return []
