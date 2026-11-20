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

/** Saturday or Sunday (UTC calendar day). */
export const isWeekend = (t) => [0, 6].includes(new Date(t).getUTCDay());

/** Days inside the period (inclusive), optionally without Saturdays and Sundays. */
export function selectDays(days, period, { skipWeekends = false } = {}) {
  return days.filter((d) => (!period || (d.date >= period.start && d.date <= period.end)) && !(skipWeekends && isWeekend(d.date)));
}
