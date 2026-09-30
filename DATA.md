# Data sources and formats

All data is official open data. Nothing is invented; estimates are labelled in the app.

| Use | Source | How |
|---|---|---|
| Live bus arrivals | KMB/LWB `data.etabus.gov.hk/v1/transport/kmb`, Citybus `rt.data.gov.hk/v2/transport/citybus`, NLB `rt.data.gov.hk/v2/transport/nlb` | Phone → API, every 30 s while a screen is open |
| Routes, stops, running times, departures, bus fares | Transport Department GTFS "pt-headway" (`static.data.gov.hk/td/pt-headway-en/gtfs.zip`, Chinese names from `pt-headway-tc`) | Daily file (TD updates about every 2 weeks) |
| Stop IDs for the live feeds | Operator route/stop lists | Daily file: each TD stop is matched to the nearest operator stop on the same route, in order |
| MTR next trains | `rt.data.gov.hk/v1/transport/mtr/getSchedule.php` | Phone → API |
| MTR lines, stations, fares | `opendata.mtr.com.hk/data/mtr_lines_and_stations.csv`, `mtr_lines_fares.csv` | Daily file |
| MTR station positions, place search | Lands Department Location Search `www.map.gov.hk/gs/api/v1.0.0/locationSearch` (HK1980 grid → WGS84) | Daily file / phone |
| Map | Lands Department XYZ tiles (`mapapi.geodata.gov.hk`) — "© Map from Lands Department" | Phone |
| Weather warnings | HKO `weather.php?dataType=warnsum` | Phone, every 10 min |
| Traffic news | TD `www.td.gov.hk/{en,tc}/special_news/trafficnews.xml` | Phone |
| Public holidays | 1823 `www.1823.gov.hk/common/ical/{en,tc}.json` | Phone, monthly |

## What the real feeds look like (checked 28 Sep 2026 through the built-in browser)
- TD `stop_times.txt` (50 MB) gives times **only at the first and last stop** of each trip; stops in between are blank. The build estimates them **by distance along the route**, and the app shows them as "~" timetable estimates.
- TD `service_id` is a bitmask: Mon=1 … Sun=64, **128 = also runs on public holidays**, and 256 marks services adjusted in `calendar_dates.txt` on holidays. The app uses the holiday bit on public holidays and falls back to Sunday only for data without it.
- Full build on the live data: 2,246 route patterns, 4,316 stops, **2,223 (99%) linked to live arrivals**, 97 MTR stations, 9,216 MTR fares, `network.json` 3.1 MB, about 7 s. Median distance from a TD stop to its operator stop is 14 m (99% within 80 m).
- Not linked (no matching live feed): KMB "K" routes (MTR feeder buses), and Citybus NR61/NR88/73X/314, which are missing from Citybus's feed.
- Circular routes: Citybus splits a loop into "outbound" and "inbound" halves; the build links each half of the TD pattern to the matching feed.

## Estimates (no official data exists)
- **Stop times between timepoints**: interpolated by distance along the route between TD's timed stops.
- **Walking**: straight-line distance × 1.3 at the walking speed in Settings (1.2 / 0.8 / 0.7 m/s).
- **MTR running time between stations**: taken from Next Train data during the daily build, as the time the same train reaches the next station. Falls back to 2.5 min per station.
- **MTR headway**: from Next Train data at 12:07 (off-peak) and 08:17 (peak, weekdays). First and last trains are assumed to be 06:00 and 00:30.
- **Station entry/exit**: 3 min added between street and platform.
- **Bus concession fares**: 60+ uses the HK$2 scheme; child fares are half the adult fare, rounded up to 10 cents.
- **Bus-to-bus interchange discounts**: not included; the app says so.

## Live-time rules
- The feeds carry no trip IDs and no bus positions. The app matches "your bus" by time: each live estimate is assigned to the nearest scheduled trip.
- KMB marks buses not yet on the road as "Scheduled Bus". Those show grey with "~", like timetable times.
- A bus that drops out of the feed is reported as "no longer in the live data" and never as "cancelled". The alarm then follows the next bus.

## Daily file format (v1)
`network.json`:
```ts
{ v: 1, generated: ISO, gtfsDate: 'YYYY-MM-DD',
  stops: [gtfsStopId, nameEn, nameTc, lat, lon][],
  routes: {
    k: '1002-1',          // TD route_id + bound (+ '-v1'… for extra stop patterns, x: true)
    no: '2', co: 'KMB', b: 1, oe, ot, de, dt,   // origin/destination names
    s: number[],          // stop indexes in order
    tt: { p: number[][],  // running-time profiles: minutes from first stop
          w: [start, end, headway, profile, dayMask][] },  // minutes; dayMask bit0 = Mon … bit6 = Sun
    f?: number[],         // adult fare boarding at each position
    eta: { co: 'KMB'|'CTB'|'NLB', route, dir: 'O'|'I', st?, nlb?, stops: string[], seqs: number[] }[]
  }[] }
```
`mtr.json`: `{ stations: {code,id,en,tc,lat,lon}[], lines: {code,en,tc,color,branches:{dir,stations}[],hop,headway:{peak,off},hours}[], fares: { 'srcId-destId': [adult, child, 60+] } }`

Public holidays use the Sunday timetable.
