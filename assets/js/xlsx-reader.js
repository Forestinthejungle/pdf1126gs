// Minimal, dependency-free XLSX reader: unzips with the native DecompressionStream
// and extracts cell values from the first worksheet (works in browsers and Node 18+).

const decoder = new TextDecoder('utf-8');

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Plik nie jest poprawnym archiwum XLSX.');
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Uszkodzony katalog archiwum XLSX.');
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.localOffset + 30 + view.getUint16(e.localOffset + 26, true) + view.getUint16(e.localOffset + 28, true);
      const raw = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return decoder.decode(raw);
      if (e.method === 8) return decoder.decode(await inflateRaw(raw));
      throw new Error(`Nieobsługiwana metoda kompresji (${e.method}).`);
    },
  };
}

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

function textRuns(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textRuns(m[1] || ''));
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

/**
 * Reads an XLSX file and returns the rows of its first worksheet.
 * Cells are { type: 'number' | 'string' | 'date' | 'bool' | 'error', value }.
 */
export async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  const workbook = await zip.text('xl/workbook.xml');
  if (!workbook) throw new Error('Brak pliku xl/workbook.xml – to nie jest skoroszyt Excela.');
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const firstSheet = /<sheet\b([^>]*?)\/?>/.exec(workbook);
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetName = '';
  if (firstSheet) {
    sheetName = attr(firstSheet[1], 'name') || '';
    const rid = attr(firstSheet[1], 'r:id');
    const rels = await zip.text('xl/_rels/workbook.xml.rels');
    if (rid && rels) {
      for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        if (attr(m[1], 'Id') === rid) sheetPath = resolvePath('xl/workbook.xml', attr(m[1], 'Target'));
      }
    }
  }
  const sheet = await zip.text(sheetPath);
  if (!sheet) throw new Error('Nie znaleziono arkusza w skoroszycie.');
  const shared = parseSharedStrings(await zip.text('xl/sharedStrings.xml'));

  const rows = [];
  let implicitRow = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rm[1], 'r')) || implicitRow + 1;
    implicitRow = rowNumber;
    const cells = [];
    let implicitCol = -1;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const col = ref ? columnIndex(ref) : implicitCol + 1;
      implicitCol = col;
      const t = attr(cm[1], 't') || 'n';
      const body = cm[2] || '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const raw = v ? decodeXml(v[1]) : null;
      let cell = null;
      if (t === 's' && raw !== null) cell = { type: 'string', value: shared[Number(raw)] ?? '' };
      else if (t === 'inlineStr') cell = { type: 'string', value: textRuns(body) };
      else if (t === 'str' && raw !== null) cell = { type: 'string', value: raw };
      else if (t === 'b' && raw !== null) cell = { type: 'bool', value: raw === '1' };
      else if (t === 'e') cell = { type: 'error', value: raw };
      else if (t === 'd' && raw !== null) cell = { type: 'date', value: raw };
      else if (raw !== null && raw !== '') cell = { type: 'number', value: Number(raw) };
      if (cell) cells[col] = cell;
    }
    rows.push({ rowNumber, cells });
  }
  return { sheetName, date1904, rows };
}
