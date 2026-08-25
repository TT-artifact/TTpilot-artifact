(function() {

    if (window.__TT_POLICY_INITIALIZED__) {
        return;
    }

    const VERDICTS = {
        NOTYPE: 'NO_VIOLATION',
        TYPE1: 'TYPE1',
        TYPE2: 'TYPE2',
        TYPE3: 'TYPE3',
        TYPE4: 'TYPE4',
        TYPE5: 'TYPE5',
    };

    const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/;
    const BASE64_URL_REGEX = /^[A-Za-z0-9\-_]+=*$/;
    const HTML_TAG_REGEX = /<[a-zA-Z!?/]/;

    const POLICY_REPORT_URL = "__TT_REPORT_URL__";
    const ALLOWED_URLS = __ALLOWED_URLS__;
    const ALLOWED_SCRIPTS = __ALLOWED_SCRIPTS__;

    const MIN_LEN = 8;

    let _sourceValuesCache = null;
    function getSourceValues() {
        if (_sourceValuesCache === null) {
            _sourceValuesCache = collectSourceValues();
        }
        return _sourceValuesCache;
    }

    function _extractStringFields(obj, pathPrefix, sources, depth) {
        if (depth > 4 || sources.length > 500) return;
        if (typeof obj === 'string') {
            if (obj.length >= MIN_LEN) sources.push({ type: pathPrefix, value: obj });
        } else if (Array.isArray(obj)) {
            obj.slice(0, 50).forEach((item, i) =>
                _extractStringFields(item, `${pathPrefix}[${i}]`, sources, depth + 1));
        } else if (obj && typeof obj === 'object') {
            for (const key in obj) _extractStringFields(obj[key], `${pathPrefix}.${key}`, sources, depth + 1);
        }
    }

    const _postMessageBuffer = [];
    window.addEventListener('message', function(e) {
        const d = e.data;
        if (typeof d === 'string' && d.length >= 4) {
            _postMessageBuffer.push(d);
            if (_postMessageBuffer.length > 50) _postMessageBuffer.shift();
            _sourceValuesCache = null;
        } else if (d && typeof d === 'object') {
            try {
                const s = JSON.stringify(d);
                if (s.length >= 4) {
                    _postMessageBuffer.push(s);
                    if (_postMessageBuffer.length > 50) _postMessageBuffer.shift();
                    _sourceValuesCache = null;
                }
            } catch {}
        }
    }, true);

    const _xhrResponseBuffer = [];
    const XHR_BUFFER_MAX = 20;
    const XHR_BODY_MAX_LEN = 200000;

    function _pushXhrSource(text, contentType) {
        if (!text || text.length < 4 || text.length > XHR_BODY_MAX_LEN) return;

        if (/^(image|video|font)\/|application\/(wasm|octet-stream|pdf|zip|gzip)/i.test(contentType || '')) return;

        if (/text\/html/i.test(contentType || '') && !/<html[\s>]/i.test(text)) return;
        _xhrResponseBuffer.push(text);
        if (_xhrResponseBuffer.length > XHR_BUFFER_MAX) _xhrResponseBuffer.shift();
        _sourceValuesCache = null;
    }

    try {
        const _origFetch = window.fetch;
        if (_origFetch) {

            window.fetch = async function(...args) {
                const res = await _origFetch.apply(this, args);
                try {
                    const text = await res.clone().text();
                    _pushXhrSource(text, res.headers.get('content-type'));
                } catch {}
                return res;
            };
        }
    } catch {}

    try {

        const _origXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(...args) {
            this.addEventListener('load', function() {
                try { _pushXhrSource(this.responseText, this.getResponseHeader('content-type')); }
                catch {}
            });
            return _origXhrOpen.apply(this, args);
        };
    } catch {}

    const _encodeVariantsCache = new Map();
    function getEncodeVariants(value) {
        if (!_encodeVariantsCache.has(value)) {
            _encodeVariantsCache.set(value, encodeVariants(value));

            if (_encodeVariantsCache.size > 100) {
                const firstKey = _encodeVariantsCache.keys().next().value;
                _encodeVariantsCache.delete(firstKey);
            }
        }
        return _encodeVariantsCache.get(value);
    }

    function collectSourceValues() {
        const sources = [];

        try {
            new URLSearchParams(location.search).forEach((val, key) => {
                if (val.length >= MIN_LEN) sources.push({ type: `url-query:${key}`, value: val });
            });
        } catch {}

        try {
            const hash = decodeURIComponent(location.hash.slice(1));
            if (hash.length >= MIN_LEN) sources.push({ type: 'url-fragment', value: hash });

            try {
                const jsonStart = hash.search(/[{[]/);
                if (jsonStart >= 0) {
                    const parsed = JSON.parse(hash.slice(jsonStart));
                    if (typeof parsed === 'object' && parsed !== null) {
                        _extractStringFields(parsed, 'url-fragment-json', sources, 0);
                    }
                }
            } catch {}

            try {
                hash.split('&').forEach(part => {
                    const idx = part.indexOf('=');
                    if (idx < 0) return;
                    const key = decodeURIComponent(part.slice(0, idx));
                    const val = decodeURIComponent(part.slice(idx + 1));
                    if (val.length >= MIN_LEN) sources.push({ type: `url-fragment:${key}`, value: val });

                    try {
                        if (BASE64_REGEX.test(val)) {
                            const decoded = atob(val);
                            const parsed = JSON.parse(decoded);
                            if (typeof parsed === 'object' && parsed !== null) {
                                for (const nestedKey in parsed) {
                                    const nestedVal = parsed[nestedKey];
                                    if (typeof nestedVal === 'string' && nestedVal.length >= MIN_LEN) {
                                        sources.push({ type: `url-fragment:${key}:${nestedKey}`, value: nestedVal });
                                    }
                                }
                            }
                        }
                    } catch {}
                });
            } catch {}
        } catch {}

        try {
            document.cookie.split(';').forEach(part => {
                const idx = part.indexOf('=');
                if (idx < 0) return;
                const key = part.slice(0, idx).trim();
                const val = decodeURIComponent(part.slice(idx + 1).trim());
                if (val.length >= MIN_LEN) sources.push({ type: `cookie:${key}`, value: val });
            });
        } catch {}

        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (val && val.length >= MIN_LEN) sources.push({ type: `localStorage:${key}`, value: val });
            }
        } catch {}

        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);

                if (key && key.startsWith('ttjs:')) continue;
                const val = sessionStorage.getItem(key);
                if (val && val.length >= MIN_LEN) sources.push({ type: `sessionStorage:${key}`, value: val });
            }
        } catch {}

        _postMessageBuffer.forEach((val, i) => {
            sources.push({ type: `postmessage:${i}`, value: val });

            try {
                const parsed = JSON.parse(val);
                if (parsed && typeof parsed === 'object') {
                    _extractStringFields(parsed, `postmessage:${i}`, sources, 0);
                }
            } catch {}
        });

        _xhrResponseBuffer.forEach((text, i) => {
            if (text.length >= MIN_LEN) sources.push({ type: `xhr-response:${i}`, value: text });
            try {
                _extractStringFields(JSON.parse(text), `xhr-response:${i}`, sources, 0);
            } catch {}
        });

        return sources;
    }

    function encodeVariants(value) {
        const variants = new Set([value]);

        try { const enc = encodeURIComponent(value); if (enc !== value) variants.add(enc); } catch {}
        try { const dec = decodeURIComponent(value); if (dec !== value) variants.add(dec); } catch {}

        try {
            const enc = encodeURIComponent(value);
            const double = encodeURIComponent(enc);
            if (double !== enc) variants.add(double);
        } catch {}

        try {
            const b64 = btoa(unescape(encodeURIComponent(value)));
            variants.add(b64);
            variants.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
        } catch {}
        try { variants.add(btoa(value)); } catch {}

        if (BASE64_REGEX.test(value)) {
            let dec = null;
            try {
                dec = atob(value);
                if (dec !== value) variants.add(dec);
            } catch {}

            if (dec) {
                try {
                    const decoded = decodeURIComponent(escape(dec));
                    if (decoded !== value) variants.add(decoded);
                } catch {}
                try {
                    const parsed = JSON.parse(dec);
                    if (typeof parsed === 'object' && parsed !== null) {
                        for (const key in parsed) {
                            const val = parsed[key];
                            if (typeof val === 'string' && val.length >= 4 && val !== value && val !== dec)
                                variants.add(val);
                        }
                    }
                } catch {}
            }
        }

        if (BASE64_URL_REGEX.test(value)) {
            try {
                const standard = value.replace(/-/g, '+').replace(/_/g, '/');
                const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
                const dec = decodeURIComponent(escape(atob(padded)));
                if (dec !== value) variants.add(dec);
            } catch {}
        }

        try {
            const unescaped = value.replace(/\\(.)/g, '$1');
            if (unescaped !== value) variants.add(unescaped);
        } catch {}

        return [...variants].filter(v => v.length >= 4);
    }

    function checkXssSources(input) {
        const s = String(input);
        const reasons = [];
        const matched = [];
        for (const src of getSourceValues()) {
            const variants = getEncodeVariants(src.value);

            const fwdMatch = variants.find(v => s.includes(v));
            if (fwdMatch !== undefined) {
                reasons.push(`xss-source:${src.type}`);
                matched.push({
                    type: src.type,
                    value: _truncatePreview(src.value),
                    matchedAs: fwdMatch !== src.value ? _truncatePreview(fwdMatch) : null,
                });
                continue;
            }

            if (s.length >= 10) {
                const revMatch = variants.find(v => v.includes(s));
                if (revMatch !== undefined) {
                    reasons.push(`xss-source:${src.type}`);
                    matched.push({
                        type: src.type,
                        value: _truncatePreview(src.value),
                        matchedAs: revMatch !== src.value ? _truncatePreview(revMatch) : null,
                    });
                }
            }
        }
        return { reasons, matched };
    }

    const ALLOWED_AST_TYPES = new Set([
        'EmptyStatement', 'ExpressionStatement',
        'Literal',
        'TemplateLiteral', 'TemplateElement',
        'ArrayExpression', 'ObjectExpression',
        'UnaryExpression', 'BinaryExpression', 'LogicalExpression',
        'BlockStatement',
        'Property',
        'SpreadElement', 'RestElement',
    ]);
    const STRUCTURAL_TYPES = new Set(['Program']);

    const DATA_MIMES_JS = new Set([
        'application/javascript', 'application/x-javascript', 'text/javascript',
    ]);
    const DATA_MIMES_HTML = new Set([
        'text/html', 'application/xhtml+xml', 'image/svg+xml',
    ]);

    function classifyDOM(input) {
        if (!input || typeof input !== 'string' || input.trim() === '')
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-html'] };

        let dom;
        const _prevClassifyingHTML = _classifyingHTML;
        try {

            _classifyingHTML = true;
            dom = new DOMParser().parseFromString(input, 'text/html');
        } catch {
            return { verdict: VERDICTS.TYPE4, reasons: ['parse-error'] };
        } finally {
            _classifyingHTML = _prevClassifyingHTML;
        }

        function checkElement(el) {
            const tag = el.tagName.toLowerCase();
            const reasons = [];

            if (tag === 'iframe') {
                const srcdoc = el.getAttribute('srcdoc');
                if (srcdoc) {
                    const result = classifyDOM(srcdoc);
                    reasons.push({ reasons: ['iframe:srcdoc', ...result.reasons], signature: result.signature });
                }
            }

            if (tag === 'script') {
                const src = el.getAttribute('src');
                if (src) {
                    const result = classifyURL(src);
                    reasons.push({ reasons: ['external-script:src', ...result.reasons], signature: result.signature });
                } else {
                    const result = classifyJS(el.textContent || '');
                    reasons.push({ reasons: ['inline-script', ...result.reasons], signature: result.signature });
                }
            }

            for (const attr of el.attributes) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on')) {
                    const result = classifyJS(attr.value || '');
                    reasons.push({ reasons: [`event-handler:${name}`, ...result.reasons], signature: result.signature });
                }
                if ((attr.value || '').toLowerCase().startsWith('javascript:')) {
                    const result = classifyJS(attr.value.slice('javascript:'.length));
                    reasons.push({ reasons: [`attr:${name}=javascript:`, ...result.reasons], signature: result.signature });
                }
            }

            return reasons;
        }

        function walkDOM(node) {
            const reasons = [];
            for (const child of node.childNodes) {
                if (child.nodeType !== 1) continue;
                reasons.push(...checkElement(child));
                reasons.push(...walkDOM(child));
            }
            return reasons;
        }

        const reasons = walkDOM(dom);
        if (reasons.length === 0)
            return { verdict: VERDICTS.TYPE2, reasons: ['no-dangerous-elements'] };
        return {
            verdict: VERDICTS.TYPE4,
            reasons: ['dangerous-elements', ...reasons.flatMap(r => r.reasons ?? r)],
            signature: reasons.map(r => r.signature).filter(Boolean),
        };
    }

    function _fastHash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return h;
    }

    const MIN_CACHE_LEN = 500;
    function _getCached(key) {
        if (!key) return null;
        try {
            const cached = sessionStorage.getItem(key);
            return cached ? JSON.parse(cached) : null;
        } catch { return null; }
    }
    function _setCached(key, result) {
        if (!key) return;
        try { sessionStorage.setItem(key, JSON.stringify(result)); } catch {}
    }

    function classifyJS(input) {
        if (!input || !input.trim())
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-script'] };

        const cacheKey = input.length >= MIN_CACHE_LEN ? 'ttjs:' + input.length + ':' + _fastHash(input) : null;
        const cached = _getCached(cacheKey);
        if (cached) return cached;

        try {
            JSON.parse(input);
            const result = { verdict: VERDICTS.TYPE2, reasons: ['pure-json'] };
            _setCached(cacheKey, result);
            return result;
        } catch {}

        let ast;
        try {
            ast = acorn.parse(input, { ecmaVersion: 'latest' });
        } catch {
            const result = { verdict: VERDICTS.TYPE4, reasons: ['parse-error'] };
            _setCached(cacheKey, result);
            return result;
        }

        const types = new Set();
        let firstUnmatched = null;
        function walkAST(node) {
            if (firstUnmatched || !node || typeof node !== 'object') return;
            if (node.type && !STRUCTURAL_TYPES.has(node.type)) {
                if (!ALLOWED_AST_TYPES.has(node.type)) {
                    firstUnmatched = node.type;
                    return;
                }
                types.add(node.type);
            }
            for (const key of Object.keys(node)) {
                if (firstUnmatched) return;
                const child = node[key];
                if (Array.isArray(child)) {
                    for (const item of child) { if (firstUnmatched) return; if (item && item.type) walkAST(item); }
                } else if (child && child.type) {
                    walkAST(child);
                }
            }
        }
        walkAST(ast);

        let result;
        if (firstUnmatched) {
            result = { verdict: VERDICTS.TYPE4, reasons: ['unsafeJS', firstUnmatched], signature: generateJSSignature(input, ast) };
        } else {
            const sorted = [...types].sort();
            result = { verdict: VERDICTS.TYPE2, reasons: ['allowedJS', ...sorted] };
        }
        _setCached(cacheKey, result);
        return result;
    }

    function classifyURL(input) {
        if (!input || typeof input !== 'string' || input === '')
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-url'] };

        let url;
        try {
            url = new URL(input, window.location.href);
        } catch {
            return { verdict: VERDICTS.TYPE4, reasons: ['invalid-url'] };
        }

        if (url.protocol === 'javascript:') {
            const result = classifyJS(input.slice('javascript:'.length));
            return { verdict: result.verdict, reasons: ['javascript:', ...result.reasons], signature: result.signature ?? null };
        }

        if (url.protocol === 'data:') {
            const m = input.match(/^data:([^;,]+)/);
            const mime = m ? m[1].toLowerCase().trim() : '';
            if (!mime)
                return { verdict: VERDICTS.TYPE4, reasons: ['data-uri:no-mime'] };
            if (DATA_MIMES_JS.has(mime)) {
                const commaIdx = input.indexOf(',');
                const content = commaIdx >= 0 ? input.slice(commaIdx + 1) : '';
                const result = classifyJS(content);
                return { verdict: result.verdict, reasons: [`data-uri:executableJS:${mime}`, ...result.reasons], signature: result.signature ?? null };
            }
            if (DATA_MIMES_HTML.has(mime)) {
                const commaIdx = input.indexOf(',');
                const content = commaIdx >= 0 ? input.slice(commaIdx + 1) : '';
                const result = classifyDOM(content);
                return { verdict: result.verdict, reasons: [`data-uri:executableHTML:${mime}`, ...result.reasons], signature: result.signature ?? null };
            }
            return { verdict: VERDICTS.TYPE2, reasons: [`data-uri:safe:${mime}`] };
        }

        if (url.origin === window.location.origin)
            return { verdict: VERDICTS.TYPE2, reasons: ['same-origin'] };

        if (ALLOWED_URLS.some(entry => entry.url === input))
            return { verdict: VERDICTS.TYPE2, reasons: ['allowlisted-url'] };

        return { verdict: VERDICTS.TYPE4, reasons: ['unrecognized-url'], signature: url };
    }

    function classifyHTML(input) {
        if (!input || typeof input !== 'string' || input.trim() === '')
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-html'] };

        const { reasons: xssReasons, matched: xssSources } = checkXssSources(input);
        if (xssReasons.length > 0) {
            const domResult = classifyDOM(input);
            return { verdict: VERDICTS.TYPE5, reasons: xssReasons, xssSources, signature: domResult.signature ?? null };
        }

        if (!HTML_TAG_REGEX.test(input)) return { verdict: VERDICTS.TYPE1, reasons: ['no-html-tags'] };
        return classifyDOM(input);
    }

    function classifyNavigation(input) {
        if (!input || typeof input !== 'string' || input.trim() === '')
            return { verdict: VERDICTS.NOTYPE, reasons: ['empty-navigation'] };

        const { reasons: xssReasons, matched: xssSources } = checkXssSources(input);
        if (xssReasons.length > 0) {
            const urlResult = classifyURL(input);
            return { verdict: VERDICTS.TYPE5, reasons: xssReasons, xssSources, signature: urlResult.signature ?? null };
        }

        const trimmed = input.trim();
        if (trimmed.toLowerCase().startsWith('javascript:')) {
            const result = classifyJS(trimmed.slice('javascript:'.length));
            return { verdict: result.verdict, reasons: ['javascript:', ...result.reasons], signature: result.signature ?? null };
        }

        return { verdict: VERDICTS.NOTYPE, reasons: ['no-javascript:'] };
    }

    function classifyScript(input) {
        if (!input || typeof input !== 'string' || input.trim() === '')
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-script'] };

        window.__TT_PERF__ = window.__TT_PERF__ || { xss: 0, js: 0 };
        const _tx0 = performance.now();
        const { reasons: xssReasons, matched: xssSources } = checkXssSources(input);
        window.__TT_PERF__.xss += performance.now() - _tx0;
        if (xssReasons.length > 0) {
            let signature = null;
            try { signature = generateJSSignature(input); } catch {}
            return { verdict: VERDICTS.TYPE5, reasons: xssReasons, xssSources, signature };
        }
        const _tj0 = performance.now();
        const _r = classifyJS(input);
        window.__TT_PERF__.js += performance.now() - _tj0;
        return _r;
    }

    function classifyScriptURL(input) {
        if (!input || typeof input !== 'string' || input.trim() === '')
            return { verdict: VERDICTS.TYPE2, reasons: ['empty-scripturl'] };

        const { reasons: xssReasons, matched: xssSources } = checkXssSources(input);
        if (xssReasons.length > 0) {
            const urlResult = classifyURL(input);
            return { verdict: VERDICTS.TYPE5, reasons: xssReasons, xssSources, signature: urlResult.signature ?? null };
        }
        return classifyURL(input);
    }

    const _BUILTIN_NAMES = new Set([
        'globalThis', 'Infinity', 'NaN', 'undefined',
        'Object', 'Function', 'Boolean', 'Symbol',
        'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
        'SyntaxError', 'TypeError', 'URIError', 'InternalError',
        'Number', 'BigInt', 'Math', 'Date',
        'String', 'RegExp',
        'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
        'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
        'BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array',
        'Map', 'Set', 'WeakMap', 'WeakSet',
        'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON',
        'WeakRef', 'FinalizationRegistry',
        'Iterator', 'AsyncIterator', 'Promise', 'GeneratorFunction',
        'AsyncGeneratorFunction', 'Generator', 'AsyncGenerator', 'AsyncFunction',
        'Reflect', 'Proxy', 'Intl',
    ]);

    const _BUILTIN_OBJ_CONSTRUCTORS = new Set([
        'Window', 'HTMLDocument', 'History', 'Location',
        'Navigation', 'Navigator', 'Screen',
    ]);

    function _isBuiltIn(foo) {
        if (window[foo] === undefined) return false;
        if (_BUILTIN_NAMES.has(foo)) return true;
        if (typeof window[foo] === 'object')
            return _BUILTIN_OBJ_CONSTRUCTORS.has(window[foo].constructor.name);
        if (typeof window[foo] === 'function')
            return /\[native code\]/.test(Function.prototype.toString.call(window[foo]));
        return false;
    }

    function _deleteNode(node) {
        const keys = Object.keys(node);
        let removed = 0;
        for (const key of keys) {
            if (node[key] === null) continue;
            if (Object.getPrototypeOf(node[key]) === acorn.Node.prototype) {
                delete node[key];
                removed++;
            } else if (typeof node[key] === 'object') {
                const prevSize = Object.keys(node[key]).length;
                const t = _deleteNode(node[key]);
                if (prevSize === t) {
                    delete node[key];
                    removed++;
                }
            }
        }
        return removed;
    }

    function toAST(code, precomputedAst) {
        if (code.startsWith('#src|'))
            return '["' + code.slice(5) + '"]';

        const parsed = precomputedAst || acorn.parse(code, { ecmaVersion: 'latest' });
        const walked = [];
        acorn.walk.full(parsed, function(node) {
            delete node.start;
            delete node.end;
            _deleteNode(node);
            switch (node.type) {
                case 'Literal':
                    delete node.raw;
                    delete node.value;
                    break;
                case 'TemplateElement':
                    delete node.value;
                    break;
                case 'Identifier':
                    if (!_isBuiltIn(node.name)) delete node.name;
                    break;
                default:
            }
            walked.push(node);
        });
        return JSON.stringify(walked);
    }

    function genHash(plaintext) {
        if (plaintext === '[]') return 'EMPTY';
        const md = forge.md.sha256.create();
        md.update(plaintext);
        return md.digest().toHex();
    }

    function generateJSSignature(input, precomputedAst) {
        return genHash(JSON.stringify(toAST(input, precomputedAst)));
    }

    function parseSinkCode(sinkCode) {
        if (!sinkCode || typeof sinkCode !== 'string' || !sinkCode.startsWith('S-'))
            return { hash: null, kind: null };
        const colonIdx = sinkCode.indexOf(':');
        if (colonIdx <= 0) return { hash: null, kind: null };
        return { hash: sinkCode.slice(2, colonIdx), kind: sinkCode.slice(colonIdx + 1) };
    }

    function splitSignatures(sig) {
        const sigs = [].concat(sig).filter(Boolean);
        const isUrl = s => /^https?:\/\//.test(s);
        const js  = sigs.filter(s => !isUrl(s));
        const url = sigs.filter(s =>  isUrl(s));
        return {
            jsSignature:  js.length  === 0 ? null : js.length  === 1 ? js[0]  : js,
            urlSignature: url.length === 0 ? null : url.length === 1 ? url[0] : url,
        };
    }

    const _REPORT_FLUSH_MS = 300;
    const _REPORT_BATCH_CAP = 50;
    const _REPORT_PREVIEW_MAX = 500;
    const _REPORT_STACK_MAX_LINES = 6;
    const _reportQueue = [];
    let _reportFlushTimer = null;

    const _REPORT_NORMAL_BUDGET = 500;
    const _REPORT_HIGHRISK_RESERVE = 100;

    const _REPORT_PER_SINK_BUDGET = 20;
    const _reportDedup = new Set();
    const _reportDedupHighRisk = new Set();
    const _perSinkReportCount = new Map();

    window.__TT_PERF__ = window.__TT_PERF__ || { xss: 0, js: 0 };
    window.__TT_PERF__.reports = {
        queued: 0, sent: 0, deduplicated: 0, droppedSafe: 0, droppedHighRisk: 0,
    };
    const _reportPerf = window.__TT_PERF__.reports;

    function _isHighRiskReport(report) {
        return report.reclassifiedVerdict === 'TYPE4' || report.reclassifiedVerdict === 'TYPE5';
    }

    function _truncatePreview(value) {
        const s = String(value);
        return s.length > _REPORT_PREVIEW_MAX ? s.slice(0, _REPORT_PREVIEW_MAX) : s;
    }

    function _truncateStack(stack) {
        return (stack || '').split('\n').slice(0, _REPORT_STACK_MAX_LINES).join('\n');
    }

    function _reportDedupKey(report) {
        return report.source + '|' + report.ttType + '|' + (report.sinkCode || '') + '|'
            + report.reclassifiedVerdict + '|' + report.valuePreview.replace(/\d+/g, '#');
    }

    const _SOURCE_VALUES_MAX_ENTRIES = 30;

    function _capSourceValues(sources) {
        return sources.slice(0, _SOURCE_VALUES_MAX_ENTRIES)
            .map(s => ({ type: s.type, value: _truncatePreview(s.value) }));
    }

    function _flushReports() {
        if (_reportFlushTimer) { clearTimeout(_reportFlushTimer); _reportFlushTimer = null; }
        if (_reportQueue.length === 0) return;
        const batch = _reportQueue.splice(0, _reportQueue.length);
        _reportPerf.queued = 0;
        const body = JSON.stringify({ reports: batch, sourceValues: _capSourceValues(getSourceValues()) });

        fetch(POLICY_REPORT_URL, {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'text/plain' },
        }).catch(() => {});
    }

    function _enqueueReport(report) {
        const highRisk = _isHighRiskReport(report);
        const dedupSet = highRisk ? _reportDedupHighRisk : _reportDedup;
        const budget = highRisk ? _REPORT_HIGHRISK_RESERVE : _REPORT_NORMAL_BUDGET;
        const key = _reportDedupKey(report);

        if (dedupSet.has(key)) {
            _reportPerf.deduplicated++;
            return;
        }
        if (dedupSet.size >= budget) {
            if (highRisk) _reportPerf.droppedHighRisk++; else _reportPerf.droppedSafe++;
            return;
        }
        if (!highRisk) {
            const sinkKey = report.sinkCode || '';
            const sinkCount = _perSinkReportCount.get(sinkKey) || 0;
            if (sinkCount >= _REPORT_PER_SINK_BUDGET) {
                _reportPerf.droppedSafe++;
                return;
            }
            _perSinkReportCount.set(sinkKey, sinkCount + 1);
        }

        dedupSet.add(key);
        _reportPerf.sent++;
        _reportQueue.push(report);
        _reportPerf.queued = _reportQueue.length;
        if (_reportQueue.length >= _REPORT_BATCH_CAP) {
            _flushReports();
            return;
        }
        if (!_reportFlushTimer) _reportFlushTimer = setTimeout(_flushReports, _REPORT_FLUSH_MS);
    }

    function sendClassifyReport(ttType, sinkCode, value, classification, typeofSink) {
        const { verdict, reasons, xssSources, signature } = classification;
        const { kind: sinkKind } = parseSinkCode(sinkCode);
        const { jsSignature, urlSignature } = splitSignatures(signature);
        _enqueueReport({
            source: 'classify',
            ttType,
            sinkCode: typeof sinkCode === 'string' ? sinkCode : null,
            sinkKind: sinkKind || typeofSink || null,
            valuePreview: _truncatePreview(value),
            valueLength: String(value).length,
            reclassifiedVerdict: verdict,
            verdictReasons: reasons,
            jsSignature,
            urlSignature,
            xssSourceValues: xssSources || null,

            url: location.href,
            timestamp: Date.now(),
            stack: _truncateStack(new Error().stack),
            agentRunId: window.__AGENT_RUN_ID || null,
            agentCrawlRunId: window.__AGENT_CRAWL_RUN_ID || null,
        });

        if (_isNavigationSink(sinkCode)) _flushReports();
    }

    function sendViolationReport(ttType, sinkCode, value, classification, typeofSink, sanitized) {
        const { verdict, reasons, xssSources, signature } = classification;
        const { kind: sinkKind } = parseSinkCode(sinkCode);
        const { jsSignature, urlSignature } = splitSignatures(signature);
        _enqueueReport({
            source: 'violation',
            ttType,
            sinkCode: typeof sinkCode === 'string' ? sinkCode : null,
            sinkKind: sinkKind || typeofSink || null,
            valuePreview: _truncatePreview(value),
            valueLength: String(value).length,
            reclassifiedVerdict: verdict,
            verdictReasons: reasons,
            jsSignature,
            urlSignature,
            xssSourceValues: xssSources || null,

            url: location.href,
            timestamp: Date.now(),
            stack: _truncateStack(new Error().stack),
            sanitizedValuePreview: sanitized ? _truncatePreview(sanitized) : null,
            agentRunId: window.__AGENT_RUN_ID || null,
            agentCrawlRunId: window.__AGENT_CRAWL_RUN_ID || null,
        });

        if (_isNavigationSink(sinkCode)) _flushReports();
    }

    function isAllowed(signature) {
        if (!signature) return false;
        if (Array.isArray(signature)) return signature.every(s => ALLOWED_SCRIPTS.includes(s));
        return ALLOWED_SCRIPTS.includes(signature);
    }

    function judgeVerdict(verdict, value, meta, ttType, typeofSink = null, sanitize = false) {
        if (verdict.verdict === VERDICTS.NOTYPE ||
            verdict.verdict === VERDICTS.TYPE1  ||
            verdict.verdict === VERDICTS.TYPE2)
            return value;

        if (verdict.verdict === VERDICTS.TYPE4) {
            if (verdict.signature && verdict.signature.length > 0 && isAllowed(verdict.signature)) return value;
            let sanitized = null;
            if (sanitize) sanitized = sanitizeContent(value, ttType, meta);
            sendViolationReport(ttType, meta, value, verdict, typeofSink, sanitized);
            return sanitized ?? value;
        }

        if (verdict.verdict === VERDICTS.TYPE5) {
            const sanitized = sanitizeContent(value, ttType, meta);
            sendViolationReport(ttType, meta, value, verdict, typeofSink, sanitized);
            return sanitized ?? value;
        }

        const msg = `Unexpected verdict from classify${ttType}`;
        const enriched = { ...verdict, reasons: [msg, ...verdict.reasons] };
        let sanitized = null;
        if (sanitize) sanitized = sanitizeContent(value, ttType, meta);
        sendViolationReport(ttType, meta, value, enriched, typeofSink, sanitized);
        return sanitized ?? value;
    }

    function classifyByType(ttType, value, sinkCode, typeofSink) {
        if (ttType === 'HTML') return classifyHTML(value);
        if (ttType === 'Script') {
            return _isNavigationSink(sinkCode) ? classifyNavigation(value) : classifyScript(value);
        }
        if (ttType === 'ScriptURL') return classifyScriptURL(value);
        return { verdict: VERDICTS.NOTYPE, reasons: [`unrecognized-tt-type:${ttType}`] };
    }

    function shouldObserve(observationMode) {
        return observationMode !== 'static-final';
    }

    function observeInvocation(ttType, value, sinkCode, typeofSink, observationMode) {
        const verdict = classifyByType(ttType, value, sinkCode, typeofSink);
        if (shouldObserve(observationMode)) {
            sendClassifyReport(ttType, sinkCode, value, verdict, typeofSink);
        }
        return verdict;
    }

    function handlePolicyInvocation(sanitize, ttType, value, sinkCode, typeofSink, observationMode) {

        if (ttType === 'Script' && typeofSink === 'function') {
            if (shouldObserve(observationMode)) {
                sendClassifyReport('Script', sinkCode, value, { verdict: VERDICTS.NOTYPE, reasons: ['function-arg'] }, typeofSink);
            }
            return value;
        }
        const verdict = observeInvocation(ttType, value, sinkCode, typeofSink, observationMode);
        return judgeVerdict(verdict, value, sinkCode, ttType, typeofSink, sanitize);
    }

    function handleHTMLPolicyInvocation(sanitize, value, sinkCode, typeofSink, observationMode) {
        if (_classifyingHTML) return value;
        _classifyingHTML = true;
        try {
            const verdict = observeInvocation('HTML', value, sinkCode, typeofSink, observationMode);
            return judgeVerdict(verdict, value, sinkCode, 'HTML', typeofSink, sanitize);
        } finally {
            _classifyingHTML = false;
        }
    }

    function _jqueryValueMetadata(value) {
        let objectType = null;
        try {
            objectType = value == null ? null : Object.prototype.toString.call(value);
        } catch (_) {}
        const isNode = typeof Node !== 'undefined' && value instanceof Node;
        const isJQuery = !!(value && typeof value === 'object' &&
            typeof value.jquery === 'string' && typeof value.toArray === 'function' &&
            typeof value.get === 'function');
        let isTrustedHTML = false;
        try {
            isTrustedHTML = typeof trustedTypes !== 'undefined' &&
                typeof trustedTypes.isHTML === 'function' && trustedTypes.isHTML(value);
        } catch (_) {}
        return {
            jsType: typeof value,
            objectType,
            isNode,
            isJQuery,
            isTrustedHTML,
        };
    }

    function _jqueryReasons(category, metadata) {
        return [
            `jquery-value:${category}`,
            `js_type:${metadata.jsType}`,
            `object_type:${metadata.objectType ?? 'null'}`,
            `is_node:${metadata.isNode}`,
            `is_jquery:${metadata.isJQuery}`,
            `is_trusted_html:${metadata.isTrustedHTML}`,
        ];
    }

    function _reportJQueryValue(value, sinkCode, sinkKind, verdict, category, metadata, observationMode) {

        if (!shouldObserve(observationMode)) return;
        const previewValue = category === 'unresolved-object' || category === 'cyclic-array'
            ? metadata.objectType || '[object]'
            : value;
        sendClassifyReport('HTML', sinkCode, previewValue, {
            verdict,
            reasons: _jqueryReasons(category, metadata),
            xssSources: null,
            signature: null,
        }, sinkKind);
    }

    function _jqueryMaterializeHTML(value, sinkCode, sinkKind, policy, observationMode) {
        const trusted = policy.createHTML(value, sinkCode, sinkKind, observationMode);
        const template = document.createElement('template');
        template.innerHTML = trusted;

        template.content.querySelectorAll('script').forEach((oldScript) => {
            const newScript = document.createElement('script');
            for (const attr of oldScript.attributes) {
                newScript.setAttribute(attr.name, attr.value);
            }
            newScript.text = oldScript.text;
            oldScript.replaceWith(newScript);
        });
        return Array.from(template.content.childNodes);
    }

    function _ttJQueryArg(value, sinkCode, sinkKind, policy, seen, observationMode) {
        const metadata = _jqueryValueMetadata(value);

        if (metadata.jsType === 'function') {
            const callback = value;
            return function(...args) {
                return _ttJQueryArg(callback.apply(this, args), sinkCode, sinkKind, policy, new WeakSet(), observationMode);
            };
        }

        const primitiveNoViolation = value == null || metadata.jsType === 'undefined' ||
            metadata.jsType === 'number' || metadata.jsType === 'boolean';
        if (primitiveNoViolation || metadata.isNode || metadata.isJQuery || metadata.isTrustedHTML) {
            const category = value == null ? 'nullish'
                : metadata.isNode ? 'dom-node'
                : metadata.isJQuery ? 'jquery-object'
                : metadata.isTrustedHTML ? 'trusted-html'
                : `primitive-${metadata.jsType}`;
            _reportJQueryValue(value, sinkCode, sinkKind, VERDICTS.NOTYPE, category, metadata, observationMode);
            return value;
        }

        if (Array.isArray(value)) {
            if (seen.has(value)) {
                _reportJQueryValue(value, sinkCode, sinkKind, VERDICTS.TYPE3, 'cyclic-array', metadata, observationMode);
                return value;
            }
            seen.add(value);
            const nodeArraySeen = new WeakSet();
            const isNodeOnlyArray = array => {
                if (nodeArraySeen.has(array)) return false;
                nodeArraySeen.add(array);
                return array.every(item => Array.isArray(item)
                    ? isNodeOnlyArray(item)
                    : typeof Node !== 'undefined' && item instanceof Node);
            };
            const nodeOnly = isNodeOnlyArray(value);
            if (nodeOnly) {
                _reportJQueryValue(value, sinkCode, sinkKind, VERDICTS.NOTYPE, 'node-array', metadata, observationMode);
                return value;
            }
            return value.flatMap(item => {
                const guarded = _ttJQueryArg(item, sinkCode, sinkKind, policy, seen, observationMode);
                return Array.isArray(guarded) ? guarded : [guarded];
            });
        }

        if (metadata.jsType === 'string') {

            return _jqueryMaterializeHTML(value, sinkCode, sinkKind, policy, observationMode);
        }

        _reportJQueryValue(value, sinkCode, sinkKind, VERDICTS.TYPE3, 'unresolved-object', metadata, observationMode);
        return value;
    }

    window.__ttJQueryArg = function(value, sinkCode, sinkKind, policy, receiverOk, observationMode) {

        if (receiverOk === false) {
            _reportJQueryValue(value, sinkCode, sinkKind, VERDICTS.NOTYPE, 'receiver-mismatch', _jqueryValueMetadata(value), observationMode);
            return value;
        }
        return _ttJQueryArg(value, sinkCode, sinkKind, policy, new WeakSet(), observationMode);
    };

    const TT_TYPE_INFO = {
        TrustedHTML:      { ttType: 'HTML',      ttCallback: 'createHTML' },
        TrustedScript:    { ttType: 'Script',    ttCallback: 'createScript' },
        TrustedScriptURL: { ttType: 'ScriptURL', ttCallback: 'createScriptURL' },
    };

    window.__ttDispatchSetAttr = function(attrName, value, sinkCode, el, policy, typeofValue, observationMode) {
        if (typeof trustedTypes === 'undefined' || !trustedTypes.getAttributeType) return value;
        const tagName = el && el.tagName;
        if (!tagName) return value;
        const ttTypeName = trustedTypes.getAttributeType(tagName, attrName, el.namespaceURI);
        const info = ttTypeName && TT_TYPE_INFO[ttTypeName];
        if (!info) return value;
        return policy[info.ttCallback](value, sinkCode, typeofValue, observationMode);
    };

    window.__ttDispatchExecCommand = function(cmdName, value, sinkCode, policy, typeofValue, observationMode) {
        if (String(cmdName).toLowerCase() !== 'inserthtml') return value;
        return policy.createHTML(value, sinkCode, typeofValue, observationMode);
    };

    window.__ttDispatchJQueryAttr = function(attrName, value, sinkCode, $el, policy, typeofValue, observationMode) {
        const el = $el && ($el[0] || $el);
        return window.__ttDispatchSetAttr(attrName, value, sinkCode, el, policy, typeofValue, observationMode);
    };

    const JQUERY_PROP_TT = {
        'innerhtml': 'createHTML',
        'outerhtml': 'createHTML',
        'srcdoc':    'createHTML',
    };
    window.__ttDispatchJQueryProp = function(propName, value, sinkCode, policy, typeofValue, observationMode) {
        const cb = JQUERY_PROP_TT[String(propName).toLowerCase()];
        if (!cb) return value;
        return policy[cb](value, sinkCode, typeofValue, observationMode);
    };

    function sanitizeContent(value, ttType, meta) {
        if (ttType === 'HTML') return sanitizeHTML(value);
        if (ttType === 'Script') return sanitizeScript(value, meta);
        if (ttType === 'ScriptURL') return sanitizeURL(value);
    }

    function sanitizeHTML(value) {
        return DOMPurify.sanitize(value);
    }

    function sanitizeScript(value, meta) {
        const { kind: sinkKind } = parseSinkCode(meta);

        if (!sinkKind) return value;
        if (sinkKind.includes('location') || sinkKind.includes('window.open'))
            return 'javascript:void(0)';
        return '/* sanitized script */';
    }

    function sanitizeURL(value) {
        let url;
        try {
            url = new URL(value, location.href);
        } catch {
            return 'about:blank';
        }
        if (url.protocol === 'javascript:') return 'javascript:void(0)';
        if (url.protocol === 'data:') {
            const m = value.match(/^data:([^;,]+)/);
            const mime = m ? m[1].toLowerCase().trim() : '';
            return `data:${mime};base64,`;
        }
        return 'about:blank';
    }

    function _isNavigationSink(sinkCode) {
        const { kind } = parseSinkCode(sinkCode);
        return !!(kind && (kind.includes('location') || kind.includes('window.open')));
    }

    const ELEMENT_TAG_NAMES = { iframe: 'IFRAME', script: 'SCRIPT', svgScript: 'script' };

    function _verifyReceiverType(receiverType, sinkCode) {
        if (typeof receiverType === 'boolean') return receiverType;
        const { kind } = parseSinkCode(sinkCode);
        if (!kind) return true;
        const expectedType = kind.split('.')[0];
        if (!(expectedType in ELEMENT_TAG_NAMES)) return true;
        return receiverType === ELEMENT_TAG_NAMES[expectedType];
    }

    const TT_METHOD_TO_TYPE = { createHTML: 'HTML', createScript: 'Script', createScriptURL: 'ScriptURL' };

    window.__ttGuardedPolicyCall = function(policy, method, value, sinkCode, typeofArg, receiverType, observationMode) {
        if (arguments.length >= 6 && !_verifyReceiverType(receiverType, sinkCode)) {
            sendClassifyReport(TT_METHOD_TO_TYPE[method], sinkCode, value, { verdict: VERDICTS.NOTYPE, reasons: ['receiver-mismatch'] });
            return value;
        }
        return policy[method](value, sinkCode, typeofArg, observationMode);
    };

    let _classifyingHTML = false;

    function makeObservingPolicyMethods(sanitizeType4) {
        return {
            createHTML: (value, meta, typeofSink, observationMode) =>
                handleHTMLPolicyInvocation(sanitizeType4, value, meta, typeofSink, observationMode),
            createScript: (value, meta, typeofSink, observationMode) =>
                handlePolicyInvocation(sanitizeType4, 'Script', value, meta, typeofSink, observationMode),
            createScriptURL: (value, meta, typeofSink, observationMode) =>
                handlePolicyInvocation(sanitizeType4, 'ScriptURL', value, meta, typeofSink, observationMode),
        };
    }

    if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {

        try {
            window.passThruPolicy = trustedTypes.createPolicy('pass-thru', makeObservingPolicyMethods(false));
        } catch (e) {
            if (!e.message.includes('already exists')) throw e;
        }

        try {
            window.classifyPolicy = trustedTypes.createPolicy('default', makeObservingPolicyMethods(false));
        } catch (e) {
            if (!e.message.includes('already exists')) throw e;
        }

        try {
            window.monitorPolicy = trustedTypes.createPolicy('monitor', makeObservingPolicyMethods(false));
        } catch (e) {
            if (!e.message.includes('already exists')) throw e;
        }

        try {
            window.sanitizePolicy = trustedTypes.createPolicy('sanitize', makeObservingPolicyMethods(true));
        } catch (e) {
            if (!e.message.includes('already exists')) throw e;
        }
    } else {
        const passThru = {
            createHTML: (s, meta, typeofSink) => s,
            createScript: (s, meta, typeofSink) => s,
            createScriptURL: (s, meta, typeofSink) => s,
        };
        window.passThruPolicy = passThru;
        window.classifyPolicy = passThru;
        window.monitorPolicy = passThru;
        window.sanitizePolicy = passThru;
    }

    const _POLICY_NAMES = ['passThruPolicy', 'classifyPolicy', 'monitorPolicy', 'sanitizePolicy'];
    const _origOpen = window.open.bind(window);
    window.open = function(...args) {
        const w = _origOpen(...args);
        if (w) {
            _POLICY_NAMES.forEach(name => {
                try { if (window[name]) w[name] = window[name]; } catch (_) {}
            });
        }
        return w;
    };

    window.__TT_POLICY_INITIALIZED__ = true;
})();
