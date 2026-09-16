'use strict';
/*
 * RedMarks Wardogs Server Browser - copy fonts and icons into the app
 *
 * Runs automatically before "npm start" and "npm run dist".
 * Copies ONLY the font/icon files the screen uses from node_modules into
 * src/renderer/vendor, so the installer stays small and doesn't carry the
 * font packages' own build tools.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'src', 'renderer', 'vendor');

// [package, css files to copy]
const FONT_CSS = [
  ['@fontsource/barlow-condensed', ['400.css', '500.css', '600.css']],
  ['@fontsource/saira-stencil-one', ['400.css']],
];

function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error(`Missing ${path.relative(root, from)} - run "npm ci" first.`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Copy a stylesheet plus every local file it points at with url(...). */
function copyCssWithFiles(srcCss, destCss) {
  copy(srcCss, destCss);
  const css = fs.readFileSync(srcCss, 'utf8');
  const refs = new Set();
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const ref = m[1].split(/[?#]/)[0];
    if (!/^(data:|https?:)/.test(ref)) refs.add(ref);
  }
  for (const ref of refs) {
    copy(path.join(path.dirname(srcCss), ref), path.join(path.dirname(destCss), ref));
  }
  return refs.size;
}

fs.rmSync(out, { recursive: true, force: true });

let count = 0;
for (const [pkg, cssFiles] of FONT_CSS) {
  const name = pkg.split('/')[1];
  for (const css of cssFiles) {
    count += copyCssWithFiles(path.join(nm, pkg, css), path.join(out, name, css));
  }
  copy(path.join(nm, pkg, 'LICENSE'), path.join(out, name, 'LICENSE'));
}

const tabler = path.join(nm, '@tabler', 'icons-webfont');
count += copyCssWithFiles(path.join(tabler, 'dist', 'tabler-icons.min.css'), path.join(out, 'tabler', 'tabler-icons.min.css'));
copy(path.join(tabler, 'LICENSE'), path.join(out, 'tabler', 'LICENSE'));

console.log(`Copied fonts and icons (${count} font files) into src/renderer/vendor`);
