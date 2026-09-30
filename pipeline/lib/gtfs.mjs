// Transport Department GTFS ("pt-headway") -> bus routes, stop patterns, timetables and fares.
// trip_id is "{route_id}-{bound}-{service_id}-{HHMM}". Frequencies give headway windows;
// each trip's stop_times give the running time to each stop.

import { csvObjects, csvLines } from './csv.mjs';

export const BUS_AGENCIES = new Set(['KMB', 'LWB', 'CTB', 'KMB+CTB', 'LWB+CTB', 'NLB']);
const DAY_COLS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function hmToMin(s) {
  if (!s) return NaN;
  const p = s.split(':');
  return +p[0] * 60 + +p[1] + (p[2] ? +p[2] / 60 : 0);
}

/** "[KMB] NAME|[CTB] NAME2" -> "NAME"; joint names "A/<BR>B" -> "A". */
export function cleanStopName(raw) {
  if (!raw) return '';
  let s = raw.split('|')[0];
  s = s.replace(/^\s*\[[^\]]*\]\s*/, '');
  s = s.split(/\/?<BR>/i)[0];
  return s.replace(/\s+/g, ' ').trim();
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * @param {Record<string,string>} files text of each GTFS file (English), plus optional
 *        stopsTc / routesTc (Traditional Chinese stops.txt / routes.txt)
 */
export function buildBusNetwork(files, log = () => {}, opts = {}) {
  // Only services valid from today to a week ahead (TD sometimes publishes the next timetable early).
  const today = opts.today ?? '00000000';
  const horizon = opts.horizon ?? '99999999';
  const routes = new Map();
  for (const r of csvObjects(files['routes.txt'])) {
    if (!BUS_AGENCIES.has(r.agency_id)) continue;
    if (r.route_type && r.route_type !== '3') continue;
    routes.set(r.route_id, { id: r.route_id, co: r.agency_id, no: r.route_short_name, long: r.route_long_name });
  }
  const routesTc = new Map();
  if (files.routesTc) for (const r of csvObjects(files.routesTc)) routesTc.set(r.route_id, r.route_long_name);

  const dayMask = new Map();
  let expired = 0;
  for (const c of csvObjects(files['calendar.txt'])) {
    if ((c.end_date && c.end_date < today) || (c.start_date && c.start_date > horizon)) {
      expired++;
      continue;
    }
    let m = 0;
    DAY_COLS.forEach((d, i) => {
      if (c[d] === '1') m |= 1 << i;
    });
    // TD encodes public holidays in the service id: bit 128 = "also runs on public holidays".
    // (calendar_dates then removes weekday runs on holidays and adds holiday runs; the app
    // uses bit 7 of the day mask on public holidays instead.)
    if (+c.service_id & 128) m |= 1 << 7;
    dayMask.set(c.service_id, m);
  }
  if (expired) log(`calendar: skipped ${expired} services outside ${today}..${horizon}`);

  const trips = new Map();
  for (const t of csvObjects(files['trips.txt'])) {
    if (!routes.has(t.route_id)) continue;
    const parts = t.trip_id.split('-');
    const bound = +parts[1] || 1;
    if (!dayMask.has(t.service_id)) continue;
    trips.set(t.trip_id, { id: t.trip_id, route: t.route_id, bound, mask: dayMask.get(t.service_id) ?? 0, stops: [], freq: [] });
  }

  for (const f of csvObjects(files['frequencies.txt'])) {
    const t = trips.get(f.trip_id);
    if (!t) continue;
    t.freq.push([hmToMin(f.start_time), hmToMin(f.end_time), (+f.headway_secs || 0) / 60]);
  }

  let n = 0;
  for (const st of csvLines(files['stop_times.txt'])) {
    const t = trips.get(st.trip_id);
    if (!t) continue;
    t.stops.push([+st.stop_sequence, st.stop_id, hmToMin(st.arrival_time || st.departure_time)]);
    n++;
  }
  log(`stop_times rows used: ${n}`);

  const stopRows = new Map();
  for (const s of csvObjects(files['stops.txt'])) {
    stopRows.set(s.stop_id, { id: s.stop_id, en: cleanStopName(s.stop_name), lat: +s.stop_lat, lon: +s.stop_lon, tc: '' });
  }
  if (files.stopsTc) {
    for (const s of csvObjects(files.stopsTc)) {
      const row = stopRows.get(s.stop_id);
      if (row) row.tc = cleanStopName(s.stop_name);
    }
  }

  // Fares: fare_id "{route_id}-{bound}-{boardSeq}-{alightSeq}"; section fares -> max per boarding seq.
  const fareFrom = new Map(); // `${route}-${bound}` -> Map(seq -> price)
  if (files['fare_attributes.txt']) {
    for (const f of csvObjects(files['fare_attributes.txt'])) {
      const p = f.fare_id.split('-');
      if (p.length < 4) continue;
      const key = `${p[0]}-${p[1]}`;
      const seq = +p[2];
      const price = +f.price;
      if (!Number.isFinite(price)) continue;
      let m = fareFrom.get(key);
      if (!m) fareFrom.set(key, (m = new Map()));
      m.set(seq, Math.max(m.get(seq) ?? 0, price));
    }
  }

  // Group trips into stop patterns per route+bound.
  const groups = new Map(); // `${route}-${bound}` -> Map(sig -> {stops, seqs, trips[]})
  for (const t of trips.values()) {
    if (!t.stops.length) continue;
    t.stops.sort((a, b) => a[0] - b[0]);
    // TD gives times only at timepoints (usually the first and last stop). Estimate the
    // others by distance along the route between timepoints.
    const times = t.stops.map((s) => s[2]);
    const cum = [0];
    for (let i = 1; i < t.stops.length; i++) {
      const a = stopRows.get(t.stops[i - 1][1]);
      const b = stopRows.get(t.stops[i][1]);
      const d = a && b && a.lat && b.lat ? distM(a, b) : 0;
      cum.push(cum[i - 1] + (d > 0 ? d : 1));
    }
    for (let i = 0; i < times.length; i++) {
      if (Number.isFinite(times[i])) continue;
      let a = i - 1;
      while (a >= 0 && !Number.isFinite(times[a])) a--;
      let b = i + 1;
      while (b < times.length && !Number.isFinite(times[b])) b++;
      if (a >= 0 && b < times.length) {
        const span = cum[b] - cum[a] || 1;
        times[i] = times[a] + ((times[b] - times[a]) * (cum[i] - cum[a])) / span;
      } else if (a >= 0) times[i] = times[a];
      else if (b < times.length) times[i] = times[b];
      else times[i] = 0;
    }
    const first = times[0];
    const offsets = times.map((x) => Math.max(0, Math.round(x - first)));
    for (let i = 1; i < offsets.length; i++) if (offsets[i] < offsets[i - 1]) offsets[i] = offsets[i - 1];
    const stopIds = t.stops.map((s) => s[1]);
    const seqs = t.stops.map((s) => s[0]);
    const sig = stopIds.join('>');
    const gk = `${t.route}-${t.bound}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = new Map()));
    let pat = g.get(sig);
    if (!pat) g.set(sig, (pat = { stopIds, seqs, trips: [] }));
    const windows = t.freq.length ? t.freq : [[first, first, 0]];
    pat.trips.push({ offsets, windows, mask: t.mask });
  }

  // Build output patterns.
  const usedStops = new Map(); // gtfs id -> index
  const stopList = [];
  const stopIndex = (id) => {
    let i = usedStops.get(id);
    if (i === undefined) {
      const s = stopRows.get(id) ?? { id, en: id, tc: '', lat: 0, lon: 0 };
      i = stopList.length;
      usedStops.set(id, i);
      stopList.push([s.id, s.en, s.tc || s.en, round5(s.lat), round5(s.lon)]);
    }
    return i;
  };

  const patterns = [];
  for (const [gk, g] of groups) {
    const [routeId, boundStr] = gk.split('-');
    const bound = +boundStr;
    const r = routes.get(routeId);
    const pats = [...g.values()].map((p) => ({ ...p, count: countDepartures(p.trips) }));
    pats.sort((a, b) => b.count - a.count || b.stopIds.length - a.stopIds.length);
    pats.forEach((p, vi) => {
      const profiles = [];
      const profKey = new Map();
      const wins = new Map();
      for (const t of p.trips) {
        const k = t.offsets.join(',');
        let pi = profKey.get(k);
        if (pi === undefined) {
          pi = profiles.length;
          profKey.set(k, pi);
          profiles.push(t.offsets);
        }
        for (const [s, e, h] of t.windows) {
          const wk = `${round1(s)}|${round1(e)}|${round1(h)}|${pi}`;
          wins.set(wk, (wins.get(wk) ?? 0) | t.mask);
        }
      }
      const w = [...wins.entries()]
        .map(([k, d]) => {
          const [s, e, h, pi] = k.split('|').map(Number);
          return [s, e, h, pi, d];
        })
        .filter((x) => x[4] !== 0)
        .sort((a, b) => a[0] - b[0]);
      const [la, lb] = splitLong(r.long);
      const fm = fareFrom.get(gk);
      const fares = fm ? p.seqs.map((sq) => fm.get(sq) ?? null) : undefined;
      patterns.push({
        // Main pattern keeps the plain key; extra patterns get a key from their stop list, so it
        // stays the same between builds (alarms and saved stops refer to these keys).
        k: vi === 0 ? gk : `${gk}-v${hashStr(p.stopIds.join('>'))}`,
        routeId,
        no: r.no,
        co: r.co,
        b: bound,
        long: r.long,
        longTc: routesTc.get(routeId) ?? '',
        oe: bound === 2 ? lb : la,
        de: bound === 2 ? la : lb,
        stopIds: p.stopIds,
        seqs: p.seqs,
        s: p.stopIds.map(stopIndex),
        tt: { p: profiles, w },
        f: fares && fares.some((x) => x != null) ? fares : undefined,
        x: vi > 0 || undefined,
      });
    });
  }
  // Chinese origin/destination from TC long names.
  for (const p of patterns) {
    const [a, b] = splitLong(p.longTc);
    p.ot = p.b === 2 ? b : a;
    p.dt = p.b === 2 ? a : b;
    if (p.x) {
      // Extra patterns: name ends from their own first/last stop.
      const first = stopList[p.s[0]];
      const last = stopList[p.s[p.s.length - 1]];
      p.oe = first[1];
      p.ot = first[2];
      p.de = last[1];
      p.dt = last[2];
    }
  }
  return { stops: stopList, patterns };
}

function splitLong(s) {
  if (!s) return ['', ''];
  const parts = s.split(/\s+-\s+|\s*－\s*|\s+–\s+/);
  if (parts.length >= 2) return [parts[0].trim(), parts[parts.length - 1].trim()];
  return [s.trim(), s.trim()];
}

function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

function countDepartures(trips) {
  let n = 0;
  for (const t of trips) {
    for (const [s, e, h] of t.windows) n += h > 0 ? Math.max(1, Math.floor((e - s) / h)) : 1;
  }
  return n;
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function distM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}
