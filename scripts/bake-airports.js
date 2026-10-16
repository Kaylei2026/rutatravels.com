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
const factsBlock = (f, code) => {
  if (!f || !f.terminals || !f.terminals.length) return '';
  const word = f.terminalWord || 'Terminal';
  const plural = f.terminalCount === 1 ? word : word + 's';
  const rows = f.terminals.map((t) => `<tr><th scope="row">${esc(t.name)}</th>`
    + `<td>${t.gates ? esc(t.gates) + (t.gates === 1 ? ' gate' : ' gates') : '&mdash;'}</td></tr>`).join('');
  return `<h2>Inside ${esc(code)}</h2>`
    + `<p class="apt-lay">${esc(f.name || code)} has ${esc(f.terminalCount)} ${esc(plural.toLowerCase())}`
    + ` and ${esc(f.gateCount)} gates.</p>`
    + `<table class="terms"><caption class="sr-only">${esc(plural)} and gate counts at ${esc(code)}</caption>`
    + `<tbody>${rows}</tbody></table>`
    + `<p class="apt-method">Ruta carries the position of every one of these gates, so it measures the walk to yours`
    + ` along the concourse rather than in a straight line, and it works with no signal.</p>`;
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
    const label = `${esc(x.city || x.airport)} (${esc(x.airport)})`;
    return slug ? `<a href="/live/${esc(slug)}/">${label}</a>` : `<span>${label}</span>`;
  }).join('');
  return `<h2>Other airports in ${esc(region.region)}</h2><div class="siblings">${links}</div>`;
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
    const inner = group('Eat', t.food) + group('Shop', t.shopping) + group('Lounges and more', t.other);
    return inner ? `<div class="svc-t"><h3>${esc(t.name)}</h3>${inner}</div>` : '';
  }).join('');
  if (!sections) return '';
  const total = ts.reduce((n, t) => n + t.food.length + t.shopping.length + t.other.length, 0);
  return `<h2>Eating, shopping and lounges at ${esc(code)}</h2>`
    + `<p class="apt-lay">${esc(total)} places across ${esc(ts.length)} ${ts.length === 1 ? 'terminal' : 'terminals'}, `
    + `the same list Ruta carries offline.</p><div class="svc">${sections}</div>`;
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
  return h;
};

const pageHtml = ({ a, region, alerts, chrome, updated, facts }) => {
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
.apt-head{display:flex;align-items:center;gap:12px;margin:0 0 10px}
.apt-head .dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.apt-status{font-family:'Montserrat',sans-serif;font-size:20px;font-weight:600}
.apt-note{margin:0 0 18px;font-size:15px}
.apt-method{margin:22px 0 0;font-size:13px;opacity:.7;max-width:62ch}
.apt-none{font-size:15px;opacity:.8}
.stats{display:flex;gap:34px;margin:18px 0 0;flex-wrap:wrap}
.stat .k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;opacity:.55}
.stat .v{font-family:'Montserrat',sans-serif;font-size:26px;font-weight:300;margin-top:3px}
.apt-lay{margin:0 0 16px;font-size:15px;max-width:62ch}
.terms{border-collapse:collapse;margin:0;font-size:15px}
.terms th{text-align:left;font-weight:500;padding:9px 28px 9px 0;border-top:1px solid var(--line)}
.terms td{padding:9px 0;border-top:1px solid var(--line);opacity:.75;white-space:nowrap}
.facts-l{margin:6px 0 0;padding-left:20px;font-size:15px}
.facts-l li{margin:4px 0}
.svc{margin-top:8px}
.svc-t{padding:18px 0;border-top:1px solid var(--line)}
.svc-t h3{font-family:'Montserrat',sans-serif;font-size:17px;font-weight:600;margin:0 0 10px}
.svc-g{margin:0 0 12px}
.svc-k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;opacity:.55;margin-bottom:5px}
.svc-l{margin:0;padding-left:20px;font-size:14.5px}
.svc-l li{margin:3px 0}
.svc-l .loc{opacity:.55;font-size:13px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.siblings{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:6px}
.siblings a,.siblings span{font-size:14px}
.backlink{display:inline-block;margin-top:34px;font-size:14px}
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
  <div class="sec-h">Right now</div>
  ${detailBlock(a, alerts)}

  <div class="sec-h" style="margin-top:46px">Alerts affecting ${esc(a.airport)}</div>
  ${alertsBlock(alerts)}

  ${factsBlock(facts, a.airport)}

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
  if (fs.existsSync(FACTS)) {
    try { allFacts = (JSON.parse(fs.readFileSync(FACTS, 'utf8')) || {}).airports || {}; }
    catch (e) { console.warn(`[airports] could not read ${FACTS} (${e.message}); building without reference facts`); }
  } else {
    console.warn('[airports] no airport-facts.json; pages will carry live status only. '
      + 'Regenerate it with scripts/export-airport-facts.cjs in the app repo.');
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
      const html = pageHtml({ a, region, alerts: byAirport(a.airport), chrome, updated, facts: allFacts[a.airport] });
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
