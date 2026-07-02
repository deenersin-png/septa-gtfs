// Continuously polls SEPTA's live TransitViewAll feed for ~9.5 minutes,
// detecting per-block pull-out/arrival transitions and matching them
// against the published GTFS trip data (data/<route>.json) by exact
// trip_id (TransitViewAll's `trip` field lines up with GTFS trip_id).
// Builds a rolling, self-correcting "what actually happens" schedule under
// data-observed/ — cross-checked against, not a replacement for, the GTFS
// schedule in data/.
//
// Runs every ~10 min via .github/workflows/poll-observed.yml. Each run does
// its own internal poll loop so a single cron trigger still gives
// near-continuous coverage without generating hundreds of commits/day.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const OBS_DIR  = path.join(__dirname, 'data-observed');
const STATE_FILE = path.join(OBS_DIR, 'state.json');

const TRANSIT_VIEW_ALL    = 'https://www3.septa.org/api/TransitViewAll/index.php';
const POLL_INTERVAL_MS    = 45 * 1000;
const RUN_DURATION_MS     = 9.5 * 60 * 1000; // stay under the 10-min cron gap
const MISSING_DEBOUNCE_MS = 90 * 1000;       // ~2 missed cycles before calling a block "ended"
const MAX_SAMPLES         = 15;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowMinET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

function fmtClock(min) {
  min = ((min % 1440) + 1440) % 1440;
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return h + ':' + m;
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { blocks: {} }; }
}

function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// route_id from TransitViewAll already matches data/<route>.json's naming
// (both use GTFS's "new" route names — T1-T5, G1, 63, etc.) — no alias
// translation needed here.
const gtfsCache = new Map();
function loadGtfsRoute(routeId) {
  if (gtfsCache.has(routeId)) return gtfsCache.get(routeId);
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, routeId + '.json'), 'utf8')); }
  catch { data = null; }
  gtfsCache.set(routeId, data);
  return data;
}

// Find which day-type bucket (weekday/saturday/sunday) a live trip_id
// belongs to — searching all three instead of pre-computing "today's"
// day-type sidesteps any timezone/day-boundary edge cases entirely.
function findTrip(routeId, tripId) {
  const data = loadGtfsRoute(routeId);
  if (!data) return null;
  for (const dayType of ['weekday', 'saturday', 'sunday']) {
    const trip = (data[dayType] || []).find(t => String(t.trip_id) === String(tripId));
    if (trip) return { dayType, trip };
  }
  return null;
}

const obsCache = new Map(); // routeId -> observed JSON, mutated in memory, saved once at the end
function loadObserved(routeId) {
  if (obsCache.has(routeId)) return obsCache.get(routeId);
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(OBS_DIR, routeId + '.json'), 'utf8')); }
  catch { data = {}; }
  obsCache.set(routeId, data);
  return data;
}

function pushSample(routeId, blockId, dayType, tripId, kind, min) {
  const obs = loadObserved(routeId);
  if (!obs[blockId]) obs[blockId] = {};
  if (!obs[blockId][dayType]) obs[blockId][dayType] = {};
  if (!obs[blockId][dayType][tripId]) obs[blockId][dayType][tripId] = { startSamples: [], endSamples: [] };
  const slot = obs[blockId][dayType][tripId];
  const arr = kind === 'start' ? slot.startSamples : slot.endSamples;
  arr.push(min);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

function finalizeObserved(obs) {
  for (const blockId of Object.keys(obs)) {
    for (const dayType of Object.keys(obs[blockId])) {
      for (const tripId of Object.keys(obs[blockId][dayType])) {
        const slot = obs[blockId][dayType][tripId];
        if (slot.startSamples.length) slot.avgStart = fmtClock(Math.round(avg(slot.startSamples)));
        if (slot.endSamples.length)   slot.avgEnd   = fmtClock(Math.round(avg(slot.endSamples)));
        slot.samples = Math.max(slot.startSamples.length, slot.endSamples.length);
      }
    }
  }
}

async function pollOnce(state) {
  let json;
  try {
    const res = await fetch(TRANSIT_VIEW_ALL);
    if (!res.ok) return;
    json = await res.json();
  } catch (e) { console.warn('fetch failed:', e.message); return; }

  const min = nowMinET();
  const liveKeys = new Set();

  for (const routeObj of json.routes || []) {
    for (const routeId of Object.keys(routeObj)) {
      for (const bus of routeObj[routeId] || []) {
        const blockId = String(bus.BlockID || '').trim();
        if (!blockId || blockId === '0') continue;
        const key = routeId + '|' + blockId;
        liveKeys.add(key);

        const existing = state.blocks[key];
        if (!existing || !existing.isLive) {
          // newly appeared → pull-out event
          const tripId = String(bus.trip || '');
          const found = tripId ? findTrip(routeId, tripId) : null;
          if (found) pushSample(routeId, blockId, found.dayType, tripId, 'start', min);
          state.blocks[key] = { routeId, blockId, isLive: true, tripId, lastSeenMin: min, missingSince: null };
        } else {
          existing.isLive = true;
          existing.lastSeenMin = min;
          existing.missingSince = null;
        }
      }
    }
  }

  const nowMs = Date.now();
  for (const b of Object.values(state.blocks)) {
    const key = b.routeId + '|' + b.blockId;
    if (liveKeys.has(key) || !b.isLive) continue;
    if (b.missingSince == null) { b.missingSince = nowMs; continue; }
    if (nowMs - b.missingSince < MISSING_DEBOUNCE_MS) continue;
    // confirmed ended — record against the trip that was actually running
    if (b.tripId) {
      const found = findTrip(b.routeId, b.tripId);
      if (found) pushSample(b.routeId, b.blockId, found.dayType, b.tripId, 'end', b.lastSeenMin);
    }
    b.isLive = false;
    b.missingSince = null;
  }
}

async function main() {
  const state = loadState();
  const deadline = Date.now() + RUN_DURATION_MS;
  let cycles = 0;
  while (true) {
    await pollOnce(state);
    cycles++;
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  console.log('poll-observed: ' + cycles + ' cycles, ' + Object.keys(state.blocks).length + ' tracked blocks, ' + obsCache.size + ' routes touched');

  saveJSON(STATE_FILE, state);
  for (const [routeId, data] of obsCache) {
    finalizeObserved(data);
    saveJSON(path.join(OBS_DIR, routeId + '.json'), data);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
