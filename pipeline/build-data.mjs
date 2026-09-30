#!/usr/bin/env node
// Daily data build. Downloads official open data and writes network.json, mtr.json and
// meta.json to ./data-out (or the folder given with --out). Run: npm run build-data
//
// Options:
//   --out <dir>          output folder (default data-out)
//   --gtfs-dir <dir>     use GTFS .txt files from a folder instead of downloading
//   --mtr-peak-only      only refresh MTR peak headways in an existing <out>/mtr.json (run at ~08:15 HKT)
//   --force              publish even if far fewer routes than last time

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from './lib/build.mjs';
import { deriveRunningTimes } from './lib/mtr.mjs';

const GTFS_EN = 'https://static.data.gov.hk/td/pt-headway-en';
const GTFS_TC = 'https://static.data.gov.hk/td/pt-headway-tc';
const NEEDED = ['routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'stop_times.txt', 'stops.txt', 'fare_attributes.txt', 'fare_rules.txt'];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = resolve(opt('--out') ?? 'data-out');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function getText(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'hk-bus-alarm-data/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return (await res.text()).replace(/^\uFEFF/, '');
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw err;
}
const getJson = async (url) => JSON.parse(await getText(url));

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Unzip with fflate when installed (npm ci), else the system `unzip` (GitHub runners, macOS, Linux). */
async function unzipTexts(bytes) {
  try {
    const { unzipSync, strFromU8 } = await import('fflate');
    const out = {};
    for (const [name, b] of Object.entries(unzipSync(bytes))) out[name.split('/').pop()] = strFromU8(b);
    return out;
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    const dir = mkdtempSync(join(tmpdir(), 'gtfs-'));
    writeFileSync(join(dir, 'gtfs.zip'), bytes);
    execFileSync('unzip', ['-o', '-q', join(dir, 'gtfs.zip'), '-d', dir]);
    const out = {};
    for (const f of NEEDED) if (existsSync(join(dir, f))) out[f] = readFileSync(join(dir, f), 'utf8');
    return out;
  }
}

async function loadGtfs() {
  const dir = opt('--gtfs-dir');
  if (dir) {
    const files = {};
    for (const f of NEEDED) {
      const p = join(dir, f);
      if (existsSync(p)) files[f] = readFileSync(p, 'utf8');
    }
    const tcStops = join(dir, 'tc', 'stops.txt');
    const tcRoutes = join(dir, 'tc', 'routes.txt');
    if (existsSync(tcStops)) files.stopsTc = readFileSync(tcStops, 'utf8');
    if (existsSync(tcRoutes)) files.routesTc = readFileSync(tcRoutes, 'utf8');
    return { files, date: 'local' };
  }
  log('Downloading TD GTFS (English)…');
  const all = await unzipTexts(await getBytes(`${GTFS_EN}/gtfs.zip`));
  const files = {};
  for (const f of NEEDED) if (all[f]) files[f] = all[f].replace(/^\uFEFF/, '');
  for (const f of NEEDED) {
    if (files[f] || f === 'fare_rules.txt' || f === 'calendar_dates.txt') continue;
    files[f] = await getText(`${GTFS_EN}/${f}`);
  }
  log('Downloading Chinese stop and route names…');
  files.stopsTc = await getText(`${GTFS_TC}/stops.txt`);
  files.routesTc = await getText(`${GTFS_TC}/routes.txt`);
  let date = '';
  try {
    const csv = await getText(`${GTFS_EN}/DATA_LAST_UPDATED_DATE.csv`);
    date = (csv.match(/\d{4}-\d{2}-\d{2}/) ?? [''])[0];
  } catch {
    /* optional */
  }
  return { files, date };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (args.includes('--mtr-peak-only')) {
    const p = join(outDir, 'mtr.json');
    const mtr = JSON.parse(readFileSync(p, 'utf8'));
    const hops = mtr.lines.map((l) => l.hop);
    await deriveRunningTimes(mtr.lines, getJson, log, 'peak');
    mtr.lines.forEach((l, i) => (l.hop = hops[i])); // keep off-peak running times
    writeFileSync(p, JSON.stringify(mtr));
    log('Updated MTR peak headways.');
    return;
  }
  const { files, date } = await loadGtfs();
  const { network, mtr, meta } = await build({ gtfs: files, gtfsDate: date, getJson, getText, log });

  // Sanity checks: never publish a broken run.
  if (meta.routes > 50 && meta.withLiveEta < meta.routes * 0.5 && !args.includes('--force')) {
    log(`Refusing to publish: only ${meta.withLiveEta} of ${meta.routes} routes are linked to live times (an operator API was probably down). Try again later, or use --force.`);
    process.exit(3);
  }
  const prevMetaPath = join(outDir, 'meta.json');
  if (existsSync(prevMetaPath) && !args.includes('--force')) {
    try {
      const prev = JSON.parse(readFileSync(prevMetaPath, 'utf8'));
      if (meta.routes < prev.routes * 0.8 || meta.withLiveEta < prev.withLiveEta * 0.7) {
        log(`Refusing to publish: ${meta.routes} routes (${meta.withLiveEta} with live times) vs ${prev.routes} (${prev.withLiveEta}) last time. Run again with --force to override.`);
        process.exit(3);
      }
    } catch {
      /* no usable previous meta */
    }
  }
  writeFileSync(join(outDir, 'network.json'), JSON.stringify(network));
  if (mtr) {
    // Keep yesterday's peak headway measurement if there is one.
    const old = join(outDir, 'mtr.json');
    if (existsSync(old)) {
      try {
        const prev = JSON.parse(readFileSync(old, 'utf8'));
        for (const l of mtr.lines) {
          const pl = prev.lines?.find((x) => x.code === l.code);
          if (pl?.headway?.peak) l.headway.peak = Math.min(pl.headway.peak, l.headway.off);
        }
      } catch {
        /* ignore */
      }
    }
    writeFileSync(join(outDir, 'mtr.json'), JSON.stringify(mtr));
  }
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const size = (f) => (existsSync(join(outDir, f)) ? (readFileSync(join(outDir, f)).length / 1e6).toFixed(2) + ' MB' : '-');
  log(`Done: ${meta.routes} route patterns (${meta.withLiveEta} with live times), ${meta.stops} stops, ${meta.mtrStations} MTR stations.`);
  log(`network.json ${size('network.json')}, mtr.json ${size('mtr.json')} -> ${outDir}`);
  if (!mtr) log('WARNING: MTR data failed this run; kept the previous mtr.json (if any).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
