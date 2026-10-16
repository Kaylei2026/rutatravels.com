/**
 * Tests for the committed airport facts file.
 *
 * These guard the data, not a script. The weather bake skips any airport with no coordinates,
 * which is right for one missing airport and wrong for all of them: a facts file exported before
 * `center` existed, or committed without it, makes every airport skip, and the step prints a
 * cheerful "0 refreshed" and exits 0. That is how the pages went out with no weather card at all
 * while every build was green.
 *
 * So the file is checked here rather than trusted at bake time, and the bake is checked for
 * complaining when it skips everything.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FACTS = path.join(ROOT, 'live', 'airport-facts.json');
const FIXTURE = path.join(__dirname, 'fixtures', 'live-sample.json');

const facts = () => JSON.parse(fs.readFileSync(FACTS, 'utf8'));

test('the facts file is committed, not generated at bake time', () => {
  assert.ok(fs.existsSync(FACTS), 'live/airport-facts.json is missing from the repo');
});

test('it holds an airports object with something in it', () => {
  const a = facts().airports;
  assert.ok(a && typeof a === 'object' && !Array.isArray(a), 'no airports object');
  assert.ok(Object.keys(a).length > 50, `only ${Object.keys(a).length} airports`);
});

test('every airport carries coordinates', () => {
  const a = facts().airports;
  const without = Object.keys(a).filter((k) => !a[k] || !a[k].center);
  assert.deepStrictEqual(without, [], `no center on: ${without.join(', ')}`);
});

test('the coordinates are plausible numbers, not strings or zeroes', () => {
  const a = facts().airports;
  for (const [code, f] of Object.entries(a)) {
    const { lat, lng } = f.center;
    assert.strictEqual(typeof lat, 'number', `${code} lat is not a number`);
    assert.strictEqual(typeof lng, 'number', `${code} lng is not a number`);
    assert.ok(isFinite(lat) && isFinite(lng), `${code} has a non-finite coordinate`);
    assert.ok(lat >= -90 && lat <= 90, `${code} lat out of range: ${lat}`);
    assert.ok(lng >= -180 && lng <= 180, `${code} lng out of range: ${lng}`);
    // Null Island is what a missing coordinate looks like once it has been through Number().
    assert.ok(Math.abs(lat) > 0.01 || Math.abs(lng) > 0.01, `${code} sits at 0,0`);
  }
});

test('a known airport is where it actually is', () => {
  const lax = facts().airports.LAX;
  assert.ok(lax, 'LAX is not in the facts file');
  assert.ok(Math.abs(lax.center.lat - 33.94) < 0.1, `LAX lat is ${lax.center.lat}`);
  assert.ok(Math.abs(lax.center.lng + 118.41) < 0.1, `LAX lng is ${lax.center.lng}`);
});

test('every airport the board publishes has coordinates, so weather covers the whole site', () => {
  const a = facts().airports;
  const board = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const codes = board.regions.flatMap((r) => r.airports.map((x) => String(x.airport).toUpperCase()));
  const missing = codes.filter((c) => !a[c] || !a[c].center);
  assert.deepStrictEqual(missing, [], `published with no coordinates: ${missing.join(', ')}`);
});

/**
 * The bake's own behaviour when the file is bad. It is driven with a fake key and a dead board
 * address: the coordinate check runs before the network, so a complaint about coordinates proves
 * the check fired rather than the fetch failing first.
 */
const runBake = (airports) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-wx-'));
  fs.mkdirSync(path.join(dir, 'live'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bake-weather.js'), path.join(dir, 'scripts', 'bake-weather.js'));
  fs.writeFileSync(path.join(dir, 'live', 'airport-facts.json'), JSON.stringify({ airports }));
  // Both streams: the complaint is a diagnostic and goes to stderr, which is exactly the half
  // an earlier version of this test threw away.
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'bake-weather.js')], {
    encoding: 'utf8',
    env: { ...process.env, RUTA_API_KEY: 'test-key-not-real', RUTA_LIVE_API: 'http://127.0.0.1:9/api/live' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};

test('the bake says so out loud when the facts file has no coordinates at all', () => {
  const r = runBake({ LAX: { name: 'Los Angeles' }, ORD: { name: "O'Hare" } });
  assert.match(r.out, /coordinates/i, `said nothing about coordinates:\n${r.out}`);
});

test('it does not cry wolf when the coordinates are there', () => {
  const r = runBake({ LAX: { name: 'Los Angeles', center: { lat: 33.942, lng: -118.408 } } });
  assert.doesNotMatch(r.out, /no coordinates/i, r.out);
});

test('explains why a reading did not arrive, by airport and by upstream reason', () => {
  // /api/weather answers 200 with OpenWeather's error body rather than an error status, so a
  // failure looks exactly like a success with no `current` in it. Abu Dhabi failed two runs in a
  // row and the step printed nothing either time, which is how one broken airport hides among 36.
  const { upstreamReason, slim } = require(path.join(ROOT, 'scripts', 'bake-weather.js'));

  assert.match(upstreamReason({ cod: 429, message: 'Your account is temporary blocked' }), /429/);
  assert.match(upstreamReason({ cod: 429, message: 'Your account is temporary blocked' }), /temporary blocked/);
  assert.match(upstreamReason({ cod: '401', message: 'Invalid API key' }), /401/);
  assert.match(upstreamReason({}), /no current conditions/);
  assert.match(upstreamReason(null), /empty response/);
  assert.match(upstreamReason({ message: 'something broke' }), /something broke/);
  // The final fallback. Unreachable from the bake itself, since slim() only returns null when
  // there is no `current` at all, but upstreamReason is exported and should not answer nothing.
  assert.match(upstreamReason({ current: {} }), /unusable reading/);

  // cod 200 with a real reading is not a failure and never reaches this function in practice,
  // but it must not be reported as an upstream error if it does.
  assert.doesNotMatch(upstreamReason({ cod: 200, current: { temp: 70 } }), /upstream/);

  // And the thing that decides a reading is unusable in the first place.
  assert.strictEqual(slim({ cod: 429, message: 'blocked' }), null);
  assert.strictEqual(slim({}), null);
  assert.ok(slim({ current: { temp: 70.4, weather: [{ description: 'clear sky' }] } }));
});

test('an unreachable board still exits green, because weather is not the point of the page', () => {
  const r = runBake({ LAX: { name: 'Los Angeles', center: { lat: 33.942, lng: -118.408 } } });
  assert.strictEqual(r.status, 0);
});
