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

/**
 * Time of day (ms since midnight) when the cell carries one: a fractional Excel serial or an ISO
 * date-time such as "2024-07-15 10:30". Returns null for plain dates.
 */
export function parseTimeOfDay(cell) {
  if (!cell) return null;
  if (cell.type === 'number') {
    if (!Number.isFinite(cell.value)) return null;
    const ms = Math.round((cell.value - Math.floor(cell.value)) * 86400) * 1000;
    return ms > 0 && ms < DAY ? ms : null;
  }
  if (cell.type !== 'string' && cell.type !== 'date') return null;
  const m = /^\d{4}-\d{1,2}-\d{1,2}[t ](\d{1,2}):(\d{2})(?::(\d{2}))?/i.exec(String(cell.value).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
  const ms = ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000;
  return ms > 0 ? ms : null;
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

function cellLabel(cell) {
  if (!cell) return null;
  const s = cell.type === 'string' ? cell.value.trim() : cell.type === 'number' ? String(cell.value) : '';
  return s || null;
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
    const cols = { date: -1, size: -1, lead: -1, id: -1, context: -1, comment: -1 };
    rows[i].cells.forEach((cell, idx) => {
      const t = cellText(cell);
      if (!t) return;
      // Optional annotations shown next to a task, e.g. "Zmiana kontekstu", "Komentarz", "Uwagi".
      if (cols.context < 0 && /kontekst|context/.test(t)) cols.context = idx;
      else if (cols.comment < 0 && /komentarz|comment|uwag/.test(t)) cols.comment = idx;
      else if (cols.date < 0 && /data|date|ukoncz/.test(t)) cols.date = idx;
      else if (cols.size < 0 && /rozmiar|t-?shirt|size/.test(t)) cols.size = idx;
      else if (cols.lead < 0 && /czas|lead|cycle/.test(t)) cols.lead = idx;
      // Optional task identifier column, e.g. "ID", "ID zadania", "Klucz", "Nr zadania".
      else if (cols.id < 0 && /^(id|key|klucz|nr|numer|identyfikator)\b|\bid\b/.test(t)) cols.id = idx;
    });
    if (cols.date >= 0 && cols.size >= 0 && cols.lead >= 0) {
      return { ...cols, headerIndex: i, leadHeader: rows[i].cells[cols.lead].value };
    }
  }
  return { date: 0, size: 1, lead: 2, id: -1, context: -1, comment: -1, headerIndex: -1, leadHeader: null };
}

/** Context-change flag: yes/true/1 become "tak", no/false/0/empty are dropped, other text is kept as written. */
function contextLabel(cell) {
  if (!cell) return null;
  if (cell.type === 'bool') return cell.value ? 'tak' : null;
  if (cell.type === 'number') return cell.value ? 'tak' : null;
  const s = cellLabel(cell);
  if (!s) return null;
  const f = fold(s);
  if (/^(nie|no|n|false|falsz|brak|-|0)$/.test(f)) return null;
  if (/^(tak|yes|y|true|prawda|x|1)$/.test(f)) return 'tak';
  return s;
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
    const time = parseTimeOfDay(row.cells[cols.date]);
    tasks.push({
      id: tasks.length,
      rowNumber: row.rowNumber,
      date,
      size,
      lead,
      completedAt: date + (time ?? 0),
      hasTime: time !== null,
      taskId: cols.id >= 0 ? cellLabel(row.cells[cols.id]) : null,
      contextChange: cols.context >= 0 ? contextLabel(row.cells[cols.context]) : null,
      comment: cols.comment >= 0 ? cellLabel(row.cells[cols.comment]) : null,
    });
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

/** Nearest-rank method: the smallest observed value with at least p of the sample at or below it. */
export function percentileNearestRank(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Round off floating-point noise (e.g. 0.85 * 20 = 17.000000000000004) before taking the ceiling.
  const rank = Math.max(1, Math.ceil(Math.round(p * sorted.length * 1e9) / 1e9));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export const PERCENTILE_METHODS = { inc: percentileInc, 'nearest-rank': percentileNearestRank };

export const DEFAULT_LEVELS = [50, 85, 95];
/** Level emphasised in the stats and on the chart (when the user keeps it in the list). */
export const KEY_LEVEL = 85;

/** Turns user input (numbers or strings such as "99,5") into sorted, unique levels in (0, 100]. */
export function normalizeLevels(levels) {
  const out = [];
  for (const raw of levels) {
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const v = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > 100) continue;
    const rounded = Math.round(v * 100) / 100;
    if (!out.includes(rounded)) out.push(rounded);
  }
  return out.sort((a, b) => a - b);
}

export function percentileLabel(level) {
  return `P${String(level).replace('.', ',')}`;
}

/** Returns one entry per level: { level, label, value } (value is null for an empty sample). */
export function percentiles(values, method = 'inc', levels = DEFAULT_LEVELS) {
  const fn = PERCENTILE_METHODS[method];
  if (!fn) throw new Error(`Unknown percentile method: ${method}`);
  return levels.map((level) => ({ level, label: percentileLabel(level), value: fn(values, level / 100) }));
}

/**
 * Tukey fences: drops tasks whose lead time lies outside [Q1 - k*IQR, Q3 + k*IQR] of the given sample.
 * Quartiles always use linear interpolation, so both percentile tabs drop exactly the same tasks.
 */
export function removeOutliers(tasks, k = 1.5) {
  if (tasks.length < 4) return { kept: tasks, removed: [], fences: null };
  const leads = tasks.map((t) => t.lead);
  const q1 = percentileInc(leads, 0.25);
  const q3 = percentileInc(leads, 0.75);
  const low = q1 - k * (q3 - q1);
  const high = q3 + k * (q3 - q1);
  const kept = [];
  const removed = [];
  for (const t of tasks) (t.lead < low || t.lead > high ? removed : kept).push(t);
  return { kept, removed, fences: { low, high } };
}

/** Stable task identity across file re-selection: source file + sheet row. */
export function taskKey(task) {
  return `${task.file ?? ''}|${task.rowNumber}`;
}

/** Splits tasks into those kept and those excluded by hand (by taskKey). */
export function splitExcluded(tasks, excludedKeys) {
  const kept = [];
  const excluded = [];
  for (const t of tasks) (excludedKeys.has(taskKey(t)) ? excluded : kept).push(t);
  return { kept, excluded };
}

/** Merges tasks from several imported files, tagging each task with its file and giving it a unique id. */
export function combineImports(imports) {
  const tasks = [];
  for (const imp of imports) for (const t of imp.tasks) tasks.push({ ...t, id: tasks.length, file: imp.name });
  const units = [...new Set(imports.map((i) => i.unit).filter(Boolean))];
  return { tasks, unit: units.length === 1 ? units[0] : null, mixedUnits: units.length > 1 };
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
 * Builds quick-pick periods (3, 6, 9 … months) anchored at the latest completion date of the whole
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

/** Collapses percentile lines that share the same value into one labelled line, e.g. "P85 / P95". */
export function mergePercentileLines(list, keyLevel = KEY_LEVEL) {
  const lines = [];
  for (const p of list) {
    if (p.value === null || p.value === undefined) continue;
    const same = lines.find((l) => Math.abs(l.value - p.value) < 1e-9);
    if (same) same.items.push(p);
    else lines.push({ items: [p], value: p.value });
  }
  return lines.map((l) => ({
    value: l.value,
    levels: l.items.map((p) => p.level),
    label: l.items.map((p) => p.label).join(' / '),
    highlight: l.items.some((p) => p.level === keyLevel),
  }));
}

/** Shewhart XmR scaling factors: natural process limits (E2) and the upper range limit (D4) for n = 2. */
export const XMR_X_FACTOR = 2.66;
export const XMR_MR_FACTOR = 3.267;

/** Completion timestamp used for ordering: the time of day when the import provides it, otherwise the date. */
export const completionTime = (task) => task.completedAt ?? task.date;

/** Sorts tasks by completion date/time; ties keep their import order (stable). */
export function orderByCompletion(tasks) {
  return tasks
    .map((task, order) => ({ task, order }))
    .sort((a, b) => completionTime(a.task) - completionTime(b.task) || a.order - b.order)
    .map((e) => e.task);
}

/**
 * XmR (individuals and moving range) chart for one filtered series. Points are numbered 1…n in completion
 * order; moving range i belongs to the second task of the pair (i = 2…n). Limits need at least two tasks.
 * Signals are points strictly outside the limits (a point exactly on a limit is not a signal).
 */
export function computeXmR(tasks) {
  const series = orderByCompletion(tasks);
  const n = series.length;
  const points = series.map((task, i) => ({ index: i + 1, task, value: task.lead, signal: null }));
  const ranges = [];
  for (let i = 1; i < n; i++) {
    ranges.push({ index: i + 1, from: series[i - 1], to: series[i], value: Math.abs(series[i].lead - series[i - 1].lead), signal: null });
  }
  const mean = (list) => list.reduce((s, v) => s + v.value, 0) / list.length;
  const xMean = n ? mean(points) : null;
  const mrMean = ranges.length ? mean(ranges) : null;
  const limits = mrMean === null ? null : {
    x: { center: xMean, upper: xMean + XMR_X_FACTOR * mrMean, lower: xMean - XMR_X_FACTOR * mrMean },
    mr: { center: mrMean, upper: XMR_MR_FACTOR * mrMean, lower: 0 },
  };
  if (limits) {
    for (const p of points) p.signal = p.value > limits.x.upper ? 'high' : p.value < limits.x.lower ? 'low' : null;
    for (const r of ranges) r.signal = r.value > limits.mr.upper ? 'high' : null;
  }
  return {
    n,
    points,
    ranges,
    xMean,
    mrMean,
    limits,
    xSignals: points.filter((p) => p.signal),
    mrSignals: ranges.filter((r) => r.signal),
  };
}

/**
 * Western Electric zones from the X-chart limits (raw, unrounded values). The σ step is (upper − centre) / 3,
 * so ±3σ are exactly the X-chart limits. Returns null when the limits are missing or coincide with the mean.
 * thresholds.high[k] / thresholds.low[k] are the +kσ / −kσ lines for k = 1, 2, 3.
 */
export function signalZones(xLimits) {
  if (!xLimits) return null;
  const { center, upper, lower } = xLimits;
  const sigma = (upper - center) / 3;
  if (![center, upper, lower, sigma].every(Number.isFinite) || !(sigma > 0)) return null;
  return {
    center,
    sigma,
    upper,
    lower,
    high: [center, center + sigma, center + 2 * sigma, upper],
    low: [center, center - sigma, center - 2 * sigma, lower],
  };
}

/** The four classic Western Electric rules, in the order shown on the dashboard. */
export const WE_RULES = [
  { id: 1, kind: 'window', window: 1, need: 1, zone: 3, minTasks: 1 },
  { id: 2, kind: 'window', window: 3, need: 2, zone: 2, minTasks: 3 },
  { id: 3, kind: 'window', window: 5, need: 4, zone: 1, minTasks: 5 },
  { id: 4, kind: 'run', length: 8, minTasks: 8 },
];

/**
 * Sliding full windows (step 1) over values; a window matches on a side when at least `need` points are
 * strictly beyond the ±zone·σ line on that side (both sides counted separately).
 * Events use 1-based task numbers: { side, start, end, detectedAt, matched }.
 */
export function detectWindowRule(values, zones, { window, need, zone }) {
  const events = [];
  if (!zones) return events;
  for (let s = 0; s + window <= values.length; s++) {
    const high = [];
    const low = [];
    for (let i = s; i < s + window; i++) {
      if (values[i] > zones.high[zone]) high.push(i + 1);
      else if (values[i] < zones.low[zone]) low.push(i + 1);
    }
    for (const [side, matched] of [['high', high], ['low', low]]) {
      if (matched.length >= need) events.push({ side, start: s + 1, end: s + window, detectedAt: s + window, matched });
    }
  }
  return events;
}

/**
 * Unbroken runs of at least `length` points strictly on one side of the mean; a point equal to the mean
 * breaks the run. Each run is one event; detectedAt is the `length`-th point of the run.
 */
export function detectRunRule(values, zones, length = 8) {
  const events = [];
  if (!zones) return events;
  let start = 0;
  let side = null;
  const close = (end) => {
    if (side && end - start >= length) {
      const matched = Array.from({ length: end - start }, (_, k) => start + k + 1);
      events.push({ side, start: start + 1, end, detectedAt: start + length, matched });
    }
  };
  values.forEach((v, i) => {
    const s = v > zones.center ? 'high' : v < zones.center ? 'low' : null;
    if (s !== side) { close(i); start = i; side = s; }
  });
  close(values.length);
  return events;
}

/**
 * Applies each Western Electric rule independently to one series (values in X-chart order).
 * status: 'ok' | 'no-limits' (no basis for zones) | 'too-short' (fewer tasks than the rule needs).
 */
export function westernElectric(values, zones) {
  return {
    zones,
    rules: WE_RULES.map((rule) => {
      const status = !zones ? 'no-limits' : values.length < rule.minTasks ? 'too-short' : 'ok';
      const events = status !== 'ok' ? []
        : rule.kind === 'run' ? detectRunRule(values, zones, rule.length) : detectWindowRule(values, zones, rule);
      return { ...rule, status, events };
    }),
  };
}

/**
 * Tasks that satisfy a rule (1-based, ascending): for window rules the points strictly beyond the rule's
 * line inside a matching window, for the run rule every point of a run. Each: { index, side, events }.
 */
export function ruleTasks(rule) {
  const map = new Map();
  for (const ev of rule?.events || []) {
    const ids = rule.kind === 'run' ? Array.from({ length: ev.end - ev.start + 1 }, (_, k) => ev.start + k) : ev.matched;
    for (const i of ids) {
      if (!map.has(i)) map.set(i, { index: i, side: ev.side, events: [] });
      map.get(i).events.push(ev);
    }
  }
  return [...map.values()].sort((a, b) => a.index - b.index);
}

/**
 * How close the series came to a window/run rule: the window with the most points beyond the rule's line
 * on one side ({ count, start, end, side }), or the longest run on one side of the mean. Null if nothing.
 */
export function ruleClosest(values, zones, rule) {
  if (!zones || !values.length) return null;
  let best = null;
  if (rule.kind === 'run') {
    let start = 0;
    let side = null;
    values.forEach((v, i) => {
      const s = v > zones.center ? 'high' : v < zones.center ? 'low' : null;
      if (s !== side) { start = i; side = s; }
      if (side && (!best || i - start + 1 > best.count)) best = { count: i - start + 1, start: start + 1, end: i + 1, side };
    });
    return best;
  }
  const w = Math.min(rule.window, values.length);
  for (let s = 0; s + w <= values.length; s++) {
    for (const side of ['high', 'low']) {
      let count = 0;
      for (let i = s; i < s + w; i++) {
        if (side === 'high' ? values[i] > zones.high[rule.zone] : values[i] < zones.low[rule.zone]) count++;
      }
      if (count && (!best || count > best.count)) best = { count, start: s + 1, end: s + w, side };
    }
  }
  return best;
}

/** Western Electric analysis on the X-chart series and limits of a computeXmR result. */
export function computeVariation(xmr) {
  return westernElectric(xmr.points.map((p) => p.value), signalZones(xmr.limits?.x));
}
