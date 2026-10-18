/**
 * The Cloudflare Web Analytics beacon, which was on 32 of 83 pages.
 *
 * privacy.html names Cloudflare Web Analytics as the site's analytics, so the beacon is a
 * documented commitment rather than an incidental script. It was missing from the homepage, the
 * blog index, the accessibility page, the discover quiz, privacy.html itself, and all 37 baked
 * airport pages: that is, from most of the pages anyone actually lands on.
 *
 * Half-measured is worse than either extreme. A dashboard that excludes the homepage and the
 * /live/ pages gives a number that reads like traffic and is not, and the conclusion drawn from
 * it would be wrong in a way nobody would notice.
 *
 * Two pages are exempt on purpose, and both are named here rather than pattern-matched, so adding
 * a third requires saying why.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BEACON = 'static.cloudflareinsights.com/beacon.min.js';

/** Not published: a standalone design export, and a redirect stub with no body at all. */
const EXEMPT = new Set([
  'Ruta Travels Site Dark Standalone.dc.html',
  // Redirects to /ruta-user-guide.html in a <script> in <head>; a beacon would only delay it.
  path.join('ruta-user-guide', 'index.html'),
]);

const pages = (dir = ROOT, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) pages(full, acc);
    else if (e.name.endsWith('.html')) acc.push(path.relative(ROOT, full));
  }
  return acc;
};

test('every published page carries the analytics beacon', () => {
  const missing = pages()
    .filter((p) => !EXEMPT.has(p))
    .filter((p) => !fs.readFileSync(path.join(ROOT, p), 'utf8').includes(BEACON));
  assert.deepStrictEqual(missing, [], `no beacon on: ${missing.join(', ')}`);
});

test('the pages that drive traffic are covered, named individually', () => {
  // These are the ones that were missing and matter most. Named so the general test above cannot
  // be satisfied by deleting pages.
  for (const p of ['index.html', 'privacy.html', 'blog/index.html', 'live/index.html',
    'live/chicago-ord/index.html', 'live/los-angeles-lax/index.html']) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is gone`);
    assert.ok(fs.readFileSync(path.join(ROOT, p), 'utf8').includes(BEACON), `no beacon on ${p}`);
  }
});

test('the airport-page template carries it, so a re-bake does not strip it', () => {
  // The 37 /live/ airport pages are generated. Patching the built files alone would have been
  // undone by the next cron bake.
  const bake = fs.readFileSync(path.join(ROOT, 'scripts', 'bake-airports.js'), 'utf8');
  assert.ok(bake.includes(BEACON), 'bake-airports.js would regenerate pages without the beacon');
});

test('the beacon token is the one the privacy policy implies, not a placeholder', () => {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /data-cf-beacon='\{"token":\s*"([^"]+)"\}'/.exec(home);
  assert.ok(m, 'no beacon token on the homepage');
  assert.match(m[1], /^[0-9a-f]{32}$/, `token does not look real: ${m[1]}`);
  // Every page should report to the same property, or the numbers split silently.
  const tokens = new Set();
  for (const p of pages().filter((x) => !EXEMPT.has(x))) {
    const t = /data-cf-beacon='\{"token":\s*"([^"]+)"\}'/.exec(fs.readFileSync(path.join(ROOT, p), 'utf8'));
    if (t) tokens.add(t[1]);
  }
  assert.strictEqual(tokens.size, 1, `pages report to ${tokens.size} different properties`);
});

test('privacy.html still names the analytics it uses', () => {
  // The beacon is only defensible because the policy discloses it. If the disclosure goes, the
  // beacon should go with it.
  const privacy = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  assert.match(privacy, /Cloudflare Web Analytics/);
  assert.match(privacy, /without setting tracking cookies/);
});
