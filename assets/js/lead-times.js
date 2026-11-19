// Data preparation and statistics for the lead-time dashboard (pure functions, no DOM).

export const SIZES = ['S', 'M', 'L'];
const DAY = 86400000;

const MONTH_STEMS = [
  ['sty', 1], ['lut', 2], ['mar', 3], ['kwi', 4], ['maj', 5], ['cze', 6],
  ['lip', 7], ['sie', 8], ['wrz', 9], ['paz', 10], ['lis', 11], ['gru', 12],
];

export function fold(text) {
  return String(text)
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function utcDay(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? t : null;
}

export function excelSerialToUtc(serial, date1904 = false) {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (date1904) return whole >= 0 && whole < 2957004 ? Date.UTC(1904, 0, 1) + whole * DAY : null;
  if (whole < 1 || whole > 2958465 || whole === 60) return null; // 60 = Excel's fictitious 29 Feb 1900
  return Date.UTC(1899, 11, whole < 60 ? 31 : 30) + whole * DAY;
}

/** Parses Polish text dates ("15 Lipca 2024", "15 lip 2024 r.") and numeric forms (2024-07-15, 15.07.2024). */
export function parsePolishDate(text) {
  const s = fold(text);
  let m = /^(\d{1,2})\.?\s*([a-z]{3,})\.?\s*(\d{4})(?:\s*r\.?)?$/.exec(s);
  if (m) {
    const stem = MONTH_STEMS.find(([p]) => m[2].startsWith(p));
    return stem ? utcDay(+m[3], stem[1], +m[1]) : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ][\d:.]+z?)?$/.exec(s);
  if (m) return utcDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s*r\.?)?$/.exec(s);
  if (m) return utcDay(+m[3], +m[2], +m[1]);
  return null;
}

export function parseDateCell(cell, date1904 = false) {
  if (!cell) return null;
  if (cell.type === 'number') return excelSerialToUtc(cell.value, date1904);
  if (cell.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell.value);
    return m ? utcDay(+m[1], +m[2], +m[3]) : null;
  }
  if (cell.type === 'string') return parsePolishDate(cell.value);
  return null;
}

const SIZE_ALIASES = {
  S: ['s', 'small', 'maly', 'male', 'mala'],
  M: ['m', 'medium', 'sredni', 'srednie', 'srednia'],
  L: ['l', 'large', 'duzy', 'duze', 'duza'],
};

export function normalizeSize(cell) {
  if (!cell || cell.type !== 'string') return null;
  const s = fold(cell.value).replace(/[()[\].,]/g, ' ').trim();
  const head = s.split(' ')[0];
  for (const [size, aliases] of Object.entries(SIZE_ALIASES)) {
    if (aliases.includes(s) || aliases.includes(head)) return size;
  }
  return null;
}

export function parseLeadTime(cell) {
  if (!cell) return null;
  let v = null;
  if (cell.type === 'number') v = cell.value;
  else if (cell.type === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(cell.value)) v = Number(cell.value.trim().replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function cellText(cell) {
  return cell && cell.type === 'string' ? fold(cell.value) : '';
}

const UNIT_PATTERNS = [
  [/\b(dni|dzien|dniach|days?)\b/, 'dni'],
  [/\b(dni robocz\w*|business days?|working days?)\b/, 'dni robocze'],
  [/\b(tyg\w*|weeks?)\b/, 'tygodnie'],
  [/\b(godz\w*|h|hours?)\b/, 'godziny'],
];

/** Detects the time unit from the lead-time header, e.g. "Czas realizacji (dni)". Returns null when absent. */
export function detectUnit(header) {
  const s = fold(header || '');
  const inner = /\(([^)]+)\)|\[([^\]]+)\]|\b(?:w|in)\s+(\w+)/.exec(s);
  const target = inner ? (inner[1] || inner[2] || inner[3]) : s.replace(/czas realizacji|lead time/g, '');
  for (const [re, unit] of [...UNIT_PATTERNS].reverse()) if (re.test(target)) return unit;
  return null;
}

function findColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cols = { date: -1, size: -1, lead: -1 };
    rows[i].cells.forEach((cell, idx) => {
      const t = cellText(cell);
      if (!t) return;
      if (cols.date < 0 && /data|date|ukoncz/.test(t)) cols.date = idx;
      else if (cols.size < 0 && /rozmiar|t-?shirt|size/.test(t)) cols.size = idx;
      else if (cols.lead < 0 && /czas|lead|cycle/.test(t)) cols.lead = idx;
    });
    if (cols.date >= 0 && cols.size >= 0 && cols.lead >= 0) {
      return { ...cols, headerIndex: i, leadHeader: rows[i].cells[cols.lead].value };
    }
  }
  return { date: 0, size: 1, lead: 2, headerIndex: -1, leadHeader: null };
}

/**
 * Converts sheet rows into task records. Invalid or empty rows between the header
 * and the last non-empty row are skipped and reported; duplicates and outliers are kept.
 */
export function extractTasks(sheet) {
  const { rows, date1904 } = sheet;
  const cols = findColumns(rows);
  const body = rows.slice(cols.headerIndex + 1);
  let last = body.length - 1;
  const isEmpty = (r) => !r.cells.some((c) => c && !(c.type === 'string' && c.value.trim() === ''));
  while (last >= 0 && isEmpty(body[last])) last--;

  const tasks = [];
  const skipped = [];
  let prevRow = cols.headerIndex >= 0 ? rows[cols.headerIndex].rowNumber : 0;
  for (const row of body.slice(0, last + 1)) {
    // Rows missing from the XML between data rows are blank rows in the sheet.
    for (let r = prevRow + 1; r < row.rowNumber; r++) skipped.push({ rowNumber: r, reason: 'pusty wiersz' });
    prevRow = row.rowNumber;
    if (isEmpty(row)) { skipped.push({ rowNumber: row.rowNumber, reason: 'pusty wiersz' }); continue; }
    const date = parseDateCell(row.cells[cols.date], date1904);
    const size = normalizeSize(row.cells[cols.size]);
    const lead = parseLeadTime(row.cells[cols.lead]);
    const problems = [];
    if (date === null) problems.push('data');
    if (size === null) problems.push('rozmiar');
    if (lead === null) problems.push('czas realizacji');
    if (problems.length) { skipped.push({ rowNumber: row.rowNumber, reason: `błędne pole: ${problems.join(', ')}` }); continue; }
    tasks.push({ id: tasks.length, rowNumber: row.rowNumber, date, size, lead });
  }
  return { tasks, skipped, unit: detectUnit(cols.leadHeader), leadHeader: cols.leadHeader };
}

/** Linear interpolation identical to Excel PERCENTILE.INC. */
export function percentileInc(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function percentiles(values) {
  return { p50: percentileInc(values, 0.5), p85: percentileInc(values, 0.85), p95: percentileInc(values, 0.95) };
}

export function addMonthsUtc(t, months) {
  const d = new Date(t);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last));
}

/**
 * Builds slider steps (3, 6, 9 … months) anchored at the latest completion date of the whole
 * data set, keeping only windows shorter than the full range, plus a final "whole period" step.
 */
export function buildPeriods(tasks) {
  if (!tasks.length) return [];
  const dates = tasks.map((t) => t.date);
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const periods = [];
  for (let months = 3; ; months += 3) {
    const start = addMonthsUtc(max, -months) + DAY;
    if (start <= min) break;
    periods.push({ months, start, end: max });
  }
  periods.push({ months: null, start: min, end: max });
  return periods;
}

export function selectSample(tasks, size, period) {
  return tasks.filter((t) => (size === 'ALL' || t.size === size) && (!period || (t.date >= period.start && t.date <= period.end)));
}

/** Groups tasks with identical coordinates (date + lead time). */
export function groupOverlaps(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const key = `${t.date}|${t.lead}`;
    if (!map.has(key)) map.set(key, { date: t.date, lead: t.lead, tasks: [] });
    map.get(key).tasks.push(t);
  }
  return [...map.values()];
}
