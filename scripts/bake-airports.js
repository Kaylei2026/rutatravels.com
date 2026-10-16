#!/usr/bin/env node
/**
 * One page per airport on the board, written into live/<slug>/.
 *
 * The board is a single page whose H1 is brand language. Nobody types "flight intelligence,
 * live"; they type "LAX delays". Flighty has the long tail of per-airport pages uncontested and
 * we hold more airport data than they list. These pages are that tail: titled the way the query
 * is phrased, carrying the figures we already compute, and linked from the board rows so they
 * are not orphans.
 *
 * The chrome is lifted out of live/index.html at build time rather than copied: the stylesheet,
 * the nav and the footer. Restyle the board and these follow. Nothing here duplicates a second
 * design, and the slug comes from board.js so a link and a directory name cannot disagree.
 *
 *   node scripts/bake-airports.js                 fetch the live API and write the pages
 *   node scripts/bake-airports.js --from f.json   from a saved payload (testing)
 *   node scripts/bake-airports.js --check         exit 1 if anything would change
 *
 * Pages for airports that later drop off the board are left alone rather than deleted. They go
 * stale, which is worse than nothing only if the board shrinks permanently, and deleting
 * directories from a scheduled job is a bigger decision than it looks.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'live', 'index.html');
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const FACTS = path.join(ROOT, 'live', 'airport-facts.json');
const WEATHER = path.join(ROOT, 'live', 'airport-weather.json');
const BOARD = require(path.join(ROOT, 'live', 'board.js'));

const SITE = 'https://rutatravels.com';
const API = process.env.RUTA_LIVE_API
  || 'https://ruta-travels-production.up.railway.app/api/live';
const FETCH_TIMEOUT_MS = 20000;

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const has = (n) => argv.includes(n);
const esc = BOARD.esc;

/** Pull a chunk of the board page out by tag, so the pages share its chrome rather than copy it. */
const lift = (html, open, close, label) => {
  const i = html.indexOf(open);
  const j = html.indexOf(close, i);
  if (i === -1 || j === -1) throw new Error(`could not lift ${label} from live/index.html`);
  return html.slice(i, j + close.length);
};

/**
 * One section, one card.
 *
 * The first draft ran headings straight down the page with whatever margin each block brought
 * with it, so the spacing between sections was inconsistent and nothing read as a unit. The
 * board already has a card language (--card, --line, rounded) and these pages now use it, which
 * also means a restyle of the board carries over.
 */
const section = (label, inner) => `<section class="card" aria-label="${label.replace(/<[^>]+>/g, '')}">${inner}</section>`;

const LEVEL_WORD = ['running on time', 'seeing minor delays', 'seeing moderate delays',
  'seeing significant delays', 'severely disrupted'];

/** One sentence a person could read aloud, for the meta description and the page lede. */
const summaryLine = (a, alerts) => {
  const city = a.city || a.airport;
  const state = LEVEL_WORD[a.level] || 'being monitored';
  let s = `${city} (${a.airport}) is ${state} right now.`;
  if (a.level >= 1 && a.medianDelay) s += ` Departures are running about ${a.medianDelay} minutes late.`;
  if (a.cancelled) s += ` ${a.cancelled} flight${a.cancelled === 1 ? '' : 's'} cancelled.`;
  if (alerts.length) s += ` ${alerts.length} active alert${alerts.length === 1 ? '' : 's'}.`;
  return s;
};

/**
 * The part of the page that is worth reading on a day when nothing is wrong.
 *
 * Live status alone made these pages thin: "JFK is running on time" and little else, which is
 * the shape a crawler files as filler rather than as a reference. These facts come from the
 * app's own AIRPORTS table, exported by scripts/export-airport-facts.cjs in the app repo. They
 * are not published anywhere else, they do not churn, and they are the reason a page is worth
 * keeping open once the delay question is answered.
 *
 * terminalWord matters: Atlanta has Concourses, not Terminals, and printing the wrong one reads
 * as not knowing the airport.
 */
/**
 * Current weather, stamped with the time it was read.
 *
 * Refreshed on a three-hour clock rather than the board's thirty minutes, because weather on a
 * reference page does not need half-hour precision and the server's weather cache has a 30-minute
 * TTL, so matching the board would miss it every time and cost real money.
 *
 * The stamp is the point. If it starts pouring and the page still says clear skies, the reader
 * has to be able to see when the reading was taken rather than assume it is current. An
 * unlabelled temperature is worse than none.
 *
 * It is an absolute time, not "20 min ago". This page is static HTML: a relative age is computed
 * once at bake time and then frozen, so every freshly baked page said "Taken 0 min ago" and went
 * on saying it for the next three hours. That is the failure the stamp exists to prevent, printed
 * in the stamp's own words. The board already prints "Updated <time> UTC" for this reason.
 *
 * readAt, not observedAt: the figure comes from OpenWeather's `current.dt`, which is when the API
 * answered, not when a station took a measurement. All 31 airports in a single bake carry the same
 * value to the second, which settles what it is. Older snapshots are still read for one cycle.
 */
const weatherBlock = (w, code, nowMs) => {
  if (!w || (w.tempF == null && !w.description)) return '';
  const t = new Date(w.readAt || w.observedAt || w.fetchedAt || 0).getTime();
  const stamp = (isFinite(t) && t)
    ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '';
  const bits = [];
  if (w.tempF != null) bits.push(`<span class="wx-t">${esc(w.tempF)}&deg;F</span>`);
  if (w.description) bits.push(`<span class="wx-d">${esc(w.description)}</span>`);
  if (w.windMph != null) bits.push(`<span class="wx-w">wind ${esc(w.windMph)} mph</span>`);
  return section('Weather', `<h2>Weather at ${esc(code)}</h2>`
    + `<p class="wx">${bits.join('<span class="wx-sep">&middot;</span>')}</p>`
    + `<p class="apt-method">`
    + (stamp ? `Read ${esc(stamp)}. ` : '')
    + `Refreshed a few times a day, so it can lag a change in conditions. `
    + `Ruta checks weather on your own flights far more often than this page does.</p>`);
};

const factsBlock = (f, code, asOf) => {
  if (!f || !f.terminals || !f.terminals.length) return '';
  const word = f.terminalWord || 'Terminal';
  const plural = f.terminalCount === 1 ? word : word + 's';

  // No counts of any kind in this table. AIRPORTS gate lists are terminal-inference data, not
  // an inventory: DFW is five terminals of exactly 40, Denver two concourses of exactly 95, ORD
  // sums to 152 against an official 199. A per-terminal count of places we list has the same
  // problem from the other direction, because TERMINAL_SERVICES is a curated handful rather than
  // a directory, and eight terminals each showing "4 places" reads as invented even though it is
  // literally true.
  //
  // The terminal NAMES are sound and check out against official sources, so they are what this
  // publishes. The places themselves are named in full in their own section, which is the honest
  // place for them.
  // A one-column table is a list. Marking it up as a table makes a screen reader announce
  // rows and columns that carry no meaning.
  const rows = f.terminals.map((t) => `<li>${esc(t.name)}</li>`).join('');

  return section('Inside ' + esc(code), `<h2>Inside ${esc(code)}</h2>`
    + `<p class="apt-lay">${esc(f.name || code)} has ${esc(f.terminalCount)} `
    + `${esc(plural.toLowerCase())}.</p>`
    + `<ul class="terms-l" aria-label="${esc(plural)} at ${esc(code)}">${rows}</ul>`
    + `<p class="apt-method">Ruta holds a position for the gates it maps here, which is how it measures the walk`
    + ` to yours along the concourse rather than in a straight line, with no signal needed.`
    + (asOf ? ` Terminal data as of ${esc(asOf)}.` : '') + `</p>`);
};

const detailBlock = (a, alerts) => {
  const color = BOARD.LEVEL_COLORS[a.level] || '#4F7C82';
  const bits = [];
  if (a.level >= 1 && a.medianDelay) bits.push(`<div class="stat"><div class="k">Typical delay</div><div class="v">${esc(a.medianDelay)} min</div></div>`);
  if (a.cancelled) bits.push(`<div class="stat"><div class="k">Cancelled</div><div class="v">${esc(a.cancelled)}</div></div>`);
  return `<div class="apt-head"><span class="dot" style="background:${color}"></span>`
    + `<div class="apt-status">${esc(a.status || '')}</div></div>`
    + (a.note ? `<p class="apt-note">${esc(a.note)}</p>` : '')
    + (bits.length ? `<div class="stats">${bits.join('')}</div>` : '')
    + `<p class="apt-method">Delay figures come from scheduled versus actual departure times across the airport, `
    + `refreshed through the day. Alerts below are classified from public news reporting.</p>`;
};

const alertsBlock = (alerts) => {
  if (!alerts.length) {
    return '<p class="apt-none">No disruption alerts affecting this airport right now.</p>';
  }
  return alerts.map((al) => {
    const href = BOARD.safeUrl(al.url);
    const src = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${esc(al.source || 'Read more')}</a>`
      : esc(al.source || '');
    return `<div class="alert"><div class="when">${esc(al.when || 'Ongoing')}</div>`
      + `<div class="atitle">${esc(al.summary || al.title || '')}</div>`
      + (src ? `<div class="ameta">Source: ${src}</div>` : '') + '</div>';
  }).join('');
};

const siblingsBlock = (region, self) => {
  const others = (region.airports || []).filter((x) => x.airport !== self.airport);
  if (!others.length) return '';
  const links = others.map((x) => {
    const slug = BOARD.slugFor(x);
    const label = `${esc(x.city || x.airport)} <span class="sib-code">${esc(x.airport)}</span>`;
    return slug ? `<a class="sib" href="/live/${esc(slug)}/">${label}</a>` : `<span class="sib">${label}</span>`;
  }).join('');
  return section('Other airports', `<h2>Other airports in ${esc(region.region)}</h2>`
    + `<div class="siblings">${links}</div>`);
};

/**
 * What is actually inside the terminals: where to eat, what to buy, which lounges.
 *
 * 81 airports, 193 terminals, 1,332 places, each tied to the terminal it sits in and usually to
 * a spot within it. This is the app's own services data, and it is the reason someone would keep
 * the page open after the delay question is answered.
 */
const servicesBlock = (f, code) => {
  const ts = (f && f.terminalServices) || [];
  if (!ts.length) return '';
  const group = (label, items) => {
    if (!items.length) return '';
    return `<div class="svc-g"><div class="svc-k">${esc(label)}</div><ul class="svc-l">`
      + items.map((x) => `<li>${esc(x.name)}${x.location ? ` <span class="loc">${esc(x.location)}</span>` : ''}</li>`).join('')
      + '</ul></div>';
  };
  const sections = ts.map((t) => {
    // "Also inside", not "Lounges and more". Measured across all 99 airports, that column is 451
    // entries and only 195 of them are lounges. The four most common things in it are Prayer Room
    // (55), Family Restroom (48), Quiet Room (42) and Nursing Room (28), so at LAX Terminal 2 the
    // entry under "Lounges" was a family restroom. The lounges still appear; they are no longer
    // what the column claims to be.
    const inner = group('Eat', t.food) + group('Shop', t.shopping) + group('Also inside', t.other);
    return inner ? `<div class="svc-t"><h3>${esc(t.name)}</h3>${inner}</div>` : '';
  }).join('');
  if (!sections) return '';
  const total = ts.reduce((n, t) => n + t.food.length + t.shopping.length + t.other.length, 0);
  // Deliberately "some of what is here" rather than a count presented as an inventory.
  // TERMINAL_SERVICES holds roughly one representative item per category per terminal: 76% of
  // the terminals that list any lounge list exactly one, and ORD shows four against a real
  // eleven. The data is a sample, and a page that counts it implies a directory it is not.
  // The heading no longer promises lounges. The app's own lounge data was audited the same day
  // and found to list rooms that do not exist (a Centurion Lounge at ORD) and rooms in the wrong
  // terminal, and this page's lounge content is thinner still: roughly one per terminal. A page
  // that puts "lounges" in an H2 and then shows a prayer room has made a promise it cannot keep.
  // Worth putting back, and worth ranking for, once there is real lounge data behind it.
  return section('Eating and shopping', `<h2>Eating and shopping at ${esc(code)}</h2>`
    + `<p class="apt-lay">Some of what you will find inside, across ${esc(ts.length)} `
    + `${ts.length === 1 ? 'terminal' : 'terminals'}. Ruta carries this offline, with more in the app.</p>`
    + `<div class="svc">${sections}</div>`);
};

// Plain English for a category key. Written out rather than de-camel-cased, because
// "Accessible Restrooms" and "accessible restrooms" are not the same register.
const ACCESS_LABEL = {
  accessibleRestrooms: 'accessible restrooms',
  elevators: 'lifts',
  familyRestrooms: 'family restrooms',
  petRelief: 'pet relief areas',
  sensoryQuiet: 'sensory quiet rooms',
  medical: 'medical points',
};
const AMENITY_LABEL = {
  waterRefill: 'water refill stations',
  prayer: 'prayer rooms',
  play: 'play areas',
  showers: 'showers',
  luggageStorage: 'luggage storage',
  peopleMovers: 'people movers',
};

// Labels are written plural because that is the common case. One of a thing should still read
// as one of a thing: "1 play areas" is the tell that a page was generated and not written.
// A trailing s is enough here; 'luggage storage' has none and is left alone.
const one = (label) => (label.endsWith('s') ? label.slice(0, -1) : label);

const listOf = (counts, labels) => Object.keys(counts || {})
  .filter((k) => labels[k])
  .map((k) => {
    const n = counts[k];
    return `<li><strong>${esc(n)}</strong> ${esc(n === 1 ? one(labels[k]) : labels[k])}</li>`;
  }).join('');

/**
 * The section nobody else publishes.
 *
 * Every mapped entry carries a position, which is how the app names a lift or an accessible
 * restroom on the way to a gate rather than listing them on a page and leaving you to find them.
 * Counting them is the honest way to say that on a static page.
 */
const accessBlock = (f, code) => {
  const acc = listOf(f && f.accessibility, ACCESS_LABEL);
  const amen = listOf(f && f.amenities, AMENITY_LABEL);
  if (!acc && !amen) return '';
  let h = `<h2>Getting around ${esc(code)}</h2>`;
  if (acc) {
    h += `<p class="apt-lay">Mapped at ${esc(code)}, with a position for each one:</p>`
      + `<ul class="facts-l">${acc}</ul>`
      + `<p class="apt-method">Tell Ruta you use a wheelchair and every walking estimate slows to match, `
      + `and these get named on the way to your gate rather than listed and left for you to find.</p>`;
  }
  if (amen) h += `<p class="apt-lay" style="margin-top:22px">Also mapped here:</p><ul class="facts-l">${amen}</ul>`;
  return section('Getting around', h);
};

const pageHtml = ({ a, region, alerts, chrome, updated, facts, asOf, weather, nowMs }) => {
  const city = a.city || a.airport;
  const title = `${city} (${a.airport}) Airport Delays | Ruta Travels`;
  const desc = summaryLine(a, alerts);
  const slug = BOARD.slugFor(a);
  const url = `${SITE}/live/${slug}/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(city)} (${esc(a.airport)}) airport delays, live">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Ruta Travels">
<meta property="og:image" content="${SITE}/photos/25.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=Montserrat:wght@200;300;400;600&display=swap" rel="stylesheet">
${chrome.style}
<style>
/* These pages inherit the board's stylesheet, which only styles links in the few places the
   board has them. Anything else fell through to the browser default, which on a navy background
   is bright blue turning purple. Everything below is the page's own layer. */

/* One card per section, so the gaps between them are a single rule rather than whatever margin
   each block happened to bring. */
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 24px;margin:0 0 18px}
.card > h2:first-child{margin-top:0}
.wrap h2{font-family:'Montserrat',sans-serif;font-weight:400;font-size:clamp(18px,2.1vw,22px);
  color:var(--cream);line-height:1.3;margin:0 0 14px;letter-spacing:-.01em}
.wrap h3{font-family:'Montserrat',sans-serif;font-size:16px;font-weight:600;margin:0 0 10px;color:var(--cream)}

.wx{display:flex;flex-wrap:wrap;align-items:baseline;gap:0;margin:0;color:var(--cream)}
.wx-t{font-family:'Montserrat',sans-serif;font-size:34px;font-weight:300;letter-spacing:-.02em}
.wx-d{font-size:16px}
.wx-w{font-size:16px;color:var(--muted)}
.wx-sep{color:var(--muted);margin:0 12px}
.apt-head{display:flex;align-items:center;gap:12px;margin:0 0 10px}
.apt-head .dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.apt-status{font-family:'Montserrat',sans-serif;font-size:21px;font-weight:600;color:var(--cream)}
.apt-note{margin:0 0 18px;font-size:15px;color:var(--cream)}
.apt-lay{margin:0 0 16px;font-size:15px;max-width:62ch;color:var(--cream)}
.apt-method{margin:20px 0 0;font-size:13px;color:var(--muted);max-width:66ch;line-height:1.6}
.apt-none{font-size:15px;color:var(--muted);margin:0}

.stats{display:flex;gap:40px;margin:20px 0 0;flex-wrap:wrap}
.stat .k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}
.stat .v{font-family:'Montserrat',sans-serif;font-size:28px;font-weight:300;margin-top:4px;color:var(--cream)}

.facts-l{margin:8px 0 0;padding-left:20px;font-size:15px;color:var(--cream)}
.facts-l li{margin:5px 0}
.facts-l strong{font-weight:600;color:var(--gold)}

.terms{border-collapse:collapse;margin:0;font-size:15px;width:100%;max-width:440px}
.terms th{text-align:left;font-weight:400;padding:10px 28px 10px 0;border-top:1px solid var(--line);color:var(--cream)}
.terms td{padding:10px 0;border-top:1px solid var(--line);color:var(--muted);white-space:nowrap;text-align:right}
.terms-l{list-style:none;margin:0;padding:0;font-size:15px;color:var(--cream);max-width:440px}
.terms-l li{padding:10px 0;border-top:1px solid var(--line)}

.svc{margin-top:4px}
.svc-t{padding:18px 0 4px;border-top:1px solid var(--line)}
.svc-t:first-child{border-top:0;padding-top:0}
.svc-g{margin:0 0 14px}
.svc-k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.svc-l{margin:0;padding-left:18px;font-size:14.5px;color:var(--cream)}
.svc-l li{margin:4px 0}
.svc-l .loc{color:var(--muted);font-size:13px}

/* Text links, not buttons. The board's palette, not the browser's. */
.siblings{display:flex;flex-wrap:wrap;gap:8px 22px;margin:0}
a.sib{font-size:15px;color:var(--cream);text-decoration:none;border-bottom:1px solid rgba(242,166,90,.35);padding-bottom:1px}
a.sib:hover{color:var(--gold);border-bottom-color:var(--gold)}
a.sib:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.sib-code{color:var(--muted);font-size:13px;letter-spacing:.06em}

.backlink{display:inline-block;margin:6px 0 0;font-size:13px;letter-spacing:.14em;text-transform:uppercase;
  font-weight:600;color:var(--gold);text-decoration:none}
.backlink:hover{color:var(--cream)}
.backlink:focus-visible{outline:2px solid var(--gold);outline-offset:3px}

.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style>
</head>
<body>
${chrome.nav}
<section class="hero">
  <div class="hero-body">
    <h1>${esc(city)} (${esc(a.airport)}) airport delays</h1>
    <p class="lede">${esc(desc)}</p>
    <div class="meta"><span>${esc(updated)}</span></div>
  </div>
</section>

<div class="wrap">
  ${section('Right now', `<h2>Right now at ${esc(a.airport)}</h2>` + detailBlock(a, alerts))}

  ${weatherBlock(weather, a.airport, nowMs)}

  ${section('Alerts', `<h2>Alerts affecting ${esc(a.airport)}</h2>` + alertsBlock(alerts))}

  ${factsBlock(facts, a.airport, asOf)}

  ${accessBlock(facts, a.airport)}

  ${servicesBlock(facts, a.airport)}

  ${siblingsBlock(region, a)}

  <a class="backlink" href="/live/">All airport delays, live</a>

  <div class="cta">
    <h2>Ruta watches this for the flights that are yours.</h2>
    <p>You should not have to refresh a delay board to know if your trip is at risk. Ruta follows your flights automatically, catches trouble early, and tells you what it means and what to do.</p>
    <a href="/#get">Get Ruta</a>
  </div>
</div>
${chrome.footer}
</body>
</html>
`;
};

const fetchLive = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(API, { signal: ctrl.signal, headers: { 'user-agent': 'RutaBake/1.0 (+https://rutatravels.com)' } });
    if (!resp.ok) throw new Error('api ' + resp.status);
    return await resp.json();
  } finally { clearTimeout(timer); }
};

/** Fill the marked block in sitemap.xml, leaving the hand-written entries alone. */
const writeSitemap = (slugs, check) => {
  const a = '<!--ruta:airports:start-->';
  const b = '<!--ruta:airports:end-->';
  let xml = fs.readFileSync(SITEMAP, 'utf8');
  if (!xml.includes(a)) {
    // First run: park the markers just before the closing tag.
    xml = xml.replace('</urlset>', `  ${a}${b}\n</urlset>`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const body = '\n' + slugs.map((s) => `  <url>\n    <loc>${SITE}/live/${s}/</loc>\n`
    + `    <lastmod>${today}</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>0.7</priority>\n  </url>`).join('\n') + '\n  ';
  const i = xml.indexOf(a); const j = xml.indexOf(b);
  const next = xml.slice(0, i + a.length) + body + xml.slice(j);
  const before = fs.readFileSync(SITEMAP, 'utf8');
  // lastmod moves every day, so compare everything except that line or it is never idempotent.
  const strip = (t) => t.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, '<lastmod/>');
  if (strip(next) === strip(before)) return false;
  if (!check) fs.writeFileSync(SITEMAP, next);
  return true;
};

const main = async () => {
  let data;
  const from = argOf('--from');
  if (from) {
    data = JSON.parse(fs.readFileSync(from, 'utf8'));
  } else {
    try { data = await fetchLive(); }
    catch (e) {
      console.log(`[airports] feed unavailable (${e.message}); leaving the pages as they are`);
      return 0;
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.regions)) {
    console.error('[airports] payload has no regions; refusing to write');
    return 2;
  }

  // Optional on purpose: the pages still build without it, they are just the thinner version.
  // A missing file is a reason to say so, not to fail a scheduled job.
  let allFacts = {};
  let factsDate = null;
  let allWeather = {};
  // Pinned once per run so every page in a batch reports the same age for the same reading,
  // rather than drifting by however long the loop took.
  const nowMs = Date.now();
  if (fs.existsSync(FACTS)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FACTS, 'utf8')) || {};
      allFacts = parsed.airports || {};
      factsDate = parsed.generatedAt || null;
    }
    catch (e) { console.warn(`[airports] could not read ${FACTS} (${e.message}); building without reference facts`); }
  } else {
    console.warn('[airports] no airport-facts.json; pages will carry live status only. '
      + 'Regenerate it with scripts/export-airport-facts.cjs in the app repo.');
  }

  // Optional, like the facts. No weather file just means no weather card.
  if (fs.existsSync(WEATHER)) {
    try { allWeather = (JSON.parse(fs.readFileSync(WEATHER, 'utf8')) || {}).airports || {}; }
    catch (e) { console.warn(`[airports] could not read ${WEATHER} (${e.message}); building without weather`); }
  }

  const page = fs.readFileSync(PAGE, 'utf8');
  const chrome = {
    style: lift(page, '<style>', '</style>', 'the stylesheet'),
    nav: lift(page, '<nav class="nav">', '</nav>', 'the nav'),
    footer: lift(page, '<footer', '</footer>', 'the footer'),
  };

  const d = new Date(data.updatedAt || Date.now());
  const updated = isNaN(d.getTime()) ? 'Live'
    : `Updated ${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;

  const byAirport = (code) => (data.alerts || []).filter(
    (al) => (al.airports || []).some((x) => String(x).toUpperCase() === String(code).toUpperCase()));

  let written = 0;
  let wouldChange = false;
  const slugs = [];

  for (const region of data.regions) {
    for (const a of (region.airports || [])) {
      const slug = BOARD.slugFor(a);
      if (!slug) continue;
      slugs.push(slug);
      const html = pageHtml({ a, region, alerts: byAirport(a.airport), chrome, updated,
        facts: allFacts[a.airport], asOf: factsDate, weather: allWeather[a.airport], nowMs });
      const dir = path.join(ROOT, 'live', slug);
      const file = path.join(dir, 'index.html');
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      // The timestamp alone moves every run; comparing without it keeps the commit honest.
      const strip = (t) => String(t).replace(/Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, 'Updated UTC');
      if (prev !== null && strip(prev) === strip(html)) continue;
      wouldChange = true;
      if (!has('--check')) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, html);
      }
      written++;
    }
  }

  const sitemapChanged = writeSitemap(slugs.sort(), has('--check'));
  if (sitemapChanged) wouldChange = true;

  if (has('--check')) {
    if (wouldChange) { console.error('[airports] pages are out of date'); return 1; }
    console.log(`[airports] up to date (${slugs.length} pages)`);
    return 0;
  }

  console.log(`[airports] ${written} page${written === 1 ? '' : 's'} written, ${slugs.length} total`
    + (sitemapChanged ? ', sitemap updated' : ''));
  return 0;
};

main().then((c) => process.exit(c)).catch((e) => {
  console.error('[airports] ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
