/**
 * Tests for the per-airport page generator.
 *
 * The risk these guard is not a crash, it is publishing something wrong at scale. One bad page
 * is a typo; thirty-three bad pages is what teaches a crawler the domain is filler.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BOARD = require(path.join(ROOT, 'live', 'board.js'));
const FIXTURE = path.join(__dirname, 'fixtures', 'live-sample.json');
const sample = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** A throwaway copy of the site, so a test never writes into the real tree. */
const run = (payload, extraArgs = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-apt-'));
  fs.mkdirSync(path.join(dir, 'live'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'live', 'index.html'), path.join(dir, 'live', 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), path.join(dir, 'live', 'board.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bake-airports.js'), path.join(dir, 'scripts', 'bake-airports.js'));
  fs.copyFileSync(path.join(ROOT, 'sitemap.xml'), path.join(dir, 'sitemap.xml'));
  const facts = path.join(ROOT, 'live', 'airport-facts.json');
  if (fs.existsSync(facts)) fs.copyFileSync(facts, path.join(dir, 'live', 'airport-facts.json'));
  const pay = path.join(dir, 'p.json');
  fs.writeFileSync(pay, JSON.stringify(payload));
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-airports.js'), '--from', pay, ...extraArgs], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  const read = (p) => { try { return fs.readFileSync(path.join(dir, p), 'utf8'); } catch (e) { return null; } };
  const list = () => fs.readdirSync(path.join(dir, 'live')).filter((f) => fs.statSync(path.join(dir, 'live', f)).isDirectory());
  return { dir, status, read, list, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('writes one directory per airport, named by the shared slug', () => {
  const d = sample();
  const r = run(d);
  const expected = d.regions.flatMap((reg) => reg.airports.map((a) => BOARD.slugFor(a))).sort();
  assert.deepStrictEqual(r.list().sort(), expected);
  r.cleanup();
});

test('the slug matches what the board links to, or every link is a 404', () => {
  const d = sample();
  const r = run(d);
  const board = BOARD.boardHtml(d.regions);
  for (const slug of r.list()) {
    assert.ok(board.includes(`href="/live/${slug}/"`), `board does not link to ${slug}`);
  }
  r.cleanup();
});

test('titles and h1 read the way the query is phrased', () => {
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /<title>Los Angeles \(LAX\) Airport Delays \| Ruta Travels<\/title>/);
  assert.match(html, /<h1>Los Angeles \(LAX\) airport delays<\/h1>/);
  r.cleanup();
});

test('canonical points at the page itself', () => {
  const r = run(sample());
  const html = r.read('live/rome-fco/index.html');
  assert.match(html, /rel="canonical" href="https:\/\/rutatravels\.com\/live\/rome-fco\/"/);
  r.cleanup();
});

test('the description states the real figures, not a template', () => {
  const r = run(sample());
  const cdg = r.read('live/paris-cdg/index.html');
  const desc = cdg.match(/name="description" content="([^"]*)"/)[1];
  assert.match(desc, /severely disrupted/);
  assert.match(desc, /95 minutes late/);
  assert.match(desc, /61 flights cancelled/);
  r.cleanup();
});

test('an alert lands only on the airports it names', () => {
  const r = run(sample());
  // The French ATC alert tags CDG and ORY, not Rome.
  assert.match(r.read('live/paris-cdg/index.html'), /air traffic control strike in France/);
  assert.ok(!/air traffic control strike in France/.test(r.read('live/rome-fco/index.html')));
  assert.match(r.read('live/rome-fco/index.html'), /Fiumicino have called a four-hour walkout/);
  r.cleanup();
});

test('an airport with nothing wrong says so rather than showing an empty section', () => {
  const r = run(sample());
  const jfk = r.read('live/new-york-jfk/index.html');
  assert.match(jfk, /No disruption alerts affecting this airport right now/);
  assert.match(jfk, /running on time/);
  r.cleanup();
});

test('siblings link to the rest of the region and never to self', () => {
  const r = run(sample());
  const lax = r.read('live/los-angeles-lax/index.html');
  assert.match(lax, /href="\/live\/chicago-ord\/"/);
  assert.match(lax, /href="\/live\/denver-den\/"/);
  assert.ok(!/href="\/live\/los-angeles-lax\/"/.test(lax), 'page links to itself');
  // and not across regions
  assert.ok(!/href="\/live\/rome-fco\/"/.test(lax), 'North America page links a European airport');
  r.cleanup();
});

test('chrome is lifted from the board page rather than copied into a second design', () => {
  const r = run(sample());
  const html = r.read('live/london-lhr/index.html');
  const source = fs.readFileSync(path.join(ROOT, 'live', 'index.html'), 'utf8');
  const nav = source.slice(source.indexOf('<nav class="nav">'), source.indexOf('</nav>') + 6);
  assert.ok(html.includes(nav), 'nav differs from the board page');
  assert.ok(html.includes('<footer'), 'no footer');
  assert.ok(html.includes('--line') || html.includes('.row{'), 'stylesheet not lifted');
  r.cleanup();
});

test('every page links back to the board', () => {
  const r = run(sample());
  for (const slug of r.list()) {
    assert.match(r.read(`live/${slug}/index.html`), /href="\/live\/">/, `${slug} has no way back`);
  }
  r.cleanup();
});

test('hostile strings in the feed cannot inject markup', () => {
  const nasty = '</div><script>alert(1)</script>';
  const r = run({
    updatedAt: new Date().toISOString(),
    regions: [{ region: nasty, airports: [{ airport: 'XXX', city: nasty, level: 2, status: nasty, note: nasty }] }],
    alerts: [{ when: nasty, summary: nasty, source: nasty, url: 'javascript:alert(1)', airports: ['XXX'] }],
  });
  const html = r.read(`live/${r.list()[0]}/index.html`);
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(!body.includes('<script>alert'), 'raw script tag reached the page');
  assert.ok(!/javascript:/i.test(body), 'javascript: url reached the page');
  r.cleanup();
});

test('running twice writes nothing the second time', () => {
  const d = sample();
  const r = run(d);
  const before = r.list().map((s) => r.read(`live/${s}/index.html`));
  execFileSync(process.execPath, [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')], { stdio: 'pipe' });
  const after = r.list().map((s) => r.read(`live/${s}/index.html`));
  assert.deepStrictEqual(after, before, 'generator is not idempotent');
  r.cleanup();
});

test('--check reports drift without writing', () => {
  const d = sample();
  const r = run(d);
  const drifted = sample();
  drifted.regions[0].airports[0].status = 'Something else entirely';
  fs.writeFileSync(path.join(r.dir, 'p.json'), JSON.stringify(drifted));
  const before = r.read('live/los-angeles-lax/index.html');
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json'), '--check'], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  assert.strictEqual(status, 1, 'expected exit 1 on drift');
  assert.strictEqual(r.read('live/los-angeles-lax/index.html'), before, '--check wrote to a page');
  r.cleanup();
});

test('a payload with no regions is refused rather than wiping the pages', () => {
  const r = run({ updatedAt: new Date().toISOString(), alerts: [] });
  assert.strictEqual(r.status, 2, 'expected exit 2');
  assert.deepStrictEqual(r.list(), [], 'wrote pages from a payload with no regions');
  r.cleanup();
});

test('the sitemap gains the airport pages and keeps the hand-written ones', () => {
  const r = run(sample());
  const xml = r.read('sitemap.xml');
  assert.match(xml, /https:\/\/rutatravels\.com\/live\/paris-cdg\//);
  // The entries that were there before this script existed must survive it.
  assert.match(xml, /<loc>https:\/\/rutatravels\.com\/<\/loc>/);
  assert.match(xml, /https:\/\/rutatravels\.com\/blog\//);
  assert.match(xml, /<!--ruta:airports:start-->/);
  r.cleanup();
});

test('the sitemap does not accumulate duplicates across runs', () => {
  const r = run(sample());
  execFileSync(process.execPath, [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')], { stdio: 'pipe' });
  const xml = r.read('sitemap.xml');
  const hits = (xml.match(/\/live\/paris-cdg\//g) || []).length;
  assert.strictEqual(hits, 1, `paris-cdg appears ${hits} times`);
  r.cleanup();
});



test('a calm airport still has something worth reading', () => {
  // The reason these pages exist at all is the long tail of "JFK delays" searches, and the
  // reason they could fail is that most airports are on time most of the time. Live status
  // alone was 56 words. A page that thin, multiplied across the board, is what a crawler files
  // as filler rather than as a reference.
  const r = run(sample());
  const html = r.read('live/new-york-jfk/index.html');
  const body = html.slice(html.indexOf('<div class="wrap">'), html.indexOf('class="cta"'));
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  assert.ok(words > 100, `calm-airport page is ${words} words, still thin`);
  assert.match(html, /John F\. Kennedy International/);
  assert.match(html, /122 gates/);
  r.cleanup();
});

test('uses the word the airport uses, not a generic one', () => {
  const d = sample();
  d.regions[0].airports.push({ airport: 'ATL', city: 'Atlanta', level: 1, status: 'Minor delays' });
  const r = run(d);
  const atl = r.read('live/atlanta-atl/index.html');
  // Atlanta has Concourses. Calling them Terminals reads as not knowing the airport.
  assert.match(atl, /7 concourses/);
  assert.ok(!/7 terminals/.test(atl), 'called Atlanta concourses terminals');
  const jfk = r.read('live/new-york-jfk/index.html');
  assert.match(jfk, /5 terminals/);
  r.cleanup();
});

test('an airport with no facts entry still builds', () => {
  const d = sample();
  d.regions[0].airports.push({ airport: 'ZZZ', city: 'Nowhere', level: 0, status: 'On time' });
  const r = run(d);
  const html = r.read('live/nowhere-zzz/index.html');
  assert.ok(html, 'page was not written');
  assert.ok(!/Inside ZZZ/.test(html), 'invented a facts section with no data');
  r.cleanup();
});

test('builds without the facts file at all, rather than failing the job', () => {
  const r = run(sample());
  fs.rmSync(path.join(r.dir, 'live', 'airport-facts.json'), { force: true });
  fs.rmSync(path.join(r.dir, 'live', 'new-york-jfk'), { recursive: true, force: true });
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  assert.strictEqual(status, 0, 'a missing facts file failed the build');
  assert.ok(r.read('live/new-york-jfk/index.html'), 'no page written without facts');
  r.cleanup();
});

test('the facts table is a table, with a caption screen readers can use', () => {
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /<table class="terms">/);
  assert.match(html, /<caption class="sr-only">/);
  assert.match(html, /<th scope="row">/);
  r.cleanup();
});
