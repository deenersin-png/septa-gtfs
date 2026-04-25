#!/usr/bin/env node
// Convert SEPTA's GTFS bus zip into per-route JSON files for the Block Tracker.
// No external dependencies. Run: `node build.js`.

import { createReadStream, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TMP  = join(ROOT, 'tmp');
const BUS  = join(TMP, 'bus');
const OUT  = join(ROOT, 'data');
const URL  = 'https://www3.septa.org/developer/gtfs_public.zip';

function log(...a) { console.log(`[build]`, ...a); }

// ── 1. Download + extract GTFS ─────────────────────────────────
function fetchGTFS() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  const zipPath = join(TMP, 'gtfs.zip');
  log('downloading', URL);
  execSync(`curl -sL -o "${zipPath}" "${URL}"`, { stdio: 'inherit' });
  log('extracting outer zip');
  execSync(`unzip -o "${zipPath}" -d "${TMP}"`, { stdio: 'pipe' });
  log('extracting bus zip');
  execSync(`unzip -o "${join(TMP, 'google_bus.zip')}" -d "${BUS}"`, { stdio: 'pipe' });
}

// ── 2. CSV helpers ─────────────────────────────────────────────
function parseCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readCSV(path) {
  const txt = readFileSync(path, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(l => {
    const v = parseCSVLine(l);
    const r = {};
    headers.forEach((h, i) => { r[h] = (v[i] || '').trim(); });
    return r;
  });
}

async function streamCSV(path, onRow) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let headers = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!headers) { headers = parseCSVLine(line).map(h => h.trim()); continue; }
    const v = parseCSVLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = (v[i] || '').trim();
    onRow(row);
  }
}

// ── 3. Calendar → service_id → day-types it covers ─────────────
const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_TYPE = { monday:'weekday', tuesday:'weekday', wednesday:'weekday',
                   thursday:'weekday', friday:'weekday', saturday:'saturday', sunday:'sunday' };

function buildServiceMap() {
  const cal = readCSV(join(BUS, 'calendar.txt'));
  const exc = readCSV(join(BUS, 'calendar_dates.txt'));
  const map = new Map(); // service_id → Set('weekday'|'saturday'|'sunday')
  for (const r of cal) {
    const types = new Set();
    for (const d of DAYS) if (r[d] === '1') types.add(DAY_TYPE[d]);
    if (types.size) map.set(r.service_id, types);
  }
  // calendar_dates exceptions: type 1 = added, type 2 = removed.
  // For a stable weekly schedule we'd want to honor these per-date, but the
  // app only needs day-type granularity, so additions are folded back into
  // the day-type the date falls on. Removals are ignored (rare, not safe to
  // pre-bake). The runtime can still consult calendar_dates if needed.
  for (const r of exc) {
    if (r.exception_type !== '1') continue;
    const d = new Date(`${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}`);
    const dow = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getUTCDay()];
    const t = DAY_TYPE[dow];
    const set = map.get(r.service_id) || new Set();
    set.add(t);
    map.set(r.service_id, set);
  }
  return map;
}

// ── 4. Routes ──────────────────────────────────────────────────
function buildRouteMap() {
  const rows = readCSV(join(BUS, 'routes.txt'));
  const byId = new Map();
  for (const r of rows) byId.set(r.route_id, r);
  return byId;
}

// ── 5. Stops ───────────────────────────────────────────────────
function buildStopMap() {
  const rows = readCSV(join(BUS, 'stops.txt'));
  const byId = new Map();
  for (const r of rows) byId.set(r.stop_id, r.stop_name);
  return byId;
}

// ── 6. Trips ───────────────────────────────────────────────────
function buildTrips(routes, services) {
  const rows = readCSV(join(BUS, 'trips.txt'));
  const byTrip = new Map();
  for (const r of rows) {
    const route = routes.get(r.route_id);
    if (!route) continue;
    const dayTypes = services.get(r.service_id);
    if (!dayTypes || !dayTypes.size) continue;
    byTrip.set(r.trip_id, {
      trip_id:    r.trip_id,
      route_id:   r.route_id,
      route_name: route.route_short_name,
      service_id: r.service_id,
      direction:  r.direction_id,
      block_id:   r.block_id,
      headsign:   r.trip_headsign,
      day_types:  Array.from(dayTypes),
      // populated from stop_times stream
      start_time: null, end_time: null,
      first_stop_id: null, last_stop_id: null,
      first_seq: Infinity, last_seq: -Infinity,
    });
  }
  return byTrip;
}

// ── 7. Stop times — single streaming pass over the 100MB file ──
async function annotateTripsWithTimes(trips) {
  let n = 0;
  await streamCSV(join(BUS, 'stop_times.txt'), row => {
    const t = trips.get(row.trip_id);
    if (!t) return;
    const seq = parseInt(row.stop_sequence) || 0;
    if (seq < t.first_seq) {
      t.first_seq = seq;
      t.start_time = row.departure_time || row.arrival_time;
      t.first_stop_id = row.stop_id;
    }
    if (seq > t.last_seq) {
      t.last_seq = seq;
      t.end_time = row.arrival_time || row.departure_time;
      t.last_stop_id = row.stop_id;
    }
    if ((++n % 500000) === 0) log('stop_times rows:', n);
  });
}

// ── 8. Emit per-route JSON + blocks.json + manifest ────────────
function emit(trips, stops) {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const byRoute = new Map(); // route_short_name → { weekday: [], saturday: [], sunday: [] }
  const blocks  = {};        // block_id → { route, trips_today: [...] } per day-type

  for (const t of trips.values()) {
    if (!t.start_time) continue; // trip with no stop_times
    const slim = {
      trip_id:   t.trip_id,
      block_id:  t.block_id,
      direction: parseInt(t.direction) || 0,
      headsign:  t.headsign,
      start:     t.start_time,
      end:       t.end_time,
      first:     stops.get(t.first_stop_id) || '',
      last:      stops.get(t.last_stop_id)  || '',
    };
    if (!byRoute.has(t.route_name)) byRoute.set(t.route_name, { weekday: [], saturday: [], sunday: [] });
    for (const dt of t.day_types) byRoute.get(t.route_name)[dt].push(slim);
  }

  // Sort each day's trips by start time and dedupe by trip_id
  for (const [name, days] of byRoute) {
    for (const dt of ['weekday','saturday','sunday']) {
      const seen = new Set();
      days[dt] = days[dt]
        .filter(t => !seen.has(t.trip_id) && seen.add(t.trip_id))
        .sort((a, b) => a.start.localeCompare(b.start));
    }
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify({
      route_short_name: name,
      ...days,
    }));
  }

  // blocks.json keyed by block_id, with the route it serves.
  // A single block almost always serves one route; if multiple, we keep the first.
  for (const t of trips.values()) {
    if (!t.block_id || t.block_id === '0') continue;
    if (!blocks[t.block_id]) blocks[t.block_id] = { route: t.route_name, day_types: [] };
    for (const dt of t.day_types) {
      if (!blocks[t.block_id].day_types.includes(dt)) blocks[t.block_id].day_types.push(dt);
    }
  }
  writeFileSync(join(OUT, 'blocks.json'), JSON.stringify(blocks));

  // manifest
  const feedInfo = readCSV(join(BUS, 'feed_info.txt'))[0] || {};
  const manifest = {
    generated_at: new Date().toISOString(),
    gtfs_version: feedInfo.feed_version || 'unknown',
    feed_start:   feedInfo.feed_start_date || '',
    feed_end:     feedInfo.feed_end_date   || '',
    routes:       Array.from(byRoute.keys()).sort(),
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`emitted ${byRoute.size} routes, ${Object.keys(blocks).length} blocks`);
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--skip-download') && existsSync(BUS)) {
    log('skipping download (cached)');
  } else {
    fetchGTFS();
  }
  log('parsing routes / stops / calendar');
  const routes   = buildRouteMap();
  const stops    = buildStopMap();
  const services = buildServiceMap();
  log(`routes=${routes.size} stops=${stops.size} services=${services.size}`);

  log('parsing trips');
  const trips = buildTrips(routes, services);
  log(`trips=${trips.size}`);

  log('streaming stop_times (this is the big one)');
  await annotateTripsWithTimes(trips);

  log('emitting JSON');
  emit(trips, stops);
  log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
