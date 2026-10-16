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
  assert.ok(html.includes('<script src="board.js"></script>'), 'board.js not loaded');
  assert.ok(html.includes('RutaBoard.renderAll'), 'page does not call the shared render');
  // The whole point: one definition. If a row template reappears inline, they will drift.
  assert.ok(!html.includes('function renderBoard('), 'renderBoard redefined inline');
  assert.ok(!html.includes('function renderAlerts('), 'renderAlerts redefined inline');
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
  assert.ok(between(html, 'board').includes('skies are running clear'), 'no calm message');
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
