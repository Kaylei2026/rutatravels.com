#!/usr/bin/env node
/**
 * Refresh the weather snapshot the airport pages show.
 *
 * Runs on its own clock, slower than the board. The board bakes every 30 minutes because delays
 * move that fast; weather on a reference page does not, and TTL_WEATHER on the server is also 30
 * minutes, so baking weather on the board's rhythm would miss the cache almost every time. At 34
 * airports that is about 1,600 OpenWeather calls a day against a 1,000-call free tier, roughly
 * $20 to $25 a month to tell someone it is still cloudy. At three hours it is around 270 a day
 * and free.
 *
 * Every reading carries the time it was taken, and the page prints it. A temperature with no
 * timestamp is worse than no temperature: if it starts pouring and the page still says clear,
 * the reader needs to be able to see the reading is three hours old rather than assume it is
 * current.
 *
 *   node scripts/bake-weather.js              refresh anything older than MAX_AGE_H
 *   node scripts/bake-weather.js --all        refresh every airport regardless of age
 *   node scripts/bake-weather.js --max-age 1  override the age threshold, in hours
 *
 * Needs RUTA_API_KEY: /api/weather sits behind the key gate (/api/live does not, which is why
 * the board bake needs nothing). Without the key this writes nothing and exits 0, so a missing
 * secret degrades to "no weather" rather than a red build.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FACTS = path.join(ROOT, 'live', 'airport-facts.json');
const OUT = path.join(ROOT, 'live', 'airport-weather.json');
const LIVE_API = process.env.RUTA_LIVE_API
  || 'https://ruta-travels-production.up.railway.app/api/live';
const API_BASE = LIVE_API.replace(/\/api\/live$/, '');
const KEY = process.env.RUTA_API_KEY || '';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const MAX_AGE_H = Number(argOf('--max-age')) || 3;
const ALL = argv.includes('--all');
const TIMEOUT_MS = 15000;

const getJSON = async (url, headers) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'RutaBake/1.0 (+https://rutatravels.com)', ...headers } });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
};

/**
 * Just the fields a page shows. OpenWeather's One Call response is large and almost all of it is
 * forecast detail nobody is reading on an airport delay page.
 */
const slim = (wx) => {
  const c = wx && wx.current;
  if (!c) return null;
  const w = (c.weather && c.weather[0]) || {};
  const n = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
  return {
    tempF: n(c.temp),
    feelsF: n(c.feels_like),
    description: typeof w.description === 'string' ? w.description : null,
    icon: typeof w.icon === 'string' ? w.icon : null,
    windMph: n(c.wind_speed),
    // The reading's own timestamp from OpenWeather where present, not ours. If the upstream
    // observation is stale, saying when WE fetched it would overstate how fresh it is.
    observedAt: (typeof c.dt === 'number') ? new Date(c.dt * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
};

const ageH = (iso, now) => {
  const t = new Date(iso || 0).getTime();
  if (!isFinite(t) || !t) return Infinity;
  return (now - t) / 3600000;
};

const main = async () => {
  if (!KEY) {
    console.log('[weather] RUTA_API_KEY not set; leaving the snapshot as it is');
    return 0;
  }
  if (!fs.existsSync(FACTS)) {
    console.log('[weather] no airport-facts.json, so no coordinates; nothing to do');
    return 0;
  }

  const facts = (JSON.parse(fs.readFileSync(FACTS, 'utf8')) || {}).airports || {};
  let board;
  try { board = await getJSON(LIVE_API); }
  catch (e) {
    console.log(`[weather] board unavailable (${e.message}); leaving the snapshot as it is`);
    return 0;
  }

  const codes = [];
  for (const reg of (board.regions || [])) {
    for (const a of (reg.airports || [])) if (a && a.airport) codes.push(String(a.airport).toUpperCase());
  }
  if (!codes.length) {
    console.log('[weather] board listed no airports; leaving the snapshot as it is');
    return 0;
  }

  const prev = fs.existsSync(OUT)
    ? (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch (e) { return {}; } })()
    : {};
  const prevAirports = prev.airports || {};
  const now = Date.now();

  const next = { ...prevAirports };
  let refreshed = 0, kept = 0, failed = 0, skipped = 0;

  for (const code of codes) {
    const f = facts[code];
    if (!f || !f.center) { skipped++; continue; }
    const have = prevAirports[code];
    if (!ALL && have && ageH(have.fetchedAt, now) < MAX_AGE_H) { kept++; continue; }
    try {
      const wx = await getJSON(
        `${API_BASE}/api/weather?lat=${f.center.lat}&lng=${f.center.lng}&lang=en`,
        { 'x-api-key': KEY });
      const s = slim(wx);
      // A bad response must not overwrite a good older reading. Stale and labelled beats absent.
      if (s) { next[code] = s; refreshed++; } else if (have) { kept++; } else { failed++; }
    } catch (e) {
      if (have) kept++; else failed++;
    }
  }

  const payload = { _note: 'Generated by scripts/bake-weather.js. Do not hand-edit.', airports: next };
  const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  const after = JSON.stringify(payload, null, 2) + '\n';
  if (before === after) {
    console.log(`[weather] no change (${kept} still fresh)`);
    return 0;
  }
  fs.writeFileSync(OUT, after);
  console.log(`[weather] ${refreshed} refreshed, ${kept} still fresh, ${failed} failed, ${skipped} without coordinates`);
  return 0;
};

main().then((c) => process.exit(c)).catch((e) => {
  console.error('[weather] ' + (e && e.stack ? e.stack : e));
  // Still not a red build: weather is decoration on a page whose job is delays.
  process.exit(0);
});
