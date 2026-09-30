import { buildBusNetwork } from './gtfs.mjs';
import { fetchKmb, fetchCtb, fetchNlb } from './operators.mjs';
import { attachEta } from './match.mjs';
import { buildMtr } from './mtr.mjs';
import { createHash } from 'node:crypto';

export const FORMAT_VERSION = 1;

/**
 * Build network.json and mtr.json.
 * @param {object} io { gtfs: Record<string,string>, gtfsDate: string, getJson(url), getText(url), log(msg) }
 */
export async function build(io) {
  const log = io.log ?? (() => {});
  const today = io.today ?? hkDateKey(Date.now());
  const bus = buildBusNetwork(io.gtfs, log, { today, horizon: hkDateKey(Date.now() + 7 * 86400000) });
  log(`patterns: ${bus.patterns.length}, stops: ${bus.stops.length}`);

  const variants = [];
  for (const [name, fn] of [['KMB', fetchKmb], ['CTB', fetchCtb], ['NLB', fetchNlb]]) {
    try {
      variants.push(...(await fn(io.getJson, log)));
    } catch (e) {
      log(`${name} route data failed: ${e.message} (live times for ${name} routes will be missing this run)`);
    }
  }
  attachEta(bus.patterns, bus.stops, variants, log);

  const routes = bus.patterns.map((p) => {
    const r = { k: p.k, no: p.no, co: p.co, b: p.b, oe: p.oe, ot: p.ot, de: p.de, dt: p.dt, s: p.s, tt: p.tt, eta: p.eta };
    if (p.f) r.f = p.f;
    if (p.x) r.x = true;
    return r;
  });

  const generated = new Date().toISOString();
  // Content hash: phones only download again when the data really changed.
  const hash = createHash('sha1').update(JSON.stringify([bus.stops, routes])).digest('hex').slice(0, 16);
  const network = { v: FORMAT_VERSION, generated, gtfsDate: io.gtfsDate, hash, stops: bus.stops, routes };

  let mtr = null;
  try {
    const m = await buildMtr(io.getText, io.getJson, log);
    mtr = { v: FORMAT_VERSION, generated, ...m };
  } catch (e) {
    log(`MTR data failed: ${e.message}`);
  }
  const meta = {
    v: FORMAT_VERSION,
    generated,
    gtfsDate: io.gtfsDate,
    hash,
    routes: routes.length,
    stops: bus.stops.length,
    withLiveEta: routes.filter((r) => r.eta.length).length,
    mtrStations: mtr?.stations.length ?? 0,
  };
  return { network, mtr, meta };
}

function hkDateKey(ms) {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
