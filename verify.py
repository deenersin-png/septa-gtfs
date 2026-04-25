#!/usr/bin/env python3
"""Sanity-check the GTFS build assumptions against a real SEPTA bus zip.
Mirrors build.js's parsing logic. Outputs sample JSON for a few routes."""
import csv, json, os, sys
from pathlib import Path
from datetime import date

ROOT = Path(__file__).parent
BUS  = ROOT / 'tmp' / 'bus'
OUT  = ROOT / 'data-verify'
OUT.mkdir(exist_ok=True)

DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
DAY_TYPE = {'monday':'weekday','tuesday':'weekday','wednesday':'weekday',
            'thursday':'weekday','friday':'weekday','saturday':'saturday','sunday':'sunday'}

def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))

# 1. Calendar
print('parsing calendar...')
services = {}
for r in read_csv(BUS / 'calendar.txt'):
    types = {DAY_TYPE[d] for d in DAYS if r[d] == '1'}
    if types: services[r['service_id']] = types

# 2. Routes & stops
print('parsing routes + stops...')
routes = {r['route_id']: r for r in read_csv(BUS / 'routes.txt')}
stops  = {r['stop_id']: r['stop_name'] for r in read_csv(BUS / 'stops.txt')}

# 3. Trips
print('parsing trips...')
trips = {}
for r in read_csv(BUS / 'trips.txt'):
    if r['route_id'] not in routes: continue
    if r['service_id'] not in services: continue
    trips[r['trip_id']] = {
        'trip_id': r['trip_id'],
        'route_name': routes[r['route_id']]['route_short_name'],
        'block_id': r['block_id'],
        'direction': int(r['direction_id'] or 0),
        'headsign': r['trip_headsign'],
        'day_types': list(services[r['service_id']]),
        'first_seq': float('inf'), 'last_seq': float('-inf'),
        'start_time': None, 'end_time': None,
        'first_stop_id': None, 'last_stop_id': None,
    }

# 4. Stop times — streaming
print('streaming stop_times (large)...')
n = 0
with open(BUS / 'stop_times.txt', newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for r in reader:
        t = trips.get(r['trip_id'])
        if not t: continue
        seq = int(r['stop_sequence'] or 0)
        if seq < t['first_seq']:
            t['first_seq'] = seq
            t['start_time'] = r['departure_time'] or r['arrival_time']
            t['first_stop_id'] = r['stop_id']
        if seq > t['last_seq']:
            t['last_seq'] = seq
            t['end_time'] = r['arrival_time'] or r['departure_time']
            t['last_stop_id'] = r['stop_id']
        n += 1
        if n % 500_000 == 0: print(f'  {n:,} rows')

# 5. Emit sample for a few interesting routes
SAMPLES = ['G1', '63', 'T1', 'L1', '47']
by_route = {}
blocks = {}
for t in trips.values():
    if not t['start_time']: continue
    rn = t['route_name']
    by_route.setdefault(rn, {'weekday':[], 'saturday':[], 'sunday':[]})
    slim = {
        'trip_id': t['trip_id'],
        'block_id': t['block_id'],
        'direction': t['direction'],
        'headsign': t['headsign'],
        'start': t['start_time'],
        'end': t['end_time'],
        'first': stops.get(t['first_stop_id'], ''),
        'last': stops.get(t['last_stop_id'], ''),
    }
    for dt in t['day_types']:
        by_route[rn][dt].append(slim)
    if t['block_id'] and t['block_id'] != '0':
        blocks.setdefault(t['block_id'], {'route': rn, 'day_types': []})
        for dt in t['day_types']:
            if dt not in blocks[t['block_id']]['day_types']:
                blocks[t['block_id']]['day_types'].append(dt)

print(f'\nTotal routes emitted: {len(by_route)}')
print(f'Total blocks: {len(blocks)}')

for r in SAMPLES:
    if r not in by_route:
        print(f'  {r}: NOT FOUND')
        continue
    days = by_route[r]
    seen = set(); days['weekday'] = sorted(
        [t for t in days['weekday'] if not (t['trip_id'] in seen or seen.add(t['trip_id']))],
        key=lambda x: x['start'])
    print(f'  {r}: weekday={len(days["weekday"])} sat={len(days["saturday"])} sun={len(days["sunday"])}')
    if days['weekday']:
        sample = days['weekday'][0]
        print(f'      first trip: block {sample["block_id"]} {sample["start"]} {sample["first"]!r} -> {sample["last"]!r}')
    out_path = OUT / f'{r}.json'
    out_path.write_text(json.dumps({'route_short_name': r, **days}, indent=2)[:2000])

# Cross-check: confirm a TransitView block_id maps back to its route
print('\nCross-reference check:')
for tv_block in ['7668', '7675']:
    if tv_block in blocks:
        print(f'  block {tv_block} -> route {blocks[tv_block]["route"]} ({blocks[tv_block]["day_types"]})')
    else:
        print(f'  block {tv_block}: MISSING in GTFS')
