#!/usr/bin/env node
// tools/stamp.js — cache-busting for the static site. GitHub Pages serves every file with max-age=600, so after a
// push a browser can run new copies of some scripts with cached copies of others. This rewrites each local
// <script src> and <link href> in index.html to end in ?v=<first 8 hex of the file's sha1>, so a changed file
// always gets a new URL and an unchanged one stays cached.
//
//   node tools/stamp.js          rewrite index.html (run before pushing main)
//   node tools/stamp.js --check  exit 1 if any stamp is stale (nothing is written)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const check = process.argv.includes('--check');

const html = fs.readFileSync(INDEX, 'utf8');
const stale = [];
const out = html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"?#:]+\.(?:js|css))(?:\?v=([0-9a-f]*))?(")/g,
  (m, pre, file, old, post) => {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) throw new Error('index.html refers to a missing file: ' + file);
    const v = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
    if (v !== old) stale.push(file);
    return pre + file + '?v=' + v + post;
  });

if (check) {
  if (stale.length) { console.error('stale cache stamps (run node tools/stamp.js): ' + stale.join(', ')); process.exit(1); }
  console.log('index.html stamps are current');
} else {
  if (out !== html) fs.writeFileSync(INDEX, out);
  console.log(stale.length ? 'restamped ' + stale.join(', ') : 'index.html stamps already current');
}
