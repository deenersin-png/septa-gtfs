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

// ── 3b. Calendar overrides (holidays) ──────────────────────────
// Trips are already bucketed correctly (a July-4 trip runs on a Sunday
// service_id, so it lands in the "sunday" array). The only thing the client
// can't know is that *today* should read the sunday bucket instead of the
// weekday one. SEPTA encodes this in calendar_dates.txt: on a holiday it
// REMOVES the normal weekday/Saturday service_ids (exception_type 2) and
// ADDS the replacement ones (exception_type 1). We compute, for each such
// special date, the effective day-type and emit only the dates that differ
// from their plain day-of-week — a sparse map the client consults first.
function buildCalendarOverrides() {
  const cal = readCSV(join(BUS, 'calendar.txt'));
  const exc = readCSV(join(BUS, 'calendar_dates.txt'));

  // Classify each service_id to a single day-type from its weekly pattern.
  // Date-specific supplemental services (all-zero weekly flags) can't be
  // classified and are skipped from the vote.
  const bucketOf  = new Map(); // service_id → 'weekday'|'saturday'|'sunday'
  const dowActive = new Map(); // service_id → [sun,mon,…,sat] booleans (JS getUTCDay order)
  for (const r of cal) {
    const wk = ['monday','tuesday','wednesday','thursday','friday'].some(d => r[d] === '1');
    const sa = r.saturday === '1', su = r.sunday === '1';
    let bucket = null;
    if (wk && !sa && !su) bucket = 'weekday';
    else if (!wk && sa && !su) bucket = 'saturday';
    else if (!wk && !sa && su) bucket = 'sunday';
    else if (wk) bucket = 'weekday';
    if (bucket) bucketOf.set(r.service_id, bucket);
    dowActive.set(r.service_id, {
      flags: [r.sunday==='1', r.monday==='1', r.tuesday==='1', r.wednesday==='1', r.thursday==='1', r.friday==='1', r.saturday==='1'],
      start: r.start_date, end: r.end_date,
    });
  }

  const addByDate = new Map(), remByDate = new Map();
  for (const r of exc) {
    const m = r.exception_type === '1' ? addByDate : r.exception_type === '2' ? remByDate : null;
    if (!m) continue;
    if (!m.has(r.date)) m.set(r.date, new Set());
    m.get(r.date).add(r.service_id);
  }

  const plainBucket = dow => dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
  const overrides = {};
  const specialDates = new Set([...addByDate.keys(), ...remByDate.keys()]);

  for (const ymd of specialDates) {
    if (!/^\d{8}$/.test(ymd)) continue;
    const dow = new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}T00:00:00Z`).getUTCDay();
    const plain = plainBucket(dow);

    // Effective active services on that date = weekly-base (in range, runs
    // that DOW) minus removals plus additions.
    const active = new Set();
    for (const [sid, info] of dowActive) {
      if (ymd < info.start || ymd > info.end) continue;
      if (info.flags[dow]) active.add(sid);
    }
    (remByDate.get(ymd) || []).forEach(s => active.delete(s));
    (addByDate.get(ymd) || []).forEach(s => active.add(s));

    const votes = { weekday:0, saturday:0, sunday:0 };
    for (const s of active) { const b = bucketOf.get(s); if (b) votes[b]++; }
    let eff = null, best = 0;
    for (const b of ['weekday','saturday','sunday']) if (votes[b] > best) { best = votes[b]; eff = b; }

    if (eff && eff !== plain) {
      overrides[`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`] = eff;
    }
  }
  return overrides;
}

// ── 3c. Calendar days (which services run on each date) ────────
// The day-type buckets in the route files mix schedules: SEPTA's alternate
// timetables (service 11 "holiday week" weekday, 471 alternate Saturday,
// 17 = L1/B1 on Thanksgiving / New Year's Day) are dated services with no
// weekly pattern, and they land in the weekday/saturday bucket of every date
// they run on - so a plain weekday's list carries them too. Each trip now
// carries its service id (`sv`), and this file says, for every date of the
// feed, which services run that day. A client keeps the trips whose `sv` is
// in the date's list and gets exactly that day's timetable.
//
//   { "2026-11-27": { day: "weekday", services: ["11","16",...],
//                     special: true, alt: true, altRoutes: ["1","12",...] } }
//
// special = SEPTA changed this date's service (removed a weekly service);
// alt = a dated alternate timetable runs (paddles exist only for the regular
// Weekday / Saturday / Sunday), altRoutes = the routes it covers.
const ALT_MIN_TRIPS = 100; // smaller dated services are one-off extra trips
function buildCalendarDays(trips) {
  const cal = readCSV(join(BUS, 'calendar.txt'));
  const exc = readCSV(join(BUS, 'calendar_dates.txt'));
  const weekly = new Map(), dated = new Set();
  for (const r of cal) {
    const flags = [r.sunday, r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday].map(x => x === '1');
    if (flags.some(Boolean)) weekly.set(r.service_id, { flags, start: r.start_date, end: r.end_date });
    else dated.add(r.service_id);
  }
  const tripCount = new Map(), routesOf = new Map();
  for (const t of trips.values()) {
    tripCount.set(t.service_id, (tripCount.get(t.service_id) || 0) + 1);
    if (!routesOf.has(t.service_id)) routesOf.set(t.service_id, new Set());
    routesOf.get(t.service_id).add(t.route_name);
  }
  const add = new Map(), rem = new Map();
  for (const r of exc) {
    const m = r.exception_type === '1' ? add : r.exception_type === '2' ? rem : null;
    if (!m || !/^\d{8}$/.test(r.date)) continue;
    if (!m.has(r.date)) m.set(r.date, new Set());
    m.get(r.date).add(r.service_id);
  }
  const feed = readCSV(join(BUS, 'feed_info.txt'))[0] || {};
  let first = feed.feed_start_date, last = feed.feed_end_date;
  const allDates = [...add.keys(), ...rem.keys()].sort();
  if (!/^\d{8}$/.test(first || '')) first = allDates[0];
  if (!/^\d{8}$/.test(last || '')) last = allDates[allDates.length - 1];
  if (!first || !last) return {};

  const bucketOfDow = dow => dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
  const out = {};
  const d = new Date(`${first.slice(0,4)}-${first.slice(4,6)}-${first.slice(6,8)}T00:00:00Z`);
  for (let guard = 0; guard < 800; guard++, d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), ymd = iso.replace(/-/g, '');
    if (ymd > last) break;
    const dow = d.getUTCDay();
    const active = new Set();
    for (const [sid, w] of weekly) if (ymd >= w.start && ymd <= w.end && w.flags[dow]) active.add(sid);
    (rem.get(ymd) || []).forEach(s => active.delete(s));
    (add.get(ymd) || []).forEach(s => active.add(s));
    // The day's type: the regular weekly services that still run vote.
    const votes = { weekday: 0, saturday: 0, sunday: 0 };
    for (const s of active) {
      const w = weekly.get(s); if (!w) continue;
      const f = w.flags;
      const b = f.slice(1, 6).some(Boolean) ? 'weekday' : f[6] ? 'saturday' : f[0] ? 'sunday' : null;
      if (b) votes[b] += tripCount.get(s) || 0;
    }
    let day = bucketOfDow(dow), best = 0;
    for (const b of ['weekday', 'saturday', 'sunday']) if (votes[b] > best) { best = votes[b]; day = b; }
    const entry = { day, services: [...active].sort() };
    if (rem.has(ymd)) entry.special = true;
    const alt = [...active].filter(s => dated.has(s) && (tripCount.get(s) || 0) >= ALT_MIN_TRIPS);
    if (alt.length) {
      entry.alt = true;
      entry.altRoutes = [...new Set(alt.flatMap(s => [...(routesOf.get(s) || [])]))].sort();
    }
    out[iso] = entry;
  }
  return out;
}

// ── 4. Routes ──────────────────────────────────────────────────
function buildRouteMap() {
  const rows = readCSV(join(BUS, 'routes.txt'));
  const byId = new Map();
  for (const r of rows) byId.set(r.route_id, r);
  return byId;
}

// ── 4b. Direction names (directions.txt) ───────────────────────
// route_short_name → { "0": "Eastbound", "1": "Westbound" }. Lets the client
// label a scheduled block's direction from GTFS directly, instead of having
// to learn it from a live bus (which fails when no bus is out that way yet —
// the source of the mystery "DI" pages).
function buildDirectionNames(routes) {
  const rows = readCSV(join(BUS, 'directions.txt'));
  const byRoute = new Map();
  for (const r of rows) {
    const route = routes.get(r.route_id);
    if (!route) continue;
    const name = route.route_short_name;
    if (!byRoute.has(name)) byRoute.set(name, {});
    byRoute.get(name)[r.direction_id] = r.direction;
  }
  return byRoute;
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
function emit(trips, stops, dirNames) {
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
      sv:        t.service_id, // which dates it runs: calendar-days.json
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
      directions: (dirNames && dirNames.get(name)) || {},
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
  const dirNames = buildDirectionNames(routes);
  log(`routes=${routes.size} stops=${stops.size} services=${services.size}`);

  log('parsing trips');
  const trips = buildTrips(routes, services);
  log(`trips=${trips.size}`);

  log('streaming stop_times (this is the big one)');
  await annotateTripsWithTimes(trips);

  log('emitting JSON');
  emit(trips, stops, dirNames);

  log('computing calendar overrides (holidays)');
  const overrides = buildCalendarOverrides();
  writeFileSync(join(OUT, 'calendar-overrides.json'), JSON.stringify(overrides));
  log(`calendar overrides: ${Object.keys(overrides).length} special dates`);

  log('computing calendar days (services per date, alternate schedules)');
  const days = buildCalendarDays(trips);
  writeFileSync(join(OUT, 'calendar-days.json'), JSON.stringify(days));
  const alts = Object.entries(days).filter(([, v]) => v.alt || v.special);
  log(`calendar days: ${Object.keys(days).length} dates, special: ${alts.map(([k, v]) => k + (v.alt ? '*' : '')).join(' ')}`);

  log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
