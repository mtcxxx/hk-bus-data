// Minimal RFC 4180 CSV parser (quotes, commas and newlines inside quotes, BOM).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV into objects keyed by the (trimmed) header row. */
export function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((v) => v.trim() === '')) continue;
    const o = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = (row[c] ?? '').trim();
    out.push(o);
  }
  return out;
}

/**
 * Fast line-by-line reader for big GTFS files without quoted commas (stop_times.txt).
 * Falls back to the full parser for lines containing quotes.
 */
export function* csvLines(text) {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let head = null;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    start = end + 1;
    if (!line) continue;
    const cells = line.includes('"') ? parseCsv(line)[0] : line.split(',');
    if (!head) {
      head = cells.map((h) => h.trim());
      continue;
    }
    const o = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = (cells[c] ?? '').trim();
    yield o;
  }
}
