const parse5 = require('parse5');

const EXCLUDED_TYPES = new Set(['text/template', 'text/html', 'text/x-template', 'text/ng-template']);

function shouldExtract(scriptNode) {
  for (const attr of scriptNode.attrs || []) {
    if (attr.name === 'src') return false;
    if (attr.name === 'type' && EXCLUDED_TYPES.has(attr.value.toLowerCase())) return false;
  }
  return true;
}

function getTextContent(node) {
  for (const child of node.childNodes || []) {
    if (child.nodeName === '#text') return child.value;
  }
  return '';
}

function walkTree(node, callback) {
  callback(node);
  for (const child of node.childNodes || []) {
    walkTree(child, callback);
  }
}

function extractScripts(htmlSource) {
  const doc = parse5.parse(htmlSource, { sourceCodeLocationInfo: true });
  const scripts = [];

  walkTree(doc, (node) => {
    if (node.nodeName === 'script') {
      if (!shouldExtract(node)) return;

      let source = '';
      let innerStart = 0;
      for (const c of node.childNodes || []) {
        if (c.nodeName === '#text') {
          source = c.value;
          innerStart = c.sourceCodeLocation?.startOffset ?? 0;
          break;
        }
      }
      if (!source.trim()) return;

      const loc = node.sourceCodeLocation;

      const lineOffset = loc && loc.startTag ? loc.startTag.endLine - 1 : 0;

      scripts.push({ source, lineOffset, innerStart });
      return;
    }

    for (const attr of node.attrs || []) {
      if (!attr.name.startsWith('on')) continue;
      const value = attr.value.trim();
      if (!value) continue;

      const attrLoc = node.sourceCodeLocation?.attrs?.[attr.name];
      const lineOffset = attrLoc ? attrLoc.startLine - 1 : 0;

      let innerStart = 0;
      if (attrLoc?.startOffset) {

        innerStart = htmlSource.indexOf(value, attrLoc.startOffset);
        if (innerStart === -1) innerStart = attrLoc.startOffset;
      } else if (!attrLoc) {

        continue;
      }

      scripts.push({ source: value, lineOffset, innerStart });
    }
  });

  return scripts;
}

module.exports = { extractScripts };
