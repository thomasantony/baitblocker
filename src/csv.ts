/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = input.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** Block-list CSV (account_handle, description, ...) → seed entries. */
export function csvToSeeds(input: string): { handle: string; text: string }[] {
  const [header, ...rows] = parseCsv(input);
  if (!header) return [];
  const hi = header.indexOf('account_handle');
  const di = header.indexOf('description');
  if (hi < 0) throw new Error('CSV has no account_handle column');
  return rows.filter((r) => r[hi]).map((r) => ({ handle: r[hi], text: di >= 0 ? (r[di] ?? '') : '' }));
}
