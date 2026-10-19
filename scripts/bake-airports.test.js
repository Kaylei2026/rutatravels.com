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
const run = (payload, extraArgs = [], opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-apt-'));
  fs.mkdirSync(path.join(dir, 'live'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'live', 'index.html'), path.join(dir, 'live', 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'live', 'board.js'), path.join(dir, 'live', 'board.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bake-airports.js'), path.join(dir, 'scripts', 'bake-airports.js'));
  fs.copyFileSync(path.join(ROOT, 'sitemap.xml'), path.join(dir, 'sitemap.xml'));
  const facts = path.join(ROOT, 'live', 'airport-facts.json');
  if (fs.existsSync(facts)) fs.copyFileSync(facts, path.join(dir, 'live', 'airport-facts.json'));
  if (opts.weather) fs.writeFileSync(path.join(dir, 'live', 'airport-weather.json'), JSON.stringify({ airports: opts.weather }));
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
  // Terminal names, not counts. The counts in AIRPORTS are inference data and do not survive
  // contact with an official source.
  assert.match(html, /has 5 terminals/);
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

test('the terminal list is a list, and announces what it is', () => {
  // It was a one-column table, which makes a screen reader announce rows and columns that carry
  // no meaning.
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /<ul class="terms-l" aria-label="Terminals at LAX">/);
  assert.match(html, /<li>Tom Bradley Intl<\/li>/);
  assert.ok(!/<table class="terms/.test(html), 'still a table');
  r.cleanup();
});


test('one of a thing reads as one of a thing', () => {
  // "1 play areas" is the tell that a page was generated rather than written.
  const r = run(sample());
  const lax = r.read('live/los-angeles-lax/index.html');
  assert.ok(!/>1<\/strong> [a-z ]*s</.test(lax), 'a count of 1 kept its plural label');
  r.cleanup();
});

test('the accessibility section carries real counts, not a boast', () => {
  const r = run(sample());
  const lax = r.read('live/los-angeles-lax/index.html');
  assert.match(lax, /Getting around LAX/);
  assert.match(lax, /accessible restrooms?/);
  assert.match(lax, /lifts?/);
  // The claim has to be tied to the app's behaviour, not floated on its own.
  assert.match(lax, /every walking estimate slows to match/);
  r.cleanup();
});

test('terminal services name real places and where they are', () => {
  const r = run(sample());
  const lax = r.read('live/los-angeles-lax/index.html');
  assert.match(lax, /Eating and shopping at LAX/);
  assert.match(lax, /Hudson News/);
  assert.match(lax, /class="loc">Main Hall</);
  r.cleanup();
});

test('an airport with no services section does not get an empty heading', () => {
  const d = sample();
  d.regions[0].airports.push({ airport: 'ZZZ', city: 'Nowhere', level: 0, status: 'On time' });
  const r = run(d);
  const z = r.read('live/nowhere-zzz/index.html');
  assert.ok(!/Eating, shopping and lounges/.test(z));
  assert.ok(!/Getting around ZZZ/.test(z));
  r.cleanup();
});


test('every section is a card, so the gaps between them are one rule', () => {
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  const cards = (html.match(/<section class="card"/g) || []).length;
  assert.ok(cards >= 5, `only ${cards} sections are cards`);
  r.cleanup();
});

test('no link falls through to the browser default', () => {
  // On a navy background an unstyled link is bright blue turning purple. The board's stylesheet
  // only covers the few places the board itself has links, so anything new needs its own class.
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  const body = html.slice(html.indexOf('<div class="wrap">'), html.indexOf('class="cta"'));
  const bare = body.match(/<a (?!class=)[^>]*href=/g) || [];
  assert.deepStrictEqual(bare, [], 'found a link with no class');
  r.cleanup();
});

test('no gate counts are published anywhere', () => {
  // AIRPORTS gate lists are terminal-inference data, not an inventory. DFW is five terminals of
  // exactly 40, Denver two concourses of exactly 95, ORD sums to 152 against an official 199.
  // Printing them as counts puts visibly invented numbers on a reference page.
  const r = run(sample());
  for (const slug of r.list()) {
    const html = r.read(`live/${slug}/index.html`);
    const body = html.slice(html.indexOf('<div class="wrap">'), html.indexOf('class="cta"'));
    assert.ok(!/\d+ gates/.test(body), `${slug} publishes a gate count`);
    assert.ok(!/gates across/.test(body), `${slug} publishes a gate total`);
  }
  r.cleanup();
});

test('terminal names are still published, because those check out', () => {
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /Tom Bradley Intl/);
  assert.match(html, /has 8 terminals/);
  assert.match(html, /Terminal data as of \d{4}-\d{2}-\d{2}/);
  r.cleanup();
});


test('the services section does not present a sample as an inventory', () => {
  // TERMINAL_SERVICES holds about one representative item per category per terminal. 76% of
  // terminals listing any lounge list exactly one; ORD shows four against a real eleven.
  // Counting them on the page implies a completeness the data does not have.
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /Some of what you will find inside/);
  assert.ok(!/\d+ places across/.test(html), 'counted the sample as if it were a directory');
  r.cleanup();
});


const stampOf = (minsAgo) =>
  new Date(Date.now() - minsAgo * 60000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const wxAt = (minsAgo, over = {}) => ({
  tempF: 68, feelsF: 67, description: 'broken clouds', icon: '04d', windMph: 9,
  readAt: new Date(Date.now() - minsAgo * 60000).toISOString(),
  fetchedAt: new Date(Date.now() - minsAgo * 60000).toISOString(),
  ...over,
});

test('weather shows when it was read, as a time rather than an age', () => {
  const r = run(sample(), [], { weather: { LAX: wxAt(20) } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /Weather at LAX/);
  assert.match(html, /68&deg;F/);
  assert.match(html, /broken clouds/);
  assert.match(html, new RegExp('Read ' + stampOf(20).replace(/[-:]/g, '[-:]')));
  r.cleanup();
});

test('the stamp is absolute, because a relative age on static HTML freezes at bake time', () => {
  // A page baked now and read in two hours must not still claim the reading is minutes old.
  // "0 min ago" on every freshly baked page is what this replaced.
  const r = run(sample(), [], { weather: { LAX: wxAt(0) } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.ok(!/min ago/.test(html), 'still printing a relative age');
  assert.ok(!/hr ago/.test(html), 'still printing a relative age');
  assert.match(html, /Read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  r.cleanup();
});

test('an older reading is stamped with its own time, not the bake time', () => {
  // A fixed instant, not Date.now() minus an offset. Computing the expected stamp a second time
  // at assert time makes this fail whenever the run straddles a minute boundary, which it did.
  const FIXED = '2026-03-04T05:06:00.000Z';
  const r = run(sample(), [], { weather: { LAX: { ...wxAt(0), readAt: FIXED, fetchedAt: FIXED } } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /Read 2026-03-04 05:06 UTC/);
  assert.ok(!html.includes('Read ' + stampOf(0)), 'stamped with the bake time instead');
  r.cleanup();
});

test('a snapshot written before the rename still renders, rather than losing its stamp', () => {
  const r = run(sample(), [], { weather: { LAX: wxAt(45, { readAt: undefined, observedAt: new Date(Date.now() - 45 * 60000).toISOString() }) } });
  assert.match(r.read('live/los-angeles-lax/index.html'), /Read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  r.cleanup();
});

test('a reading with no usable time still shows the temperature, without a stamp', () => {
  const r = run(sample(), [], { weather: { LAX: { tempF: 68, description: 'clear sky', readAt: null, fetchedAt: null } } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /68&deg;F/);
  assert.ok(!/Read \d{4}/.test(html), 'invented a stamp');
  assert.match(html, /can lag a change in conditions/);
  r.cleanup();
});

test('an airport with no reading gets no weather card rather than an empty one', () => {
  const r = run(sample(), [], { weather: { LAX: wxAt(10) } });
  assert.ok(!/Weather at JFK/.test(r.read('live/new-york-jfk/index.html')));
  r.cleanup();
});

test('no weather file at all still builds', () => {
  const r = run(sample());
  assert.ok(r.read('live/los-angeles-lax/index.html'), 'page missing');
  assert.ok(!/Weather at LAX/.test(r.read('live/los-angeles-lax/index.html')));
  r.cleanup();
});

test('a reading with no temperature and no description is not rendered', () => {
  const r = run(sample(), [], { weather: { LAX: { tempF: null, description: null, fetchedAt: new Date().toISOString() } } });
  assert.ok(!/Weather at LAX/.test(r.read('live/los-angeles-lax/index.html')));
  r.cleanup();
});

test('a partial reading renders what it has', () => {
  const r = run(sample(), [], { weather: { LAX: { tempF: 71, description: null, windMph: null, fetchedAt: new Date().toISOString() } } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /71&deg;F/);
  assert.ok(!/wind/.test(html.slice(html.indexOf('Weather at LAX'), html.indexOf('Weather at LAX') + 400)));
  r.cleanup();
});

test('does not promise lounges in a heading it cannot deliver on', () => {
  // That column is 451 entries across 99 airports and only 195 are lounges. Prayer Room (55),
  // Family Restroom (48), Quiet Room (42) and Nursing Room (28) lead it, so at LAX Terminal 2 the
  // entry filed under "Lounges" was a family restroom. The app's own lounge data was audited the
  // same day and found to list rooms that are not there at all.
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.ok(!/Eating, shopping and lounges/.test(html), 'heading still promises lounges');
  assert.ok(!/Lounges and more/.test(html), 'column is still labelled Lounges');
  assert.match(html, /Eating and shopping at LAX/);
  r.cleanup();
});

test('still shows the things that are inside, under an honest label', () => {
  const r = run(sample());
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /Also inside/);
  // A lounge that IS in the data still appears; it is the claim that changed, not the content.
  assert.match(html, /Alaska Lounge/);
  r.cleanup();
});

test('the page says the figure can lag, rather than implying it is live', () => {
  const r = run(sample(), [], { weather: { LAX: wxAt(20) } });
  const html = r.read('live/los-angeles-lax/index.html');
  assert.match(html, /can lag a change in conditions/);
  r.cleanup();
});

test('bake-weather does nothing without a key, rather than failing the build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-wx-'));
  fs.mkdirSync(path.join(dir, 'live')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'live', 'airport-facts.json'), path.join(dir, 'live', 'airport-facts.json'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bake-weather.js'), path.join(dir, 'scripts', 'bake-weather.js'));
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-weather.js')],
      { stdio: 'pipe', env: { ...process.env, RUTA_API_KEY: '' } });
  } catch (e) { status = e.status; }
  assert.strictEqual(status, 0, 'a missing key failed the build');
  assert.ok(!fs.existsSync(path.join(dir, 'live', 'airport-weather.json')), 'wrote a file with no key');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the freshness stamp sits with the status, not in the hero', () => {
  // In the hero it was the first concrete thing under the headline and dated nothing in
  // particular, so it read as the date the page was last edited rather than the time of the
  // delay reading. Under the status it is unambiguous. Asserted rather than left to taste,
  // because the obvious place to put a timestamp while editing the template is the hero.
  const r = run(sample());
  const html = r.read(path.join('live', 'atlanta-atl', 'index.html'))
    || r.read(path.join('live', r.list()[0], 'index.html'));
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf('<div class="wrap">'));
  const stamp = /Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/;
  assert.ok(stamp.test(html), 'the page lost its freshness stamp entirely');
  assert.ok(!stamp.test(hero), 'the stamp is back in the hero');
  const card = html.slice(html.indexOf('aria-label="Right now"'));
  const end = card.indexOf('</section>');
  assert.ok(stamp.test(card.slice(0, end)), 'the stamp is not in the Right now card');
  r.cleanup();
});

/**
 * The lounge section, and the column it replaced.
 *
 * The page was already showing lounges before this section existed, through "Also inside", which
 * samples roughly one item per category per terminal. Heathrow showed 5 of its 36 and Hong Kong
 * 1 of 18, so a reader counted what was in front of them and got a number nobody had claimed.
 * Across the 38 pages the column surfaced 97 against 547. These tests guard both halves of the
 * fix: the section is right, and the column no longer competes with it.
 */
const LOUNGE_FILE = path.join(ROOT, 'live', 'airport-lounges.json');
const loungeData = () => JSON.parse(fs.readFileSync(LOUNGE_FILE, 'utf8')).airports;
const factsData = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'live', 'airport-facts.json'), 'utf8')).airports;

/** Like run(), with the lounge file present unless told otherwise. */
const runL = (payload, opts = {}) => {
  const withLounges = opts.withLounges !== false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-lng-'));
  fs.mkdirSync(path.join(dir, 'live'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const f of ['index.html', 'board.js']) {
    fs.copyFileSync(path.join(ROOT, 'live', f), path.join(dir, 'live', f));
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bake-airports.js'), path.join(dir, 'scripts', 'bake-airports.js'));
  fs.copyFileSync(path.join(ROOT, 'sitemap.xml'), path.join(dir, 'sitemap.xml'));
  const facts = path.join(ROOT, 'live', 'airport-facts.json');
  if (fs.existsSync(facts)) fs.copyFileSync(facts, path.join(dir, 'live', 'airport-facts.json'));
  if (withLounges) {
    const dest = path.join(dir, 'live', 'airport-lounges.json');
    if (opts.lounges) fs.writeFileSync(dest, JSON.stringify(opts.lounges));
    else fs.copyFileSync(LOUNGE_FILE, dest);
  }
  const pay = path.join(dir, 'p.json');
  fs.writeFileSync(pay, JSON.stringify(payload));
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'bake-airports.js'), '--from', pay], { stdio: 'pipe' });
  } catch (e) { status = e.status; }
  const read = (slug) => {
    try { return fs.readFileSync(path.join(dir, 'live', slug, 'index.html'), 'utf8'); }
    catch (e) { return null; }
  };
  return { status, read, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const card = (html, label) => {
  const i = String(html || '').indexOf(`aria-label="${label}"`);
  return i === -1 ? null : html.slice(i, html.indexOf('</section>', i));
};

const payloadOf = (airports) => ({
  updatedAt: new Date().toISOString(),
  regions: [{ region: 'Test', airports }],
  alerts: [],
});

const APT = (airport, city) => ({ airport, city, level: 0, status: 'On time', note: '' });

test('an audited airport gets its real lounge count, not a sample of it', () => {
  const r = runL(payloadOf([APT('ORD', 'Chicago')]));
  try {
    const lng = card(r.read('chicago-ord'), 'Lounges');
    assert.ok(lng, 'no lounge section');
    const expected = loungeData().ORD.lounges.length;
    const rows = (lng.match(/<li>/g) || []).length;
    assert.strictEqual(rows, expected, `rendered ${rows} lounges, data has ${expected}`);
    // The headline number is the thing a reader counts, so it has to match the rows under it.
    const m = lng.match(/>(\d+) lounges/);
    assert.ok(m, 'no count in the headline');
    assert.strictEqual(Number(m[1]), expected, 'headline count disagrees with the rows');
  } finally { r.cleanup(); }
});

test('every lounge brings its access list with it', () => {
  // Under-reporting what opens a door is the failure this section exists to fix, so access is
  // printed in full rather than trimmed to fit.
  const r = runL(payloadOf([APT('ORD', 'Chicago')]));
  try {
    const lng = card(r.read('chicago-ord'), 'Lounges');
    for (const l of loungeData().ORD.lounges) {
      assert.ok(lng.includes(l.name), `${l.name} missing`);
      for (const a of (l.access || [])) {
        assert.ok(lng.includes(a.replace(/&/g, '&amp;')), `${l.name} lost access string ${a}`);
      }
    }
  } finally { r.cleanup(); }
});

test('a lounge with no access list still appears', () => {
  // Driven by a made-up lounge rather than a real one. The first version of this test found an
  // access-less room in the real data and asserted it rendered, with a note saying to point the
  // test elsewhere if ORD ever lost its example. Every such room has since been filled in, so
  // there is nowhere to point it: the data no longer contains the case. The behaviour still
  // matters, because the next room nobody can source will hit it, and an omitted access line is
  // honest while dropping the room would be an undercount. So the case is constructed.
  const real = loungeData();
  assert.ok(
    !Object.values(real).some((a) => a.lounges.some((l) => !l.access || !l.access.length)),
    'the real data has an access-less lounge again; fill it in rather than relying on this test',
  );
  const lounges = { airports: { ORD: { lounges: [
    { name: 'Nameless Lounge', terminal: '1', location: 'Somewhere' },
    { name: 'Second Lounge', terminal: '1', access: ['Priority Pass'] },
  ] } } };
  const r = runL(payloadOf([APT('ORD', 'Chicago')]), { lounges });
  try {
    const lng = card(r.read('chicago-ord'), 'Lounges');
    assert.ok(lng.includes('Nameless Lounge'), 'a lounge was dropped for having no access');
    assert.ok(lng.includes('Priority Pass'), 'the lounge that does have access lost it');
    assert.strictEqual((lng.match(/<li>/g) || []).length, 2, 'wrong number of rows');
    assert.strictEqual((lng.match(/class="lng-a"/g) || []).length, 1,
      'an empty access line was printed for the lounge that has none');
  } finally { r.cleanup(); }
});

test('terminal headings use the word the airport itself uses', () => {
  const r = runL(payloadOf([APT('ATL', 'Atlanta'), APT('CPT', 'Cape Town'), APT('ORD', 'Chicago')]));
  try {
    // Atlanta has concourses, not terminals, and the facts file is where that word comes from.
    const atl = card(r.read('atlanta-atl'), 'Lounges');
    assert.ok(/<h3>Concourse A<\/h3>/.test(atl), 'Atlanta should say Concourse A');
    assert.ok(!/<h3>Terminal A<\/h3>/.test(atl), 'Atlanta should not say Terminal');
    // "T1" must not print as "Terminal T1".
    const ord = card(r.read('chicago-ord'), 'Lounges');
    assert.ok(/<h3>Terminal 1<\/h3>/.test(ord), 'ORD should say Terminal 1');
    assert.ok(!/Terminal T1/.test(ord), 'the T was printed twice');
    // Cape Town stores DOMESTIC in capitals; a heading should not shout at one airport only.
    const cpt = card(r.read('cape-town-cpt'), 'Lounges');
    assert.ok(!/DOMESTIC/.test(cpt), 'raw capitals reached a heading');
    assert.ok(/Domestic/.test(cpt), 'Cape Town lost its domestic grouping');
  } finally { r.cleanup(); }
});

test('an airport with no lounge data gets no lounge section', () => {
  // The whole reason the section is safe to publish. A short list presented as an inventory is
  // worse than the sample column, which never claimed to be one.
  const r = runL(payloadOf([APT('ORD', 'Chicago'), APT('DEN', 'Denver')]),
    { lounges: { airports: { ORD: loungeData().ORD } } });
  try {
    assert.ok(card(r.read('chicago-ord'), 'Lounges'), 'ORD should have a section');
    assert.strictEqual(card(r.read('denver-den'), 'Lounges'), null, 'DEN has no lounge data and got a section');
  } finally { r.cleanup(); }
});

test('no lounge file at all builds the pages without the claim', () => {
  const r = runL(payloadOf([APT('ORD', 'Chicago')]), { withLounges: false });
  try {
    assert.strictEqual(r.status, 0, 'a missing lounge file should not fail the bake');
    const html = r.read('chicago-ord');
    assert.ok(html, 'no page written');
    assert.strictEqual(card(html, 'Lounges'), null, 'a section appeared with nothing behind it');
  } finally { r.cleanup(); }
});

test('no lounge is listed in both the section and the sample column', () => {
  // Measured rather than assumed: this walks every audited airport in the facts file, because
  // the leaks past a plain lounge|club were one room each at Heathrow, CDG and Hong Kong.
  const LOUNGE_NAME = /\b(lounge|club|clubhouse|galleries|salon)\b|centurion|la premi[eè]re|the pier/i;
  const facts = factsData();
  const lounges = loungeData();
  const leaks = [];
  for (const [code, f] of Object.entries(facts)) {
    if (!lounges[code]) continue;
    for (const t of (f.terminalServices || [])) {
      for (const x of (t.other || [])) {
        const n = String((x && x.name) || '').trim();
        if (!n || LOUNGE_NAME.test(n)) continue;
        if ((lounges[code].lounges || []).some((l) => l.name.toLowerCase() === n.toLowerCase())) {
          leaks.push(`${code}: ${n}`);
        }
      }
    }
  }
  assert.deepStrictEqual(leaks, [], 'a lounge survives in the sample column');
});

test('the sample column keeps the things it is actually good at', () => {
  // The other half of the filter. Prayer rooms, quiet rooms and family restrooms are the most
  // common entries in that column and the reason to keep it at all; a filter that took them
  // would have fixed the count by emptying the page.
  const r = runL(payloadOf([APT('ORD', 'Chicago'), APT('LHR', 'London')]));
  try {
    assert.ok(/Quiet Room/.test(card(r.read('chicago-ord'), 'Eating and shopping')), 'ORD lost its quiet room');
    const lhr = card(r.read('london-lhr'), 'Eating and shopping');
    assert.ok(/Prayer Room/.test(lhr), 'LHR lost its prayer room');
    // The two rooms that got past a plain lounge|club.
    assert.ok(!/Virgin Clubhouse/.test(lhr), 'Virgin Clubhouse still in the sample column');
    assert.ok(!/BA Galleries First/.test(lhr), 'BA Galleries First still in the sample column');
  } finally { r.cleanup(); }
});

test('the exported lounge file carries only what a reader can see', () => {
  const data = loungeData();
  assert.ok(Object.keys(data).length > 30, 'suspiciously few airports in the lounge file');
  for (const [code, a] of Object.entries(data)) {
    assert.ok(/^[A-Z]{3}$/.test(code), `${code} is not an airport code`);
    assert.ok(Array.isArray(a.lounges) && a.lounges.length, `${code} has an empty lounge list`);
    for (const l of a.lounges) {
      assert.ok(l.name && typeof l.name === 'string', `${code} has a lounge with no name`);
      if (l.access !== undefined) assert.ok(Array.isArray(l.access), `${code}/${l.name} access is not a list`);
      // The audit's own reasoning (why a room was excluded, which source settled a conflict)
      // belongs in the repo, not in a file served to browsers.
      for (const k of Object.keys(l)) assert.ok(k[0] !== '_', `${code}/${l.name} leaked ${k} to the site`);
    }
  }
});

test('every terminal heading reads like the airport wrote it', () => {
  // One airport per shape in the data, chosen by measuring all 82: concourse letters, a "T1"
  // style key, a slash pair, a letter plus a word, an all-capitals word, a name with internal
  // capitals, a direction, a satellite, an airside, a letter-suffixed number, and an airport
  // with a lounge whose terminal is not recorded at all.
  const SHAPES = [
    ['ATL', 'Atlanta'], ['ORD', 'Chicago'], ['CLT', 'Charlotte'], ['PHL', 'Philadelphia'],
    ['CPT', 'Cape Town'], ['DTW', 'Detroit'], ['LGW', 'London'], ['BKK', 'Bangkok'],
    ['TPA', 'Tampa'], ['MAD', 'Madrid'], ['ZRH', 'Zurich'],
  ];
  const r = runL(payloadOf(SHAPES.map(([c, city]) => APT(c, city))));
  try {
    const heads = [];
    for (const [code] of SHAPES) {
      const slug = BOARD.slugFor({ airport: code, city: SHAPES.find((x) => x[0] === code)[1] });
      const lng = card(r.read(slug), 'Lounges');
      assert.ok(lng, `${code} has no lounge section`);
      for (const m of lng.matchAll(/<h3>([^<]*)<\/h3>/g)) heads.push([code, m[1]]);
      // An unlabelled group above a labelled one reads as though it belonged to the heading
      // below it, so the unlabelled one goes last.
      const groups = [...lng.matchAll(/<div class="lng-t">(<h3>)?/g)].map((m) => !!m[1]);
      if (groups.length > 1 && groups.includes(false)) {
        assert.ok(groups.indexOf(false) > groups.lastIndexOf(true),
          `${code} puts an unlabelled group above a labelled one`);
      }
    }
    assert.ok(heads.length > 20, 'too few headings to be testing anything');
    for (const [code, h] of heads) {
      // "Domestic terminal" beside "Terminal 2" is the bug this catches.
      assert.ok(!/\b(terminal|concourse|airside|pier)\b/.test(h),
        `${code}: "${h}" has a lowercase terminal word`);
      assert.ok(!/\bT\d/.test(h), `${code}: "${h}" printed the T twice`);
      assert.notStrictEqual(h, h.toUpperCase(), `${code}: "${h}" is shouting`);
      assert.ok(/^[A-Z]/.test(h), `${code}: "${h}" does not start with a capital`);
    }
    const all = heads.map(([, h]) => h);
    // Each branch, by its own example.
    assert.ok(all.includes('Concourse A'), 'Atlanta lost its concourse word');
    assert.ok(all.includes('Terminal 1'), 'a T1 key did not become Terminal 1');
    assert.ok(all.includes('Concourse C/D'), 'a slash pair came out the wrong way round');
    assert.ok(all.includes('Terminal A West'), 'a letter plus a word came out the wrong way round');
    assert.ok(all.includes('Domestic Terminal'), 'an all-capitals word was not reshaped');
    assert.ok(all.includes('McNamara Terminal'), 'internal capitals were flattened to Mcnamara');
    assert.ok(all.includes('North Terminal'), 'a direction came out the wrong way round');
    assert.ok(all.includes('Satellite Concourse'), 'a satellite came out the wrong way round');
    assert.ok(all.includes('Airside F'), 'Tampa lost its airside word');
    assert.ok(all.includes('Terminal 4S'), 'a letter-suffixed number lost its letter');
  } finally { r.cleanup(); }
});


/**
 * The airport pages were reachable by nothing.
 *
 * The bake only receives airports that HAVE a delay, and the slug list it built from that fed both
 * the sitemap and, before this, nothing else. On a quiet board that list is empty, so the sitemap's
 * airports block was emptied and the /live page had no rows to link from. Thirty-eight pages sat on
 * disk, in no sitemap and behind no link, discoverable only in the minority of hours when their own
 * airport happened to be delayed. Both of those now answer "which pages exist", which is a
 * directory listing rather than a feed reading.
 */

/** Pretend a previous bake left pages behind, which is the normal state of that directory. */
const withExistingPages = (r, slugs) => {
  for (const s of slugs) {
    fs.mkdirSync(path.join(r.dir, 'live', s), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'live', s, 'index.html'), '<!doctype html><title>old</title>');
  }
};

const indexBlock = (html) => {
  const a = html.indexOf('<!--ruta:airports:start-->');
  const b = html.indexOf('<!--ruta:airports:end-->');
  assert.ok(a > -1 && b > a, 'no airports block in the page');
  return html.slice(a, b);
};

const linkedSlugs = (html) => [...indexBlock(html)
  .matchAll(/class="aix" href="\/live\/([a-z0-9-]+)\//g)].map((m) => m[1]).sort();

const sitemapSlugs = (xml) => [...String(xml)
  .matchAll(/<loc>https:\/\/rutatravels\.com\/live\/([a-z0-9-]+)\/<\/loc>/g)].map((m) => m[1]).sort();

test('a quiet board still lists every page that exists', () => {
  // The bug, exactly. No delays anywhere, so nothing is built, and before this both the sitemap
  // and the page went blank on the subject.
  const r = run({ updatedAt: new Date().toISOString(), regions: [], alerts: [] });
  try {
    withExistingPages(r, ['chicago-ord', 'london-lhr', 'tokyo-hnd']);
    // Re-run against the same tree, now that pages are sitting in it.
    const again = execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe', encoding: 'utf8' });
    assert.match(again, /3 pages on disk|3 total/);
    const html = r.read('live/index.html');
    assert.deepStrictEqual(linkedSlugs(html), ['chicago-ord', 'london-lhr', 'tokyo-hnd']);
    assert.deepStrictEqual(sitemapSlugs(r.read('sitemap.xml')), ['chicago-ord', 'london-lhr', 'tokyo-hnd']);
  } finally { r.cleanup(); }
});

test('a busy board lists the pages it built and the ones already there', () => {
  const d = sample();
  const r = run(d);
  try {
    const built = d.regions.flatMap((reg) => reg.airports.map((a) => BOARD.slugFor(a)));
    withExistingPages(r, ['zurich-zrh']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    const linked = linkedSlugs(r.read('live/index.html'));
    for (const s of [...built, 'zurich-zrh']) assert.ok(linked.includes(s), `${s} not linked`);
  } finally { r.cleanup(); }
});

test('the links are in the HTML, not drawn by board.js', () => {
  // board.js only ever receives airports with a delay, so anything it drew would disappear at
  // exactly the moment these links are the only way in. A crawler does not run scripts either.
  const r = run(sample());
  try {
    const html = r.read('live/index.html');
    assert.ok(/<a class="aix" href="\/live\//.test(html), 'no baked links');
    assert.ok(!/aix/.test(fs.readFileSync(path.join(ROOT, 'live', 'board.js'), 'utf8')),
      'board.js now renders the index, which puts it back behind the feed');
  } finally { r.cleanup(); }
});

test('it names the airport, not just the slug', () => {
  const r = run({ updatedAt: new Date().toISOString(), regions: [], alerts: [] });
  try {
    withExistingPages(r, ['abu-dhabi-auh', 'new-york-jfk']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    const block = indexBlock(r.read('live/index.html'));
    // Multi-word cities are the case a naive split gets wrong.
    assert.match(block, /Abu Dhabi <span>AUH<\/span>/);
    assert.match(block, /New York <span>JFK<\/span>/);
  } finally { r.cleanup(); }
});

test('--check notices when the index has fallen behind', () => {
  const r = run(sample());
  try {
    withExistingPages(r, ['oslo-osl']);
    const code = (() => {
      try {
        execFileSync(process.execPath,
          [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json'), '--check'],
          { stdio: 'pipe' });
        return 0;
      } catch (e) { return e.status; }
    })();
    assert.strictEqual(code, 1, '--check passed while a page was missing from the index');
    assert.ok(!linkedSlugs(r.read('live/index.html')).includes('oslo-osl'), '--check wrote the file');
  } finally { r.cleanup(); }
});


/**
 * The paused switch on the airport pages.
 *
 * Delay polling is off while the AeroDataBox budget says so. A page that keeps leading with
 * "is running on time right now" from a reading nobody is refreshing goes from true to false
 * without changing a character, and these pages are not rebuilt while the feed carries nothing.
 * So paused changes what the page claims to be, from the title down, and the build list stops
 * depending on the feed carrying airports at all.
 */
const paused = (over = {}) => ({ updatedAt: null, paused: true, regions: [], alerts: [], ...over });

test('a paused build still rebuilds the pages that exist', () => {
  // The bug this exists to prevent: the feed carries no airports, the loop runs zero times, and
  // 38 pages keep yesterday's status forever.
  const r = run(paused());
  try {
    withExistingPages(r, ['chicago-ord', 'london-lhr']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    const html = r.read('live/chicago-ord/index.html');
    assert.ok(html && !/<title>old<\/title>/.test(html), 'the existing page was left alone');
    assert.match(html, /Chicago \(ORD\)/);
  } finally { r.cleanup(); }
});

test('paused leads with the airport, not with a delay figure', () => {
  const r = run(paused());
  try {
    withExistingPages(r, ['chicago-ord']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    const html = r.read('live/chicago-ord/index.html');
    assert.match(html, /<title>Chicago \(ORD\) Airport Guide/);
    assert.match(html, /<h1>Chicago \(ORD\) airport guide<\/h1>/);
    assert.ok(!/is running on time right now/.test(html), 'still claiming a live status');
    assert.ok(!/Right now at ORD/.test(html), 'the live status block is still at the top');
  } finally { r.cleanup(); }
});

test('paused still says what the delay section is for', () => {
  const r = run(paused());
  try {
    withExistingPages(r, ['chicago-ord']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    const html = r.read('live/chicago-ord/index.html');
    assert.match(html, /Live delay readings are paused/);
    // No poll time in the feed means no reading happened, so nothing may be dated.
    assert.ok(!/Last reading/.test(html), 'dated a reading that never happened');
  } finally { r.cleanup(); }
});

test('a reading that did happen is dated', () => {
  const r = run(paused({ updatedAt: '2026-10-18T21:43:00Z' }));
  try {
    withExistingPages(r, ['chicago-ord']);
    execFileSync(process.execPath,
      [path.join(r.dir, 'scripts', 'bake-airports.js'), '--from', path.join(r.dir, 'p.json')],
      { stdio: 'pipe' });
    assert.match(r.read('live/chicago-ord/index.html'), /Last reading 2026-10-18 21:43 UTC/);
  } finally { r.cleanup(); }
});

test('unpaused is unchanged, so turning polling back on needs no second rewrite', () => {
  const d = sample();
  const r = run(d);
  try {
    const slug = BOARD.slugFor(d.regions[0].airports[0]);
    const html = r.read(`live/${slug}/index.html`);
    assert.match(html, /<title>[^<]*Airport Delays \| Ruta Travels<\/title>/);
    assert.match(html, /Right now at/);
    assert.ok(!/Live delay readings are paused/.test(html), 'paused copy leaked into a live build');
  } finally { r.cleanup(); }
});
