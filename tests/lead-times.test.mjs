import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { readXlsx } from '../assets/js/xlsx-reader.js';
import {
  extractTasks, percentiles, percentileInc, buildPeriods, selectSample, groupOverlaps,
  mergePercentileLines, parsePolishDate, excelSerialToUtc, normalizeSize,
} from '../assets/js/lead-times.js';

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const real = async () => extractTasks(await readXlsx(await readFile(new URL('../Lead Times - 2024-25.xlsx', import.meta.url))));

test('PERCENTILE.INC matches Excel on the two example S rows', () => {
  const p = percentiles([49, 48]);
  close(p.p50, 48.5);
  close(p.p85, 48.85);
  close(p.p95, 48.95);
  assert.equal(percentileInc([7], 0.95), 7);
  assert.equal(percentileInc([], 0.5), null);
  // Excel: =PERCENTILE.INC({1,2,3,4,10},0.85) = 6.4
  close(percentileInc([10, 1, 4, 3, 2], 0.85), 6.4);
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
  assert.deepEqual(mergePercentileLines({ p50: null, p85: null, p95: null }), []);
});

test('coinciding percentile lines share one label', () => {
  const lines = mergePercentileLines({ p50: 10, p85: 20, p95: 20 });
  assert.deepEqual(lines.map((l) => [l.label, l.value]), [['P50', 10], ['P85 / P95', 20]]);
});
