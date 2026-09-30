// Route/stop lists from the KMB, Citybus and NLB open APIs, used to link each timetable
// stop to the stop ID each operator's live ETA feed expects.

export const KMB = 'https://data.etabus.gov.hk/v1/transport/kmb';
export const CTB = 'https://rt.data.gov.hk/v2/transport/citybus';
export const NLB = 'https://rt.data.gov.hk/v2/transport/nlb';

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function retry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw err;
}

/** @returns variants: { co, route, dir, st?, nlb?, oe, ot, de, dt, stops: [{id, seq, lat, lon}] } */
export async function fetchKmb(getJson, log = () => {}) {
  const [routes, stops, rs] = await Promise.all([
    retry(() => getJson(`${KMB}/route/`)),
    retry(() => getJson(`${KMB}/stop`)),
    retry(() => getJson(`${KMB}/route-stop`)),
  ]);
  const stopMap = new Map(stops.data.map((s) => [s.stop, { lat: +s.lat, lon: +s.long, en: s.name_en, tc: s.name_tc }]));
  const byKey = new Map();
  for (const r of routes.data) {
    byKey.set(`${r.route}|${r.bound}|${r.service_type}`, {
      co: 'KMB', route: r.route, dir: r.bound, st: String(r.service_type),
      oe: r.orig_en, ot: r.orig_tc, de: r.dest_en, dt: r.dest_tc, stops: [],
    });
  }
  for (const x of rs.data) {
    const v = byKey.get(`${x.route}|${x.bound}|${x.service_type}`);
    const s = stopMap.get(x.stop);
    if (v && s) v.stops.push({ id: x.stop, seq: +x.seq, lat: s.lat, lon: s.lon });
  }
  const out = [...byKey.values()].filter((v) => v.stops.length);
  for (const v of out) v.stops.sort((a, b) => a.seq - b.seq);
  log(`KMB variants: ${out.length}`);
  return out;
}

export async function fetchCtb(getJson, log = () => {}) {
  const routes = await retry(() => getJson(`${CTB}/route/ctb`));
  const variants = [];
  await pool(routes.data, 6, async (r) => {
    for (const [dir, word] of [['O', 'outbound'], ['I', 'inbound']]) {
      try {
        const j = await retry(() => getJson(`${CTB}/route-stop/ctb/${encodeURIComponent(r.route)}/${word}`));
        const rows = j.data ?? [];
        if (!rows.length) continue;
        variants.push({
          co: 'CTB', route: r.route, dir,
          oe: dir === 'O' ? r.orig_en : r.dest_en, ot: dir === 'O' ? r.orig_tc : r.dest_tc,
          de: dir === 'O' ? r.dest_en : r.orig_en, dt: dir === 'O' ? r.dest_tc : r.orig_tc,
          stops: rows.map((x) => ({ id: x.stop, seq: +x.seq, lat: NaN, lon: NaN })).sort((a, b) => a.seq - b.seq),
        });
      } catch (e) {
        log(`CTB ${r.route} ${word}: ${e.message}`);
      }
    }
  });
  const ids = [...new Set(variants.flatMap((v) => v.stops.map((s) => s.id)))];
  const pos = new Map();
  await pool(ids, 8, async (id) => {
    try {
      const j = await retry(() => getJson(`${CTB}/stop/${id}`));
      pos.set(id, { lat: +j.data.lat, lon: +j.data.long });
    } catch (e) {
      log(`CTB stop ${id}: ${e.message}`);
    }
  });
  for (const v of variants) for (const s of v.stops) Object.assign(s, pos.get(s.id) ?? {});
  log(`CTB variants: ${variants.length}, stops: ${ids.length}`);
  return variants;
}

export async function fetchNlb(getJson, log = () => {}) {
  const j = await retry(() => getJson(`${NLB}/route.php?action=list`));
  const variants = [];
  await pool(j.routes ?? [], 6, async (r) => {
    try {
      const s = await retry(() => getJson(`${NLB}/stop.php?action=list&routeId=${r.routeId}`));
      const [oe, de] = (r.routeName_e ?? '').split('>').map((x) => x.trim());
      const [ot, dt] = (r.routeName_c ?? '').split('>').map((x) => x.trim());
      variants.push({
        co: 'NLB', route: r.routeNo, dir: 'O', nlb: String(r.routeId), oe, ot, de, dt,
        stops: (s.stops ?? []).map((x, i) => ({ id: String(x.stopId), seq: i + 1, lat: +x.latitude, lon: +x.longitude })),
      });
    } catch (e) {
      log(`NLB ${r.routeId}: ${e.message}`);
    }
  });
  log(`NLB variants: ${variants.length}`);
  return variants;
}
