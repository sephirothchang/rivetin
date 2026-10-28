export const MAX_TEXT = 2 * 1024 * 1024;
export const MAX_ROWS = 20000;
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('CSV_SIZE_LIMIT');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 40) throw new Error('CSV_COLUMN_LIMIT'); };
  const pushRow = () => {
    pushCell(); if (row.some(value => value.trim())) rows.push(row);
    row = []; if (rows.length > MAX_ROWS + 1) throw new Error('CSV_ROW_LIMIT');
  };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') pushCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed || char === '"') throw new Error('CSV_QUOTING'); cell += char; }
  }
  if (quoted) throw new Error('CSV_QUOTING');
  if (row.length || cell || closed) pushRow();
  if (rows.length < 2) throw new Error('CSV_EMPTY');
  const headers = rows.shift().map(value => value.trim().toLowerCase());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV_HEADERS');
  if (rows.some(values => values.length !== headers.length)) throw new Error('CSV_WIDTH');
  return { headers, rows };
}

const aliases = {
  srcIp: ['src_ip', 'source_ip', '源ip', '源 ip', '源ip地址', '源 IP 地址'.toLowerCase()],
  dstIp: ['dst_ip', 'destination_ip', '目标ip', '目的ip', '目标 ip', '目的ip地址', '目标ip地址'],
  dstPort: ['dst_port', 'destination_port', '目标端口', '目的端口'],
  protocol: ['protocol', '协议', '协议类型']
};
export function mapColumns(headers, overrides = {}) {
  const result = {};
  for (const [key, names] of Object.entries(aliases)) {
    const matches = headers.map((name, index) => names.includes(name) ? index : -1).filter(index => index >= 0);
    result[key] = Object.hasOwn(overrides, key) ? Number(overrides[key]) : matches.length === 1 ? matches[0] : -1;
  }
  const values = Object.values(result);
  if (values.some(index => !Number.isInteger(index) || index < 0 || index >= headers.length) || new Set(values).size !== values.length) throw new Error('COLUMN_MAPPING');
  return result;
}
