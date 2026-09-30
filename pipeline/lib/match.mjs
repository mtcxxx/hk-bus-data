// Link TD timetable stop patterns to operator ETA route variants by geography.

const R = 6371000;
export function dist(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Which ETA feeds serve a GTFS agency. */
export function feedsFor(agency) {
  const out = [];
  if (agency.includes('KMB') || agency.includes('LWB')) out.push('KMB');
  if (agency.includes('CTB')) out.push('CTB');
  if (agency === 'NLB') out.push('NLB');
  return out;
}

/**
 * Score how well a variant follows a pattern: mean nearest distance of pattern stops to the
 * variant's stops, plus the distance between first and last stops (catches wrong direction).
 */
export function score(patStops, v) {
  const vs = v.stops.filter((s) => Number.isFinite(s.lat));
  if (!vs.length || !patStops.length) return Infinity;
  let sum = 0;
  for (const p of patStops) {
    let m = Infinity;
    for (const s of vs) m = Math.min(m, dist(p, s));
    sum += m;
  }
  const ends = dist(patStops[0], vs[0]) + dist(patStops[patStops.length - 1], vs[vs.length - 1]);
  return sum / patStops.length + ends / 4;
}

/**
 * Monotonic nearest-stop alignment: each pattern stop -> variant stop (or none if > maxM).
 * The first match may be anywhere in the variant (operators often list extra stops before the
 * TD pattern starts); later matches look a little ahead of the previous one.
 * `fromPos`/`toPos` limit which pattern positions are aligned (for the halves of circular routes).
 */
export function align(patStops, v, maxM = 180, fromPos = 0, toPos = patStops.length) {
  // Try every plausible starting point in the variant (a loop's first and last stop are the
  // same place) and keep the alignment that links the most stops.
  let best = null;
  for (let i = fromPos; i < toPos && !best; i++) {
    const starts = [];
    v.stops.forEach((s, j) => {
      if (Number.isFinite(s.lat) && dist(patStops[i], s) <= maxM) starts.push(j);
    });
    for (const j of starts.slice(0, 6)) {
      const r = alignFrom(patStops, v, maxM, i, j, toPos);
      if (!best || r.count > best.count) best = r;
    }
  }
  return best ?? { ids: new Array(patStops.length).fill(''), seqs: new Array(patStops.length).fill(0), count: 0 };
}

function alignFrom(patStops, v, maxM, i0, j0, toPos) {
  const ids = new Array(patStops.length).fill('');
  const seqs = new Array(patStops.length).fill(0);
  ids[i0] = v.stops[j0].id;
  seqs[i0] = v.stops[j0].seq;
  let from = j0 + 1;
  let count = 1;
  for (let i = i0 + 1; i < toPos; i++) {
    let best = -1;
    let bd = Infinity;
    for (let j = from; j < Math.min(v.stops.length, from + 15); j++) {
      const s = v.stops[j];
      if (!Number.isFinite(s.lat)) continue;
      const d = dist(patStops[i], s);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best >= 0 && bd <= maxM) {
      ids[i] = v.stops[best].id;
      seqs[i] = v.stops[best].seq;
      from = best + 1;
      count++;
    }
  }
  return { ids, seqs, count };
}

const countIds = (ids) => ids.filter(Boolean).length;

/**
 * Attach eta refs (and nicer operator names) to each pattern.
 * @param patterns from buildBusNetwork
 * @param stops    [id,en,tc,lat,lon] rows
 * @param variants from fetchKmb/fetchCtb/fetchNlb
 */
export function attachEta(patterns, stops, variants, log = () => {}) {
  const byCoRoute = new Map();
  for (const v of variants) {
    const k = `${v.co}|${v.route}`;
    if (!byCoRoute.has(k)) byCoRoute.set(k, []);
    byCoRoute.get(k).push(v);
  }
  let linked = 0;
  let unlinked = 0;
  for (const p of patterns) {
    const ps = p.s.map((i) => ({ lat: stops[i][3], lon: stops[i][4] }));
    const n = ps.length;
    p.eta = [];
    let named = false;
    for (const co of feedsFor(p.co)) {
      const cands = byCoRoute.get(`${co}|${p.no}`) ?? [];
      if (!cands.length) continue;
      // Best variant: most stops aligned, then closest overall (prefer KMB service type 1).
      let best = null;
      for (const v of cands) {
        const al = align(ps, v);
        const c = countIds(al.ids);
        const sc = score(ps, v) + (v.st && v.st !== '1' ? 25 : 0);
        if (!best || c > best.c || (c === best.c && sc < best.sc)) best = { v, al, c, sc };
      }
      if (!best || best.c < Math.max(2, Math.ceil(n * 0.4))) continue;
      const refs = [{ v: best.v, al: best.al }];
      // Circular routes: operators split the loop into two directions. Link the part of the
      // pattern after (or before) the first match to the other half.
      const first = best.al.ids.findIndex(Boolean);
      const last = n - 1 - [...best.al.ids].reverse().findIndex(Boolean);
      for (const [a, b] of [[last + 1, n], [0, first]]) {
        if (b - a < 3) continue;
        let extra = null;
        for (const v of cands) {
          if (v === best.v) continue;
          const al = align(ps, v, 180, a, b);
          const c = countIds(al.ids);
          if (c >= 3 && (!extra || c > extra.c)) extra = { v, al, c };
        }
        if (extra) refs.push(extra);
      }
      for (const { v, al } of refs) {
        const ref = { co, route: v.route, dir: v.dir, stops: al.ids, seqs: al.seqs };
        if (v.st) ref.st = v.st;
        if (v.nlb) ref.nlb = v.nlb;
        p.eta.push(ref);
      }
      if (!p.x && !named && best.v.oe) {
        // The operator's own ends for this direction are more precise than TD's long name.
        named = true;
        p.oe = best.v.oe;
        p.de = best.v.de;
        if (best.v.ot) {
          p.ot = best.v.ot;
          p.dt = best.v.dt;
        }
      }
    }
    if (p.eta.length) linked++;
    else unlinked++;
  }
  log(`patterns linked to live ETA: ${linked}, without: ${unlinked}`);
}
