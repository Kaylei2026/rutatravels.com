/**
 * Tests for the /live pre-render.
 *
 * node:test and node:assert on purpose. The site is static with no build step and no
 * node_modules, and it should not grow a test framework to cover one script.
 *
 *   node --test scripts/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'live', 'index.html');
const SCRIPT = path.join(ROOT, 'scripts', 'bake-live.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'live-sample.json');
const BOARD = require(path.join(ROOT, 'live', 'board.js'));

const sample = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const between = (html, name) => {
  const a = `<!--ruta:${name}:start-->`;
  const b = `<!--ruta:${name}:end-->`;
  return html.slice(html.indexOf(a) + a.length, html.indexOf(b));
};

/** Run the baker against a throwaway copy of the page, return that copy's text. */
const bakeInto = (payload, extraArgs = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-bake-'));
  const liveDir = path.join(dir, 'live');
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(liveDir); fs.mkdirSync(scriptsDir);
  fs.copyFileSync(PAGE, path.join(liveDir, 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), path.join(liveDir, 'board.js'));
  fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'bake-live.js'));
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(scriptsDir, 'bake-live.js'), '--from', payloadPath, ...extraArgs], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  const html = fs.readFileSync(path.join(liveDir, 'index.html'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { html, status };
};

test('the page ships with the markers the baker needs', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  for (const name of ['alerts', 'board', 'updated']) {
    assert.ok(html.includes(`<!--ruta:${name}:start-->`), `missing ${name} start marker`);
    assert.ok(html.includes(`<!--ruta:${name}:end-->`), `missing ${name} end marker`);
    assert.ok(html.indexOf(`<!--ruta:${name}:start-->`) < html.indexOf(`<!--ruta:${name}:end-->`), `${name} markers out of order`);
  }
});

test('the page loads the shared module rather than redefining the render', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.ok(/<script src="board\.js(\?v=[0-9a-f]+)?"><\/script>/.test(html), 'board.js not loaded');
  assert.ok(html.includes('RutaBoard.renderAll'), 'page does not call the shared render');
  // The whole point: one definition. If a row template reappears inline, they will drift.
  assert.ok(!html.includes('function renderBoard('), 'renderBoard redefined inline');
  assert.ok(!html.includes('function renderAlerts('), 'renderAlerts redefined inline');
});

test('first load does not blank the baked timestamp', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  // The flicker this prevents: the baked stamp replaced by "Loading..." for the length of the
  // fetch, on a page whose whole purpose is having something real there already.
  assert.ok(/function load\(manual\)/.test(html), 'load() lost its manual flag');
  assert.ok(/if \(manual\) \$\('updated'\)\.textContent/.test(html), 'loading text is not gated on manual');
  assert.ok(html.includes("setInterval(function(){ load(); }"), 'setInterval would pass a timer id as manual');
});

test('a crawler with no JavaScript sees real airports and real alerts', () => {
  const { html } = bakeInto(sample());
  assert.ok(html.includes('Los Angeles'), 'no airport city in the HTML');
  assert.ok(html.includes('Significant delays'), 'no status in the HTML');
  assert.ok(html.includes('air traffic control strike'), 'no alert summary in the HTML');
  assert.ok(!between(html, 'board').includes('Loading'), 'board still says Loading');
});

test('every airport in the payload reaches the HTML', () => {
  const d = sample();
  const { html } = bakeInto(d);
  const board = between(html, 'board');
  for (const reg of d.regions) {
    assert.ok(board.includes(reg.region), `region ${reg.region} missing`);
    for (const a of reg.airports) {
      assert.ok(board.includes(a.airport), `airport ${a.airport} missing`);
    }
  }
});

test('baking twice changes nothing the second time', () => {
  const a = bakeInto(sample()).html;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-idem-'));
  fs.mkdirSync(path.join(dir, 'live')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'live', 'index.html'), a);
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), path.join(dir, 'live', 'board.js'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'bake-live.js'));
  const pay = path.join(dir, 'p.json');
  fs.writeFileSync(pay, JSON.stringify(sample()));
  execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-live.js'), '--from', pay], { stdio: 'pipe' });
  const b = fs.readFileSync(path.join(dir, 'live', 'index.html'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(a, b, 'bake is not idempotent');
});

test('an empty feed bakes the calm message, not an empty page', () => {
  const { html } = bakeInto({ updatedAt: new Date().toISOString(), regions: [], alerts: [] });
  assert.ok(between(html, 'board').includes('Clear at the hubs we track'), 'no calm message');
});

test('the baked timestamp is absolute, because a relative one rots in a cache', () => {
  const { html } = bakeInto(sample());
  const u = between(html, 'updated');
  assert.ok(/UTC/.test(u), `expected an absolute stamp, got ${JSON.stringify(u)}`);
  assert.ok(!/ago/.test(u), 'baked a relative time');
});

test('hostile strings in the feed cannot inject markup', () => {
  const nasty = '</div><script>alert(1)</script>';
  const { html } = bakeInto({
    updatedAt: new Date().toISOString(),
    regions: [{ region: nasty, airports: [{ airport: nasty, city: nasty, level: 2, status: nasty, note: nasty }] }],
    alerts: [{ when: nasty, summary: nasty, source: nasty, url: 'javascript:alert(1)', airports: [nasty], countries: [nasty] }],
  });
  const baked = between(html, 'board') + between(html, 'alerts');
  assert.ok(!baked.includes('<script>'), 'raw script tag reached the page');
  assert.ok(baked.includes('&lt;script&gt;'), 'script tag was not escaped');
  assert.ok(!/javascript:/i.test(baked), 'javascript: url reached the page');
  assert.ok(baked.includes('Source:'), 'source should still be shown as text when the link is refused');
});

test('a payload that is not an object is refused rather than written', () => {
  const original = fs.readFileSync(PAGE, 'utf8');
  const { html, status } = bakeInto('nope');
  assert.strictEqual(status, 2, 'expected exit 2');
  // Unchanged, not empty. The page on disk may already carry a baked board, and the point is
  // that a bad payload leaves whatever was there alone.
  assert.strictEqual(html, original, 'a bad payload altered the page');
});

test('--check reports drift without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-chk-'));
  fs.mkdirSync(path.join(dir, 'live')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(PAGE, path.join(dir, 'live', 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), path.join(dir, 'live', 'board.js'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'bake-live.js'));
  // Drift on purpose: a payload that differs from whatever the page currently carries. Using
  // the plain fixture would pass trivially whenever the page happened to be baked from it.
  const drifted = sample();
  drifted.regions[0].airports[0].city = 'Somewhere Else Entirely';
  const pay = path.join(dir, 'p.json');
  fs.writeFileSync(pay, JSON.stringify(drifted));
  const before = fs.readFileSync(path.join(dir, 'live', 'index.html'), 'utf8');
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-live.js'), '--from', pay, '--check'], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  const after = fs.readFileSync(path.join(dir, 'live', 'index.html'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(status, 1, 'expected exit 1 on drift');
  assert.strictEqual(before, after, '--check wrote to the file');
});

test('the shared module gives the page and the build the same markup', () => {
  const d = sample();
  const out = BOARD.renderAll(d);
  const { html } = bakeInto(d);
  assert.strictEqual(between(html, 'board'), out.board, 'baked board differs from renderAll');
  assert.strictEqual(between(html, 'alerts'), out.alerts, 'baked alerts differ from renderAll');
});

/** Hash of a board.js, in the form the baker puts in the query string. */
const hashOf = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);

/** A throwaway copy of the site with a board.js the caller can alter first. */
const tree = (mutateBoard) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-stamp-'));
  fs.mkdirSync(path.join(dir, 'live')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(PAGE, path.join(dir, 'live', 'index.html'));
  const board = path.join(dir, 'live', 'board.js');
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), board);
  if (mutateBoard) fs.writeFileSync(board, mutateBoard(fs.readFileSync(board, 'utf8')));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'bake-live.js'));
  const pay = path.join(dir, 'p.json');
  fs.writeFileSync(pay, JSON.stringify(sample()));
  const run = (args = []) => {
    let status = 0;
    try {
      execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-live.js'), '--from', pay, ...args], { stdio: 'pipe' });
    } catch (e) { status = e.status; }
    return { status, html: fs.readFileSync(path.join(dir, 'live', 'index.html'), 'utf8') };
  };
  return { dir, board, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const stampIn = (html) => {
  const m = html.match(/src="board\.js\?v=([0-9a-f]+)"/);
  return m ? m[1] : null;
};

test('the page asks for the board.js that is actually in the repo', () => {
  // The bug this guards: the page re-renders the board from board.js on load, so a browser
  // serving an older board.js out of its cache replaces correct server-rendered markup with
  // stale markup. That is how the per-airport links disappeared for anyone who had visited
  // before they were added. A hash in the URL makes a changed file a URL no cache has.
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.strictEqual(stampIn(html), hashOf(path.join(ROOT, 'live', 'board.js')),
    'live/index.html points at a different board.js than the one committed; re-run the bake');
});

test('a changed board.js gets a different URL', () => {
  const t = tree((src) => src + '\n// a change\n');
  try {
    const { html } = t.run();
    const got = stampIn(html);
    assert.ok(got, 'no stamp in the page');
    assert.strictEqual(got, hashOf(t.board), 'stamp does not match the file it is meant to describe');
    assert.notStrictEqual(got, hashOf(path.join(ROOT, 'live', 'board.js')),
      'a modified board.js produced the same URL as the unmodified one');
  } finally { t.done(); }
});

test('a tag with no version on it gets one', () => {
  const t = tree();
  try {
    const page = path.join(t.dir, 'live', 'index.html');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace(/src="board\.js\?v=[0-9a-f]+"/, 'src="board.js"'));
    const { html } = t.run();
    assert.strictEqual(stampIn(html), hashOf(t.board), 'an unstamped tag was left unstamped');
  } finally { t.done(); }
});

test('--check notices a stale board.js URL on its own', () => {
  // Isolating the stamp: bake first so the board markup is already current, then change only
  // board.js. Any drift --check reports after that is the URL and nothing else.
  const t = tree();
  try {
    t.run();
    fs.writeFileSync(t.board, fs.readFileSync(t.board, 'utf8') + '\n// later edit\n');
    const before = fs.readFileSync(path.join(t.dir, 'live', 'index.html'), 'utf8');
    const { status, html } = t.run(['--check']);
    assert.strictEqual(status, 1, 'expected exit 1 for a stale board.js URL');
    assert.strictEqual(html, before, '--check wrote to the file');
  } finally { t.done(); }
});

test('a page that does not load board.js fails loudly', () => {
  // Returning the HTML unstamped would be the quiet version of the original bug.
  const t = tree();
  try {
    const page = path.join(t.dir, 'live', 'index.html');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace(/<script src="board\.js[^"]*"><\/script>/, ''));
    const { status } = t.run();
    assert.strictEqual(status, 2, 'expected exit 2 when the script tag is gone');
  } finally { t.done(); }
});

test('the board.js URL is restamped even when the feed is down', () => {
  // Whether the renderer changed has nothing to do with whether Railway is answering, and a
  // stale renderer is the more damaging of the two things to leave in place.
  const t = tree((src) => src + '\n// changed while the feed was down\n');
  try {
    let status = 0;
    try {
      execFileSync(process.execPath, [path.join(t.dir, 'scripts', 'bake-live.js')],
        { stdio: 'pipe', env: { ...process.env, RUTA_LIVE_API: 'https://127.0.0.1:1/api/live' } });
    } catch (e) { status = e.status; }
    const html = fs.readFileSync(path.join(t.dir, 'live', 'index.html'), 'utf8');
    assert.strictEqual(status, 0, 'a dead feed should not fail the bake');
    assert.strictEqual(stampIn(html), hashOf(t.board), 'feed-down run left the old board.js URL');
    assert.ok(html.includes('<!--ruta:board:start-->'), 'board markers lost');
  } finally { t.done(); }
});


/**
 * The empty board, which said one thing about three different situations.
 *
 * `regions` only carries airports that HAVE a delay, so an empty board means either that every
 * hub polled is quiet or that nothing reported at all. Both used to render as "The skies are
 * running clear": an all clear over 44 airports drawn, in the second case, from zero readings.
 * The headline also described the sky rather than a board that watches 44 major airports.
 */
const BOARD2 = require(path.join(ROOT, 'live', 'board.js'));
const plainText = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('nothing reporting is not an all clear, and says so', () => {
  const t = plainText(BOARD2.clearHtml({ watched: 44, reporting: 0 }, false));
  assert.ok(/not an all clear/.test(t), t);
  assert.ok(!/are clear/.test(t), 'claimed clear with no readings: ' + t);
  assert.ok(t.includes('44'), 'does not say how many were silent');
});

test('every hub clear names the number the claim covers', () => {
  const t = plainText(BOARD2.clearHtml({ watched: 44, reporting: 44 }, false));
  assert.ok(t.includes('All 44 hubs we track are clear'), t);
  // The scope line is the point of the rewrite: this board is not the sky.
  assert.ok(/rather than every airport/.test(t), t);
});

test('a partial poll reports what reported and what did not', () => {
  const t = plainText(BOARD2.clearHtml({ watched: 44, reporting: 41 }, false));
  assert.ok(t.includes('41 hubs reporting'), t);
  assert.ok(t.includes('other 3 hubs'), 'did not account for the silent ones: ' + t);
});

test('arithmetic and grammar hold at the edges', () => {
  // Both of these were real bugs in the first draft: an undefined call in the partial branch
  // that threw, and "All 1 hub we track are clear" with "1 major airports" under it.
  assert.doesNotThrow(() => BOARD2.clearHtml({ watched: 44, reporting: 43 }, false));
  const one = plainText(BOARD2.clearHtml({ watched: 1, reporting: 1 }, false));
  assert.ok(one.includes('The hub we track is clear'), one);
  assert.ok(one.includes('1 major airport '), 'pluralised a single airport: ' + one);
  const off = plainText(BOARD2.clearHtml({ watched: 44, reporting: 43 }, false));
  assert.ok(off.includes('other 1 hub '), off);
});

test('a page served before the server carries the counts stays vague rather than inventing one', () => {
  // live/board.js ships to browsers ahead of the API deploy. No numbers means no numbers.
  const t = plainText(BOARD2.clearHtml({}, false));
  assert.ok(t.includes('Clear at the hubs we track'), t);
  assert.ok(!/\d/.test(t), 'invented a count from an older payload: ' + t);
});

test('the no-alerts wording still differs from the delays-only wording', () => {
  const delays = plainText(BOARD2.clearHtml({ watched: 44, reporting: 44 }, false));
  const both = plainText(BOARD2.clearHtml({ watched: 44, reporting: 44 }, true));
  assert.ok(delays.includes('No notable delays'), delays);
  assert.ok(both.includes('No delays or alerts'), both);
});

test('renderAll routes the empty board through the same branch the page uses', () => {
  // The build and the page must not disagree about the empty case, which is why renderAll exists.
  const r = BOARD2.renderAll({ watched: 44, reporting: 0, regions: [], alerts: [] });
  assert.ok(plainText(r.board).includes('not an all clear'), plainText(r.board));
});


test('a paused board says so, instead of reporting 44 silent airports', () => {
  // Live delay polling is the most expensive thing this site does and it is off while the budget
  // says so. Telling the page only that reporting is 0 would turn our own meter decision into a
  // claim about 44 airports.
  const t = plainText(BOARD2.clearHtml({ paused: true, watched: 44, reporting: 0 }, false));
  assert.match(t, /paused/i);
  assert.ok(!/not an all clear/.test(t), t);
  assert.ok(!/44/.test(t), 'a paused board counted airports: ' + t);
  // It has to point at what the page still has, or it reads as an outage notice.
  assert.match(t, /own page|terminals|lounges/i);
});

test('paused wins over every other empty state', () => {
  for (const d of [{ paused: true }, { paused: true, watched: 44, reporting: 44 },
                   { paused: true, watched: 0, reporting: 0 }]) {
    assert.match(plainText(BOARD2.clearHtml(d, false)), /paused/i, JSON.stringify(d));
  }
});

test('an unpaused board is unaffected', () => {
  const t = plainText(BOARD2.clearHtml({ paused: false, watched: 44, reporting: 44 }, false));
  assert.ok(!/paused/i.test(t), t);
  assert.match(t, /All 44 hubs we track are clear/);
});
