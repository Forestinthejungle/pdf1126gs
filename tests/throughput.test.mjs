import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readXlsx } from '../assets/js/xlsx-reader.js';
import { computeXmR, computeVariation } from '../assets/js/lead-times.js';
import { isThroughputSheet, extractThroughput, combineThroughput, selectDays } from '../assets/js/throughput.js';

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const load = async (name) => readXlsx(await readFile(new URL(`../${name}`, import.meta.url)));
const sheet = (rows) => ({ date1904: false, rows: rows.map((cells, i) => ({ rowNumber: i + 1, cells })) });
const str = (value) => ({ type: 'string', value });
const num = (value) => ({ type: 'number', value });

test('throughput workbook is detected and the lead-time workbook is not', async () => {
  assert.equal(isThroughputSheet(await load('Throughput Daily.xlsx')), true);
  assert.equal(isThroughputSheet(await load('Lead Times - 2024-25.xlsx')), false);
});

test('reads the real throughput workbook: 103 consecutive days and its XmR limits', async () => {
  const { days, skipped } = extractThroughput(await load('Throughput Daily.xlsx'));
  assert.equal(days.length, 103);
  assert.equal(skipped.length, 0);
  assert.equal(iso(days[0].date), '2025-01-07');
  assert.equal(iso(days.at(-1).date), '2025-04-19');
  assert.equal(days.reduce((s, d) => s + d.lead, 0), 203);
  const xmr = computeXmR(combineThroughput([{ name: 'a', days }]));
  close(xmr.xMean, 203 / 103);
  close(xmr.limits.x.upper, xmr.xMean + 2.66 * xmr.mrMean);
  assert.equal(xmr.xSignals.length, 6);
  assert.equal(xmr.mrSignals.length, 7);
  assert.deepEqual(computeVariation(xmr).rules.map((r) => r.events.length), [6, 0, 0, 1]);
});

test('throughput rows: invalid, negative and repeated dates are skipped; days are sorted', () => {
  const { days, skipped } = extractThroughput(sheet([
    [str('Data'), str('Przepustowość')],
    [num(45666), num(3)],
    [num(45665), str('2')],
    [str('brak'), num(1)],
    [num(45667), num(-1)],
    [num(45666), num(9)],
  ]));
  assert.deepEqual(days.map((d) => [iso(d.date), d.lead]), [['2025-01-08', 2], ['2025-01-09', 3]]);
  assert.deepEqual(skipped.map((s) => [s.rowNumber, s.reason]), [
    [4, 'błędne pole: data'], [5, 'błędne pole: przepustowość'], [6, 'powtórzona data'],
  ]);
});

test('combining throughput files sums the same date; weekends can be skipped', () => {
  const day = (t, lead) => ({ date: Date.parse(`${t}T00:00:00Z`), lead });
  const combined = combineThroughput([
    { name: 'A', days: [day('2025-01-10', 2), day('2025-01-11', 0)] },
    { name: 'B', days: [day('2025-01-10', 3), day('2025-01-13', 4)] },
  ]);
  assert.deepEqual(combined.map((d) => [iso(d.date), d.lead, d.file, d.id]), [
    ['2025-01-10', 5, 'A, B', 0], ['2025-01-11', 0, 'A', 1], ['2025-01-13', 4, 'B', 2],
  ]);
  assert.deepEqual(selectDays(combined, null, { skipWeekends: true }).map((d) => iso(d.date)), ['2025-01-10', '2025-01-13']);
  const period = { start: combined[1].date, end: combined[2].date };
  assert.deepEqual(selectDays(combined, period).map((d) => iso(d.date)), ['2025-01-11', '2025-01-13']);
});
