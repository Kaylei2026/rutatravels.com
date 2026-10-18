#!/usr/bin/env node
/**
 * Write the current /live board into live/index.html.
 *
 * The page fetched the API client-side, so without a JS engine it returned the word
 * "Loading..." and nothing else. That cost us in four places: AI answer engines, social preview
 * cards (a link shared in a chat previewed as nothing), crawlers that never run JS, and Google,
 * which runs it but defers it and indexes the loading state first.
 *
 * This renders the same markup the page renders, using the same functions from live/board.js,
 * and writes it between the markers in the HTML. The page still fetches on load, so the baked
 * copy is only there to guarantee the first byte is not empty.
 *
 * It also stamps the board.js URL with a hash of that file, because the page throws the baked
 * markup away and re-renders from board.js on load. A cached copy of an older board.js therefore
 * overwrites a correct page with an outdated one, which is how the airport links went missing for
 * anyone who had visited before they were added.
 *
 *   node scripts/bake-live.js                 fetch the live API and bake
 *   node scripts/bake-live.js --from f.json   bake from a saved payload (testing)
 *   node scripts/bake-live.js --check         exit 1 if the file would change, write nothing
 *
 * Exit codes: 0 wrote or already current, 1 --check found drift, 2 could not produce a page.
 * A failed fetch leaves the existing file alone and exits 0, because yesterday's board is a
 * better thing to serve than an empty one, and the client refresh corrects it for real users.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'live', 'index.html');
const BOARD = require(path.join(ROOT, 'live', 'board.js'));

const API = process.env.RUTA_LIVE_API
  || 'https://ruta-travels-production.up.railway.app/api/live';

const FETCH_TIMEOUT_MS = 20000;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(name);

/**
 * Replace the text between two markers, keeping the markers.
 *
 * Returns the original string untouched when either marker is missing, and reports it, so a
 * hand-edit to the HTML that drops a marker fails loudly here rather than silently baking
 * nothing for weeks.
 */
const fill = (html, name, content) => {
  const a = `<!--ruta:${name}:start-->`;
  const b = `<!--ruta:${name}:end-->`;
  const i = html.indexOf(a);
  const j = html.indexOf(b);
  if (i === -1 || j === -1 || j < i) {
    throw new Error(`marker ${name} missing or out of order in live/index.html`);
  }
  return html.slice(0, i + a.length) + content + html.slice(j);
};

/**
 * Point the page's script tag at the current board.js.
 *
 * live/index.html loads the renderer as a plain <script src="board.js">, and the page replaces
 * the baked board with whatever that file renders. So a browser holding a stale board.js does
 * not merely miss a new feature, it actively undoes the server's correct markup. Putting a hash
 * of the file in the query string makes a changed file a different URL, which no cache can serve
 * from its old entry.
 *
 * Throws when the tag is absent, rather than returning the HTML unstamped: losing the stamp
 * silently would restore exactly the bug this exists to prevent.
 */
const stampAssets = (html) => {
  const file = path.join(ROOT, 'live', 'board.js');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  const tag = /src="board\.js(?:\?v=[0-9a-f]+)?"/g;
  const found = html.match(tag);
  if (!found) throw new Error('live/index.html does not load board.js; nothing to stamp');
  return html.replace(tag, `src="board.js?v=${hash}"`);
};

/**
 * An absolute time rather than "5 min ago".
 *
 * The relative form is correct for about a minute and then lies for however long the snapshot
 * sits in a CDN or a crawler's index. The page overwrites this with the relative form as soon
 * as its own fetch lands, so a real visitor still sees "Updated 3 min ago".
 */
const stamp = (iso) => {
  const d = new Date(iso || Date.now());
  if (isNaN(d.getTime())) return 'Live';
  const t = d.toISOString().replace('T', ' ').slice(0, 16);
  return `Updated ${t} UTC`;
};

const fetchLive = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(API, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'RutaBake/1.0 (+https://rutatravels.com)' },
    });
    if (!resp.ok) throw new Error(`api ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
};

const main = async () => {
  let data = null;
  let feedDown = false;
  const from = argOf('--from');

  if (from) {
    data = JSON.parse(fs.readFileSync(from, 'utf8'));
  } else {
    try {
      data = await fetchLive();
    } catch (e) {
      // Deliberately not a failure. The committed page keeps whatever board it last had, which
      // is a real one, and the Action should not go red because Railway blinked.
      console.log(`[bake] feed unavailable (${e.message}); keeping the board that is already there`);
      feedDown = true;
    }
  }

  if (!feedDown && (!data || typeof data !== 'object')) {
    console.error('[bake] payload is not an object; refusing to write');
    return 2;
  }

  const before = fs.readFileSync(PAGE, 'utf8');
  let after = before;
  let regions = 0;
  let airports = 0;
  let alerts = 0;

  if (!feedDown) {
    const out = BOARD.renderAll(data);
    after = fill(after, 'alerts', out.alerts);
    after = fill(after, 'board', out.board);
    after = fill(after, 'updated', BOARD.esc(stamp(data.updatedAt)));
    regions = (data.regions || []).length;
    airports = (data.regions || []).reduce((n, r) => n + ((r.airports || []).length), 0);
    alerts = (data.alerts || []).length;
  }

  // Unconditional, including when the feed is down: whether board.js changed has nothing to do
  // with whether there is fresh data, and a stale renderer is the more damaging of the two.
  after = stampAssets(after);

  if (after === before) {
    if (feedDown) {
      console.log('[bake] nothing to change');
    } else {
      console.log(`[bake] no change (${airports} airports across ${regions} regions, ${alerts} alerts)`);
    }
    return 0;
  }

  if (has('--check')) {
    console.error('[bake] live/index.html is out of date');
    return 1;
  }

  fs.writeFileSync(PAGE, after);
  if (feedDown) {
    console.log('[bake] restamped board.js; board left as it was');
  } else {
    console.log(`[bake] wrote ${airports} airports across ${regions} regions, ${alerts} alerts`);
  }
  return 0;
};

main().then((code) => process.exit(code)).catch((e) => {
  console.error('[bake] ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
