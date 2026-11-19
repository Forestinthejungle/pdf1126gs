import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { readXlsx } from '../assets/js/xlsx-reader.js';
import {
  extractTasks, percentiles, percentileInc, percentileNearestRank, buildPeriods, selectSample, groupOverlaps,
  mergePercentileLines, parsePolishDate, excelSerialToUtc, normalizeSize, normalizeLevels, removeOutliers,
  combineImports, computeXmR, signalZones, westernElectric, computeVariation, ruleTasks, ruleClosest,
} from '../assets/js/lead-times.js';

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const byLevel = (list) => Object.fromEntries(list.map((p) => [p.level, p.value]));
const real = async () => extractTasks(await readXlsx(await readFile(new URL('../Lead Times - 2024-25.xlsx', import.meta.url))));

test('PERCENTILE.INC matches Excel on the two example S rows', () => {
  const p = byLevel(percentiles([49, 48]));
  close(p[50], 48.5);
  close(p[85], 48.85);
  close(p[95], 48.95);
  assert.equal(percentileInc([7], 0.95), 7);
  assert.equal(percentileInc([], 0.5), null);
  // Excel: =PERCENTILE.INC({1,2,3,4,10},0.85) = 6.4
  close(percentileInc([10, 1, 4, 3, 2], 0.85), 6.4);
});

test('nearest rank returns an observed value at rank ceil(p * n)', () => {
  assert.deepEqual(byLevel(percentiles([49, 48], 'nearest-rank')), { 50: 48, 85: 49, 95: 49 });
  assert.equal(percentileNearestRank([], 0.5), null);
  assert.equal(percentileNearestRank([7], 0.5), 7);
  // 0.85 * 20 is 17.000000000000004 in floating point; the 17th value must still be chosen.
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentileNearestRank(twenty, 0.85), 17);
  assert.equal(percentileNearestRank([10, 1, 4, 3, 2], 0.85), 10);
  assert.equal(percentileNearestRank([10, 1, 4, 3, 2], 0.5), 3);
});

test('reads the real workbook: 36 tasks, Polish text dates, no unit', async () => {
  const { tasks, skipped, unit } = await real();
  assert.equal(tasks.length, 36);
  assert.equal(skipped.length, 0);
  assert.equal(unit, null);
  assert.deepEqual([iso(tasks[0].date), tasks[0].size, tasks[0].lead], ['2024-07-15', 'S', 49]);
  assert.deepEqual([iso(tasks[1].date), tasks[1].size, tasks[1].lead], ['2024-08-22', 'S', 48]);
  assert.ok(tasks.some((t) => t.lead === 415), 'outlier kept');
});

test('parses dates and sizes in supported formats', () => {
  assert.equal(iso(parsePolishDate('15 Lipca 2024')), '2024-07-15');
  assert.equal(iso(parsePolishDate('5 października 2025 r.')), '2025-10-05');
  assert.equal(iso(parsePolishDate('5 PAZDZIERNIKA 2025')), '2025-10-05');
  assert.equal(iso(parsePolishDate('15.07.2024')), '2024-07-15');
  assert.equal(parsePolishDate('31 Lutego 2025'), null);
  assert.equal(parsePolishDate('wczoraj'), null);
  assert.equal(iso(excelSerialToUtc(45488)), '2024-07-15');
  assert.equal(iso(excelSerialToUtc(43661, true)), '2023-07-16');
  assert.equal(normalizeSize({ type: 'string', value: ' s ' }), 'S');
  assert.equal(normalizeSize({ type: 'string', value: 'Medium' }), 'M');
  assert.equal(normalizeSize({ type: 'string', value: 'XL' }), null);
});

// Builds a minimal XLSX (stored as deflate) to exercise Excel-serial dates and bad rows.
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    local.push(lh, nameBuf, data);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('handles Excel-serial dates, skips empty/invalid rows and keeps duplicates', async () => {
  const s = (r, v) => `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const n = (r, v) => `<c r="${r}"><v>${v}</v></c>`;
  const rows = [
    `<row r="1">${s('A1', 'Data ukończenia')}${s('B1', 'Deklarowany rozmiar (T-shirt)')}${s('C1', 'Czas realizacji (dni)')}</row>`,
    `<row r="2">${n('A2', 45488)}${s('B2', 'S')}${n('C2', 49)}</row>`,
    `<row r="3">${s('A3', '22 Sierpnia 2024')}${s('B3', 'm')}${n('C3', 48)}</row>`,
    `<row r="4">${n('A4', 45488)}${s('B4', 'S')}${n('C4', 49)}</row>`,
    // row 5 missing entirely (blank row)
    `<row r="6">${s('A6', 'brak')}${s('B6', 'S')}${n('C6', 10)}</row>`,
    `<row r="7">${n('A7', 45500)}${s('B7', 'XL')}${n('C7', 10)}</row>`,
    `<row r="8">${n('A8', 45500)}${s('B8', 'L')}${s('C8', 'abc')}</row>`,
    `<row r="9">${n('A9', 45500.5)}${s('B9', 'L')}${n('C9', 300)}</row>`,
    `<row r="20"></row>`,
  ].join('');
  const file = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Dane" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
  });
  const { tasks, skipped, unit } = extractTasks(await readXlsx(file));
  assert.equal(unit, 'dni');
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => [iso(t.date), t.size, t.lead]), [
    ['2024-07-15', 'S', 49], ['2024-08-22', 'M', 48], ['2024-07-15', 'S', 49], ['2024-07-27', 'L', 300],
  ]);
  assert.deepEqual(skipped.map((x) => x.rowNumber), [5, 6, 7, 8]);
  const groups = groupOverlaps(tasks);
  assert.equal(groups.find((g) => g.lead === 49).tasks.length, 2);
});

test('periods: 3-month steps from the global latest date, only shorter than full range', async () => {
  const { tasks } = await real();
  const periods = buildPeriods(tasks);
  assert.deepEqual(periods.map((p) => p.months), [3, 6, 9, 12, 15, null]);
  const whole = periods.at(-1);
  assert.deepEqual([iso(whole.start), iso(whole.end)], ['2024-07-15', '2025-12-10']);
  assert.equal(selectSample(tasks, 'ALL', whole).length, 36);

  const last3 = periods[0];
  assert.deepEqual([iso(last3.start), iso(last3.end)], ['2025-09-11', '2025-12-10']);
  const sample = selectSample(tasks, 'ALL', last3);
  assert.ok(sample.every((t) => t.date >= last3.start && t.date <= last3.end));
  assert.equal(sample.length, tasks.filter((t) => iso(t.date) >= '2025-09-11').length);
});

test('size filter limits points and percentiles but not period bounds', async () => {
  const { tasks } = await real();
  const before = buildPeriods(tasks);
  const sOnly = selectSample(tasks, 'S', before.at(-1));
  assert.ok(sOnly.length > 0 && sOnly.every((t) => t.size === 'S'));
  // Periods derive from the full data set, so they are identical whichever size is chosen.
  assert.deepEqual(buildPeriods(tasks), before);
  const all = selectSample(tasks, 'ALL', before.at(-1));
  assert.notDeepEqual(percentiles(sOnly.map((t) => t.lead)), percentiles(all.map((t) => t.lead)));
});

test('empty sample yields no percentiles and no lines', async () => {
  const { tasks } = await real();
  const period = { start: Date.UTC(2030, 0, 1), end: Date.UTC(2030, 1, 1) };
  const sample = selectSample(tasks, 'L', period);
  assert.equal(sample.length, 0);
  assert.equal(percentileInc(sample.map((t) => t.lead), 0.85), null);
  assert.deepEqual(mergePercentileLines(percentiles([])), []);
});

test('coinciding percentile lines share one label', () => {
  const lines = mergePercentileLines([
    { level: 50, label: 'P50', value: 10 }, { level: 85, label: 'P85', value: 20 }, { level: 95, label: 'P95', value: 20 },
  ]);
  assert.deepEqual(lines.map((l) => [l.label, l.value, l.highlight]), [['P50', 10, false], ['P85 / P95', 20, true]]);
});

test('custom percentile levels: parsed from user input, sorted, deduplicated, out-of-range dropped', () => {
  assert.deepEqual(normalizeLevels(['95', ' 50 ', '99,5', 85, '85', '', '0', '101', 'abc', null]), [50, 85, 95, 99.5]);
  const p = percentiles([1, 2, 3, 4, 10], 'inc', [25, 99.5]);
  assert.deepEqual(p.map((x) => x.label), ['P25', 'P99,5']);
  close(p[0].value, 2);
  close(p[1].value, 9.88);
  assert.deepEqual(percentiles([1, 2, 3], 'inc', []), []);
});

test('outlier removal uses Tukey fences on the given sample', async () => {
  const tasks = [10, 12, 11, 13, 12, 11, 100].map((lead, id) => ({ id, lead }));
  const { kept, removed, fences } = removeOutliers(tasks);
  assert.deepEqual(removed.map((t) => t.lead), [100]);
  assert.equal(kept.length, 6);
  assert.ok(fences.high < 100 && fences.low < 10);
  // Too few points: nothing is removed.
  assert.equal(removeOutliers(tasks.slice(0, 3)).removed.length, 0);
  // Real workbook: the 415-day task is an outlier for the whole period.
  const all = await real();
  assert.ok(removeOutliers(all.tasks).removed.some((t) => t.lead === 415));
});

test('combining imports tags files, renumbers ids and reports units', () => {
  const a = { name: 'a.xlsx', unit: 'dni', tasks: [{ id: 0, lead: 1 }, { id: 1, lead: 2 }] };
  const b = { name: 'b.xlsx', unit: null, tasks: [{ id: 0, lead: 3 }] };
  const c = { name: 'c.xlsx', unit: 'tygodnie', tasks: [{ id: 0, lead: 4 }] };
  const ab = combineImports([a, b]);
  assert.deepEqual(ab.tasks.map((t) => [t.id, t.file]), [[0, 'a.xlsx'], [1, 'a.xlsx'], [2, 'b.xlsx']]);
  assert.equal(ab.unit, 'dni');
  assert.equal(ab.mixedUnits, false);
  const ac = combineImports([a, c]);
  assert.equal(ac.unit, null);
  assert.equal(ac.mixedUnits, true);
  assert.deepEqual(combineImports([]).tasks, []);
});

const day = (d) => Date.UTC(2025, 0, d);
const series = (leads, size = 'S') => leads.map((lead, i) => ({ id: i, date: day(i + 1), size, lead }));
const pl2 = (v) => new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

test('XmR: 8, 10, 9, 13 days – moving ranges, centre lines and limits', () => {
  const x = computeXmR(series([8, 10, 9, 13]));
  assert.deepEqual(x.points.map((p) => [p.index, p.value]), [[1, 8], [2, 10], [3, 9], [4, 13]]);
  assert.deepEqual(x.ranges.map((r) => [r.index, r.value]), [[2, 2], [3, 1], [4, 4]]);
  assert.deepEqual(
    [x.xMean, x.limits.x.lower, x.limits.x.upper, x.mrMean, x.limits.mr.lower, x.limits.mr.upper].map(pl2),
    ['10,00', '3,79', '16,21', '2,33', '0,00', '7,62'],
  );
  assert.equal(x.xSignals.length + x.mrSignals.length, 0);
});

test('XmR: nine 10-day tasks and one 30-day task signal on both charts', () => {
  const x = computeXmR(series([...Array(9).fill(10), 30]));
  // Equal consecutive times give MR = 0, which counts in the mean: 20 / 9.
  close(x.mrMean, 20 / 9);
  assert.deepEqual(x.xSignals.map((p) => [p.index, p.signal]), [[10, 'high']]);
  assert.deepEqual(x.mrSignals.map((r) => [r.index, r.value]), [[10, 20]]);
});

test('XmR: a point exactly on a limit is not a signal; zero lead times are kept', () => {
  const flat = computeXmR(series([5, 5, 5]));
  assert.equal(flat.limits.x.upper, 5);
  assert.equal(flat.limits.mr.upper, 0);
  assert.equal(flat.xSignals.length + flat.mrSignals.length, 0);
  const zeros = computeXmR(series([0, 0, 3]));
  assert.equal(zeros.n, 3);
  close(zeros.xMean, 1);
  assert.ok(zeros.limits.x.lower < 0, 'negative lower limit kept as computed');
});

test('XmR: empty and single-task series have no limits', () => {
  const none = computeXmR([]);
  assert.deepEqual([none.n, none.ranges.length, none.limits, none.xMean], [0, 0, null, null]);
  const one = computeXmR(series([7]));
  assert.deepEqual([one.n, one.points[0].value, one.ranges.length, one.limits], [1, 7, 0, null]);
});

test('XmR: ordered by completion date and time, ties keep import order', () => {
  const tasks = [
    { id: 0, date: day(3), size: 'S', lead: 30 },
    { id: 1, date: day(1), size: 'M', lead: 10 },
    { id: 2, date: day(2), size: 'L', lead: 21, completedAt: day(2) + 15 * 3600e3, hasTime: true },
    { id: 3, date: day(2), size: 'S', lead: 20, completedAt: day(2) + 9 * 3600e3, hasTime: true },
    { id: 4, date: day(1), size: 'L', lead: 11 },
  ];
  const x = computeXmR(tasks);
  assert.deepEqual(x.points.map((p) => p.task.id), [1, 4, 3, 2, 0]);
  assert.deepEqual(x.ranges.map((r) => [r.from.id, r.to.id, r.value]), [[1, 4, 1], [4, 3, 9], [3, 2, 1], [2, 0, 9]]);
  // The same tasks imported in reverse order give the same series, except for same-day ties.
  const reversed = computeXmR([...tasks].reverse());
  assert.deepEqual(reversed.points.map((p) => p.task.id), [4, 1, 3, 2, 0]);
  close(reversed.xMean, x.xMean);
});

test('XmR: size filter recomputes pairs, means and limits from that size only', async () => {
  const { tasks } = await real();
  const all = computeXmR(selectSample(tasks, 'ALL', null));
  for (const size of ['S', 'M', 'L']) {
    const sample = selectSample(tasks, size, null);
    const x = computeXmR(sample);
    assert.equal(x.n, sample.length);
    assert.ok(x.points.every((p) => p.task.size === size));
    assert.ok(x.ranges.every((r) => r.from.size === size && r.to.size === size));
    close(x.xMean, sample.reduce((s, t) => s + t.lead, 0) / sample.length);
    assert.notEqual(x.limits.x.upper, all.limits.x.upper);
  }
  assert.equal(all.n, 36);
  assert.ok(all.xSignals.some((p) => p.value === 415), 'the 415-day task is a signal');
});

test('XmR through the importer: unsorted dates, same-day tasks, time of day, task IDs', async () => {
  const s = (r, v) => `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const n = (r, v) => `<c r="${r}"><v>${v}</v></c>`;
  const row = (r, id, date, size, lead) => `<row r="${r}">${s(`A${r}`, id)}${date}${s(`C${r}`, size)}${lead}</row>`;
  const rows = [
    `<row r="1">${s('A1', 'ID zadania')}${s('B1', 'Data ukończenia')}${s('C1', 'Deklarowany rozmiar (T-shirt)')}${s('D1', 'Czas realizacji')}</row>`,
    row(2, 'T-4', s('B2', '4 Stycznia 2025'), 'S', n('D2', 13)),
    row(3, 'T-3', n('B3', 45660.75), 'M', n('D3', 9)), // 2025-01-03 18:00
    row(4, 'T-2', n('B4', 45660.25), 'S', n('D4', 10)), // 2025-01-03 06:00
    row(5, 'T-1', s('B5', '2025-01-02'), 'L', n('D5', 8)),
    row(6, 'T-x', s('B6', 'brak daty'), 'S', n('D6', 5)),
    row(7, 'T-y', s('B7', '5 Stycznia 2025'), 'S', n('D7', -3)),
    row(8, 'T-z', s('B8', '5 Stycznia 2025'), 'S', s('D8', 'abc')),
    row(9, 'T-0', s('B9', '6 Stycznia 2025'), 'S', n('D9', 0)),
  ].join('');
  const file = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Dane" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
  });
  const { tasks, skipped } = extractTasks(await readXlsx(file));
  assert.deepEqual(skipped.map((x) => x.rowNumber), [6, 7, 8]);
  const x = computeXmR(tasks);
  assert.deepEqual(x.points.map((p) => p.task.taskId), ['T-1', 'T-2', 'T-3', 'T-4', 'T-0']);
  assert.deepEqual(x.points.map((p) => p.value), [8, 10, 9, 13, 0]);
  assert.deepEqual(x.ranges.map((r) => r.value), [2, 1, 4, 13]);
  assert.equal(x.points[1].task.hasTime, true);
  assert.equal(new Date(x.points[2].task.completedAt).toISOString(), '2025-01-03T18:00:00.000Z');
});

// Western Electric rules on fixed reference parameters: mean 20, σ step 4 → ±1σ 16/24, ±2σ 12/28, ±3σ 8/32.
const zones = signalZones({ center: 20, upper: 32, lower: 8 });
const rule = (values, id) => westernElectric(values, zones).rules[id - 1];
const sides = (values, id) => rule(values, id).events.map((e) => [e.side, e.start, e.end]);

test('signal zones: σ step = (upper − mean) / 3, ±3σ are exactly the X-chart limits', () => {
  assert.deepEqual([zones.sigma, zones.low, zones.high], [4, [20, 16, 12, 8], [20, 24, 28, 32]]);
  // With the 2.66 factor the ±3σ lines stay the computed limits, not mean ± 3·σ recomputed.
  const x = computeXmR(series([8, 10, 9, 13]));
  const z = computeVariation(x).zones;
  assert.equal(z.upper, x.limits.x.upper);
  assert.equal(z.lower, x.limits.x.lower);
  close(z.high[2], x.xMean + (2 / 3) * (x.limits.x.upper - x.xMean));
  assert.equal(signalZones(null), null);
  assert.equal(signalZones({ center: 5, upper: 5, lower: 5 }), null, 'limits on the mean');
});

test('rule 1: strictly beyond ±3σ', () => {
  assert.deepEqual(sides([33], 1), [['high', 1, 1]]);
  assert.deepEqual(sides([7], 1), [['low', 1, 1]]);
  assert.deepEqual(sides([32], 1), []);
  assert.deepEqual(sides([8], 1), []);
});

test('rule 2: two of three strictly beyond 2σ on the same side', () => {
  assert.deepEqual(sides([29, 20, 30], 2), [['high', 1, 3]]);
  assert.deepEqual(rule([33, 20, 29], 2).events[0].matched, [1, 3], 'a point beyond 3σ also counts');
  assert.deepEqual(sides([29, 20, 11], 2), [], 'opposite sides are counted separately');
  assert.deepEqual(sides([28, 20, 30], 2), [], 'a point exactly on 2σ does not count');
  assert.deepEqual(sides([11, 20, 10], 2), [['low', 1, 3]]);
  // Full windows slide by one task; overlapping windows are separate events.
  assert.deepEqual(sides([20, 29, 30, 20], 2), [['high', 1, 3], ['high', 2, 4]]);
});

test('rule 3: four of five strictly beyond 1σ on the same side', () => {
  assert.deepEqual(sides([25, 26, 20, 27, 28], 3), [['high', 1, 5]]);
  assert.deepEqual(sides([15, 14, 20, 13, 12], 3), [['low', 1, 5]]);
  assert.deepEqual(sides([25, 26, 20, 27, 24], 3), [], 'only three strictly above +1σ');
  assert.deepEqual(rule([25, 33, 20, 29, 28], 3).events[0].matched, [1, 2, 4, 5], 'points in further zones count');
});

test('rule 4: eight in a row strictly on one side of the mean', () => {
  const run = [21, 22, 21, 23, 21, 22, 21, 23];
  assert.deepEqual(rule(run, 4).events.map((e) => [e.side, e.start, e.end, e.detectedAt]), [['high', 1, 8, 8]]);
  const broken = [...run];
  broken[3] = 20;
  assert.deepEqual(rule(broken, 4).events, [], 'a point equal to the mean breaks the run');
  assert.deepEqual(rule(run.slice(0, 7), 4).events, []);
  // A longer run is one event; detection stays at its eighth point.
  const long = [19, 19, 18, 19, 17, 19, 18, 19, 19, 18, 25];
  assert.deepEqual(rule(long, 4).events.map((e) => [e.side, e.start, e.end, e.detectedAt]), [['low', 1, 10, 8]]);
});

test('rule tasks: points beyond the line in matching windows, every point of a run', () => {
  // Overlapping windows 1–3 and 2–4: the in-window point 4 (20) is not beyond +2σ, so it is not listed.
  assert.deepEqual(ruleTasks(rule([20, 29, 30, 20], 2)).map((t) => [t.index, t.side, t.events.length]), [[2, 'high', 2], [3, 'high', 2]]);
  const long = [19, 19, 18, 19, 17, 19, 18, 19, 19, 18, 25];
  assert.deepEqual(ruleTasks(rule(long, 4)).map((t) => t.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(ruleTasks(rule([21, 19], 1)), []);
});

test('rule closest: longest run and best window when a rule does not occur', () => {
  const wr = (id) => westernElectric([], zones).rules[id - 1];
  assert.deepEqual(ruleClosest([21, 19, 18, 20, 17, 16, 22], zones, wr(4)), { count: 2, start: 2, end: 3, side: 'low' });
  assert.deepEqual(ruleClosest([20, 29, 20, 20, 11], zones, wr(2)), { count: 1, start: 1, end: 3, side: 'high' });
  assert.equal(ruleClosest([20, 21, 19], zones, wr(3)), null);
  assert.equal(ruleClosest([20, 20], zones, wr(4)), null, 'points on the mean form no run');
});

test('rule status: no basis for zones and too few tasks', () => {
  const short = westernElectric([21, 22, 21, 23, 21, 22, 21], zones).rules.map((r) => r.status);
  assert.deepEqual(short, ['ok', 'ok', 'ok', 'too-short']);
  assert.deepEqual(westernElectric([25, 26], zones).rules.map((r) => r.status), ['ok', 'too-short', 'too-short', 'too-short']);
  assert.deepEqual(computeVariation(computeXmR(series([5, 5, 5]))).rules.map((r) => r.status), Array(4).fill('no-limits'));
  assert.deepEqual(computeVariation(computeXmR(series([7]))).rules.map((r) => r.status), Array(4).fill('no-limits'));
});

test('variation uses the X-chart series, order and limits after filtering', async () => {
  const { tasks } = await real();
  for (const size of ['ALL', 'S', 'M', 'L']) {
    const x = computeXmR(selectSample(tasks, size, null));
    const v = computeVariation(x);
    assert.equal(v.zones.center, x.limits.x.center);
    assert.equal(v.zones.upper, x.limits.x.upper);
    assert.equal(v.zones.lower, x.limits.x.lower);
    const r1 = v.rules[0].events.map((e) => e.start);
    assert.deepEqual(r1, x.xSignals.map((p) => p.index), `rule 1 equals X-chart signals (${size})`);
  }
});

test('import: optional context-change and comment columns', async () => {
  const s = (r, v) => `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const rows = [
    `<row r="1">${s('A1', 'Data ukończenia')}${s('B1', 'Rozmiar')}${s('C1', 'Czas realizacji')}${s('D1', 'Zmiana kontekstu')}${s('E1', 'Komentarz')}</row>`,
    `<row r="2">${s('A2', '2025-01-02')}${s('B2', 'S')}<c r="C2"><v>5</v></c>${s('D2', 'tak')}${s('E2', 'Nowy zespół')}</row>`,
    `<row r="3">${s('A3', '2025-01-03')}${s('B3', 'M')}<c r="C3"><v>7</v></c>${s('D3', 'nie')}</row>`,
  ].join('');
  const file = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Dane" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
  });
  const { tasks } = extractTasks(await readXlsx(file));
  assert.deepEqual(tasks.map((t) => [t.lead, t.contextChange, t.comment]), [[5, 'tak', 'Nowy zespół'], [7, null, null]]);
});
