const parse5 = require('parse5');
const { VERDICTS } = require('./constants');

const TAG_RE = /<[a-zA-Z!?/]/;

const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'applet']);
const SVG_EXEC_TAGS = new Set(['script', 'animate', 'set']);
const DANGEROUS_URL_PREFIXES = ['javascript:', 'data:text/html', 'vbscript:'];
const LINK_BLOCKED_RELS = new Set(['import', 'modulepreload']);

function walkNodes(nodes, result, inSvg) {
  for (const node of nodes) {
    if (!node.nodeName || node.nodeName[0] === '#') {
      if (node.childNodes) walkNodes(node.childNodes, result, inSvg);
      continue;
    }

    const tag = node.nodeName.toLowerCase();
    const attrs = (node.attrs || []);
    const attrMap = {};
    const attrValueMap = {};
    for (const a of attrs) {
      const key = a.name.toLowerCase();
      attrMap[key] = (a.value || '').toLowerCase();
      attrValueMap[key] = a.value || '';
    }

    result.push({ tag, attrs: attrs.map(a => a.name), attrMap, attrValueMap, inSvg });

    if (node.childNodes) walkNodes(node.childNodes, result, inSvg || tag === 'svg');
  }
}

function checkExecutable(entry) {
  const { tag, attrs, attrMap, inSvg } = entry;
  const reasons = [];

  if (BLOCKED_TAGS.has(tag)) {
    reasons.push(`tag:<${tag}>`);
  }

  if (tag === 'link') {
    const rel = attrMap['rel'];
    if (rel && LINK_BLOCKED_RELS.has(rel)) {
      reasons.push(`tag:<link rel="${rel}">`);
    }
  }

  if (inSvg && SVG_EXEC_TAGS.has(tag)) {
    reasons.push(`svg:<${tag}>`);
  }

  for (const name of attrs) {
    if (name.toLowerCase().startsWith('on')) {
      reasons.push(`attr:${name}`);
    }
  }

  for (const [name, value] of Object.entries(attrMap)) {
    for (const prefix of DANGEROUS_URL_PREFIXES) {
      if (value.startsWith(prefix)) {
        reasons.push(`attr:${name}="${prefix}..."`);
        break;
      }
    }
  }

  return reasons;
}

function analyzeHtmlArg(value) {
  if (!TAG_RE.test(value)) {
    return { verdict: VERDICTS.TYPE1, htmlTags: null, verdictReasons: ['no-html-tags'] };
  }

  const fragment = parse5.parseFragment(value);
  const entries = [];
  walkNodes(fragment.childNodes, entries, false);

  const htmlTags = entries.map(e => ({
    tag: e.tag,
    attrs: e.attrs.map(name => ({
      name,
      value: e.attrValueMap[name.toLowerCase()] || '',
    })),
  }));

  const reasonSet = new Set();
  for (const entry of entries) {
    for (const r of checkExecutable(entry)) reasonSet.add(r);
  }

  if (reasonSet.size > 0) {
    return { verdict: VERDICTS.TYPE4, htmlTags, verdictReasons: [...reasonSet] };
  }

  return { verdict: VERDICTS.TYPE2, htmlTags, verdictReasons: ['html-tags-present-but-safe'] };
}

module.exports = { analyzeHtmlArg };
