# hk-bus-data

The daily timetable file for **HK Bus Alarm** (https://bus.resonate04170619.com), built only from official Hong Kong open data. It includes:
- Transport Department GTFS timetables
- the KMB, Citybus and NLB route and stop lists
- MTR lines, stations and fares, plus MTR Next Train times
- station positions from the Lands Department

The **Daily data** workflow runs at 12:07 Hong Kong time. On weekdays it also runs at 08:17 to update MTR peak headways. Each run publishes these files to the `data` branch:

- `data/network.json`: routes, stops, timetables, fares, and links to the live arrival feeds
- `data/mtr.json`: MTR lines, stations and fares
- `data/meta.json`: build time, counts and a content hash

A run that looks broken (too few routes linked to live times, or a large drop from the previous build) is not published, so the previous files stay in place.

Run it by hand: Actions → Daily data → Run workflow. File format and sources: [DATA.md](DATA.md).

Only the builder lives here; the app's code is kept separately.
