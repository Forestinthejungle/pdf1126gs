// Daily throughput (delivery rate) imports: one row per calendar day with the number of delivered tasks.
// Pure functions, no DOM. Each day is shaped like a task ({ date, lead, completedAt, … }) so the same
// XmR and Western Electric functions from lead-times.js apply unchanged (lead = delivered tasks that day).
import { fold, parseDateCell } from './lead-times.js';

const THROUGHPUT_HEADER = /przepustowo|throughput|dostarcz|delivered|tempo/;

function cellText(cell) {
  return cell && cell.type === 'string' ? fold(cell.value) : '';
}

function findColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cols = { date: -1, count: -1, comment: -1 };
    rows[i].cells.forEach((cell, idx) => {
      const t = cellText(cell);
      if (!t) return;
      if (cols.comment < 0 && /komentarz|comment|uwag/.test(t)) cols.comment = idx;
      else if (cols.count < 0 && THROUGHPUT_HEADER.test(t)) cols.count = idx;
      else if (cols.date < 0 && /data|date|dzien|day/.test(t)) cols.date = idx;
    });
    if (cols.date >= 0 && cols.count >= 0) return { ...cols, headerIndex: i };
  }
  return null;
}

/** True when the first sheet has a date column and a throughput column (e.g. "Data", "Przepustowość"). */
export function isThroughputSheet(sheet) {
  return Boolean(findColumns(sheet.rows));
}

function parseCount(cell) {
  if (!cell) return null;
  let v = null;
  if (cell.type === 'number') v = cell.value;
  else if (cell.type === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(cell.value)) v = Number(cell.value.trim().replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Converts throughput rows into day records { id, rowNumber, date, lead, completedAt, hasTime, size: 'D' }.
 * Empty and invalid rows are skipped and reported; a repeated date in one file is reported and skipped.
 */
export function extractThroughput(sheet) {
  const { rows, date1904 } = sheet;
  const cols = findColumns(rows);
  if (!cols) throw new Error('Nie znaleziono kolumn daty i przepustowości.');
  const body = rows.slice(cols.headerIndex + 1);
  const isEmpty = (r) => !r.cells.some((c) => c && !(c.type === 'string' && c.value.trim() === ''));
  let last = body.length - 1;
  while (last >= 0 && isEmpty(body[last])) last--;

  const days = [];
  const skipped = [];
  const seen = new Set();
  let prevRow = rows[cols.headerIndex].rowNumber;
  for (const row of body.slice(0, last + 1)) {
    for (let r = prevRow + 1; r < row.rowNumber; r++) skipped.push({ rowNumber: r, reason: 'pusty wiersz' });
    prevRow = row.rowNumber;
    if (isEmpty(row)) { skipped.push({ rowNumber: row.rowNumber, reason: 'pusty wiersz' }); continue; }
    const date = parseDateCell(row.cells[cols.date], date1904);
    const count = parseCount(row.cells[cols.count]);
    const problems = [];
    if (date === null) problems.push('data');
    if (count === null) problems.push('przepustowość');
    if (problems.length) { skipped.push({ rowNumber: row.rowNumber, reason: `błędne pole: ${problems.join(', ')}` }); continue; }
    if (seen.has(date)) { skipped.push({ rowNumber: row.rowNumber, reason: 'powtórzona data' }); continue; }
    seen.add(date);
    const comment = cols.comment >= 0 && row.cells[cols.comment]?.type === 'string' ? row.cells[cols.comment].value.trim() || null : null;
    days.push(day(days.length, row.rowNumber, date, count, comment));
  }
  days.sort((a, b) => a.date - b.date);
  return { days, skipped };
}

function day(id, rowNumber, date, lead, comment = null) {
  return { id, rowNumber, date, lead, completedAt: date, hasTime: false, size: 'D', taskId: null, contextChange: null, comment };
}

/** Merges throughput files: counts of the same date are summed. Days are sorted by date and renumbered. */
export function combineThroughput(imports) {
  const map = new Map();
  for (const imp of imports) {
    for (const d of imp.days) {
      if (!map.has(d.date)) map.set(d.date, { ...day(0, d.rowNumber, d.date, 0), files: [], comments: [] });
      const e = map.get(d.date);
      e.lead += d.lead;
      e.files.push(imp.name);
      if (d.comment) e.comments.push(d.comment);
    }
  }
  return [...map.values()]
    .sort((a, b) => a.date - b.date)
    .map((d, i) => ({ ...d, id: i, file: d.files.join(', '), comment: d.comments.join('; ') || null }));
}

const DAY = 86400000;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);

/** Easter Sunday (Gregorian calendar, anonymous algorithm) as a UTC timestamp. */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

const holidayCache = new Map();
/** Public holidays in Poland (days off by law) for one year: Map<UTC timestamp, name>. */
export function polishHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const easter = easterSunday(year);
  const list = [
    [utc(year, 1, 1), 'Nowy Rok'],
    [utc(year, 1, 6), 'Trzech Króli'],
    [easter, 'Wielkanoc'],
    [easter + DAY, 'Poniedziałek Wielkanocny'],
    [utc(year, 5, 1), 'Święto Pracy'],
    [utc(year, 5, 3), 'Święto Konstytucji 3 Maja'],
    [easter + 49 * DAY, 'Zielone Świątki'],
    [easter + 60 * DAY, 'Boże Ciało'],
    [utc(year, 8, 15), 'Wniebowzięcie NMP'],
    [utc(year, 11, 1), 'Wszystkich Świętych'],
    [utc(year, 11, 11), 'Święto Niepodległości'],
    ...(year >= 2025 ? [[utc(year, 12, 24), 'Wigilia']] : []),
    [utc(year, 12, 25), 'Boże Narodzenie (pierwszy dzień)'],
    [utc(year, 12, 26), 'Boże Narodzenie (drugi dzień)'],
  ];
  const map = new Map(list);
  holidayCache.set(year, map);
  return map;
}

const dayStart = (t) => Math.floor(t / DAY) * DAY;

/** Name of the Polish public holiday on that UTC calendar day, or null. */
export const polishHoliday = (t) => polishHolidays(new Date(t).getUTCFullYear()).get(dayStart(t)) ?? null;

/** Saturday or Sunday (UTC calendar day). */
export const isWeekend = (t) => [0, 6].includes(new Date(t).getUTCDay());

/** Day off in Poland: Saturday, Sunday or a public holiday. */
export const isDayOff = (t) => isWeekend(t) || polishHoliday(t) !== null;

/** Days inside the period (inclusive), optionally without days off (weekends and Polish public holidays). */
export function selectDays(days, period, { skipDaysOff = false } = {}) {
  return days.filter((d) => (!period || (d.date >= period.start && d.date <= period.end)) && !(skipDaysOff && isDayOff(d.date)));
}

/** Monday of the ISO week containing the UTC day t. */
export const weekMonday = (t) => dayStart(t) - ((new Date(t).getUTCDay() + 6) % 7) * DAY;

/**
 * Aggregates days into Monday–Friday weeks: one record per week with the sum of the delivered tasks.
 * Saturdays and Sundays are never counted; Polish public holidays are left out when skipHolidays is set.
 * Weeks without any counted day are dropped. Records are shaped like days (date = Monday) and also carry
 * weekStart, weekEnd (Friday), workdays (days summed) and holidays (names of the holidays left out).
 */
export function aggregateWeeks(days, { skipHolidays = false } = {}) {
  const weeks = new Map();
  for (const d of days) {
    if (isWeekend(d.date)) continue;
    const monday = weekMonday(d.date);
    if (!weeks.has(monday)) {
      weeks.set(monday, { ...day(0, d.rowNumber, monday, 0), weekStart: monday, weekEnd: monday + 4 * DAY, workdays: 0, holidays: [], files: new Set(), comments: [] });
    }
    const w = weeks.get(monday);
    const holiday = polishHoliday(d.date);
    if (skipHolidays && holiday) { w.holidays.push(holiday); continue; }
    w.lead += d.lead;
    w.workdays++;
    for (const f of String(d.file ?? '').split(', ').filter(Boolean)) w.files.add(f);
    if (d.comment) w.comments.push(d.comment);
  }
  return [...weeks.values()]
    .filter((w) => w.workdays > 0)
    .sort((a, b) => a.date - b.date)
    .map(({ files, comments, ...w }, i) => ({ ...w, id: i, file: [...files].join(', '), comment: comments.join('; ') || null }));
}
