// MTR lines, stations, fares (opendata.mtr.com.hk), station positions (Lands Department
// Location Search, HK1980 grid -> WGS84) and running times / headways derived from Next Train.

import { csvObjects } from './csv.mjs';

export const MTR_LINES_CSV = 'https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv';
export const MTR_FARES_CSV = 'https://opendata.mtr.com.hk/data/mtr_lines_fares.csv';
export const NEXT_TRAIN = 'https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php';
export const LOCATION_SEARCH = 'https://www.map.gov.hk/gs/api/v1.0.0/locationSearch';

export const LINE_INFO = {
  AEL: ['Airport Express', '機場快綫', '#00888A'],
  TCL: ['Tung Chung Line', '東涌綫', '#F7943E'],
  TML: ['Tuen Ma Line', '屯馬綫', '#923011'],
  TKL: ['Tseung Kwan O Line', '將軍澳綫', '#7D499D'],
  EAL: ['East Rail Line', '東鐵綫', '#53B7E8'],
  SIL: ['South Island Line', '南港島綫', '#BAC429'],
  TWL: ['Tsuen Wan Line', '荃灣綫', '#E2231A'],
  ISL: ['Island Line', '港島綫', '#007DC5'],
  KTL: ['Kwun Tong Line', '觀塘綫', '#00AB4E'],
  DRL: ['Disneyland Resort Line', '迪士尼綫', '#F173AC'],
};

// --- HK1980 grid -> WGS84 (same maths as src/lib/hk80.ts) ---
const E0 = 836694.05, N0 = 819069.8;
const LAT0 = (22 + 18 / 60 + 43.68 / 3600) * (Math.PI / 180);
const LON0 = (114 + 10 / 60 + 42.8 / 3600) * (Math.PI / 180);
const A = 6378388, E2 = 6.722670022e-3;
const A0 = 1 - E2 / 4 - (3 * E2 * E2) / 64, A2 = (3 / 8) * (E2 + (E2 * E2) / 4), A4 = (15 / 256) * E2 * E2;
const arc = (p) => A * (A0 * p - A2 * Math.sin(2 * p) + A4 * Math.sin(4 * p));
const M0 = arc(LAT0);
export function hk80ToWgs84(x, y) {
  const target = y - N0 + M0;
  let phi = LAT0 + (y - N0) / A;
  for (let i = 0; i < 10; i++) {
    const step = (arc(phi) - target) / (A * (A0 - 2 * A2 * Math.cos(2 * phi) + 4 * A4 * Math.cos(4 * phi)));
    phi -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  const s = Math.sin(phi);
  const nu = A / Math.sqrt(1 - E2 * s * s);
  const rho = (A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5);
  const t = Math.tan(phi);
  const dE = x - E0;
  const q = dE / nu;
  const lon = LON0 + (q - ((q * q * q) / 6) * (nu / rho + 2 * t * t)) / Math.cos(phi);
  const lat = phi - (t / rho) * ((dE * dE) / (2 * nu));
  return { lat: (lat * 180) / Math.PI - 5.5 / 3600, lon: (lon * 180) / Math.PI + 8.8 / 3600 };
}

function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 60000 : NaN; // minutes, local clock
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}

/** Stations and line branches from the lines CSV. */
export function parseLines(csvText) {
  const rows = csvObjects(csvText).filter((r) => r['Line Code'] && r['Station Code']);
  const stations = new Map();
  const branches = new Map(); // line -> Map(dir -> [{seq, code}])
  for (const r of rows) {
    const line = r['Line Code'];
    const dir = r['Direction'];
    const code = r['Station Code'];
    if (!stations.has(code)) stations.set(code, { code, id: +r['Station ID'], en: r['English Name'], tc: r['Chinese Name'], lat: 0, lon: 0 });
    if (!branches.has(line)) branches.set(line, new Map());
    const m = branches.get(line);
    if (!m.has(dir)) m.set(dir, []);
    m.get(dir).push({ seq: +r['Sequence'], code });
  }
  const lines = [];
  for (const [code, dirs] of branches) {
    const info = LINE_INFO[code] ?? [code, code, '#6B6B6B'];
    const br = [];
    for (const [dir, list] of dirs) {
      if (!/UT$/.test(dir)) continue; // keep the "up" order; the planner adds the reverse
      list.sort((a, b) => a.seq - b.seq);
      br.push({ dir, stations: list.map((x) => x.code) });
    }
    lines.push({ code, en: info[0], tc: info[1], color: info[2], branches: br, hop: br.map((b) => b.stations.slice(1).map(() => 2.5)), headway: { peak: 3, off: 5 }, hours: [360, 1470] });
  }
  return { stations: [...stations.values()], lines };
}

export function parseFares(csvText) {
  const fares = {};
  for (const r of csvObjects(csvText)) {
    const src = r.SRC_STATION_ID;
    const dst = r.DEST_STATION_ID;
    if (!src || !dst) continue;
    const adult = +r.OCT_ADT_FARE;
    const child = +r.OCT_CON_CHILD_FARE;
    const elderly = +r.OCT_JOYYOU_SIXTY_FARE || +r.OCT_CON_ELDERLY_FARE;
    if (Number.isFinite(adult)) fares[`${+src}-${+dst}`] = [adult, Number.isFinite(child) ? child : adult, Number.isFinite(elderly) ? elderly : adult];
  }
  return fares;
}

/** Station positions via the Location Search API. */
export async function locateStations(stations, getJson, log = () => {}) {
  await pool(stations, 4, async (st) => {
    try {
      const q = `${st.en} Station`;
      const rows = await getJson(`${LOCATION_SEARCH}?q=${encodeURIComponent(q)}`);
      const pick =
        rows.find((r) => (r.nameEN ?? '').toLowerCase() === q.toLowerCase()) ??
        rows.find((r) => (r.nameZH ?? '') === `${st.tc}站`) ??
        rows.find((r) => /station/i.test(r.nameEN ?? '') && (r.nameEN ?? '').toLowerCase().includes(st.en.toLowerCase()));
      if (pick) {
        const p = hk80ToWgs84(pick.x, pick.y);
        st.lat = Math.round(p.lat * 1e5) / 1e5;
        st.lon = Math.round(p.lon * 1e5) / 1e5;
      } else log(`No position for ${st.code} ${st.en}`);
    } catch (e) {
      log(`Location search ${st.code}: ${e.message}`);
    }
  });
}

/**
 * Derive minutes between stations and typical headway from Next Train data.
 * For consecutive stations A -> B in "UT" order, the first UP train at A reaches B at the
 * first UP train time at B that is later than it. Falls back to 2.5 min per hop.
 */
export async function deriveRunningTimes(lines, getJson, log = () => {}, which = 'off') {
  for (const line of lines) {
    const needed = [...new Set(line.branches.flatMap((b) => b.stations))];
    const board = new Map();
    await pool(needed, 4, async (sta) => {
      try {
        const j = await getJson(`${NEXT_TRAIN}?line=${line.code}&sta=${sta}&lang=EN`);
        if (j.status === 0) return;
        const blk = j.data?.[`${line.code}-${sta}`] ?? {};
        board.set(sta, { up: (blk.UP ?? []).map((t) => parseLocal(t.time)), down: (blk.DOWN ?? []).map((t) => parseLocal(t.time)) });
      } catch (e) {
        log(`Next train ${line.code}-${sta}: ${e.message}`);
      }
    });
    const heads = [];
    line.branches.forEach((br, bi) => {
      const hops = [];
      for (let i = 0; i < br.stations.length - 1; i++) {
        const a = board.get(br.stations[i]);
        const b = board.get(br.stations[i + 1]);
        let h = NaN;
        if (a && b) {
          const ests = [];
          for (const ta of a.up.slice(0, 2)) {
            const tb = b.up.find((x) => x > ta);
            if (tb !== undefined && tb - ta <= 10) ests.push(tb - ta);
          }
          for (const tb of b.down.slice(0, 2)) {
            const ta = a.down.find((x) => x > tb);
            if (ta !== undefined && ta - tb <= 10) ests.push(ta - tb);
          }
          h = median(ests);
        }
        hops.push(Number.isFinite(h) ? Math.max(1, Math.min(8, h)) : 2.5);
        if (a) for (let k = 1; k < a.up.length; k++) heads.push(a.up[k] - a.up[k - 1]);
      }
      line.hop[bi] = hops;
    });
    const hw = median(heads.filter((x) => x > 0 && x < 30));
    if (Number.isFinite(hw)) line.headway[which] = Math.max(2, hw);
  }
}

export async function buildMtr(getText, getJson, log = () => {}) {
  const { stations, lines } = parseLines(await getText(MTR_LINES_CSV));
  const fares = parseFares(await getText(MTR_FARES_CSV));
  await locateStations(stations, getJson, log);
  await deriveRunningTimes(lines, getJson, log, 'off');
  for (const l of lines) if (l.headway.peak > l.headway.off) l.headway.peak = l.headway.off;
  return { stations, lines, fares };
}
