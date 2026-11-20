import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readXlsx } from '../assets/js/xlsx-reader.js';
import { computeXmR, computeVariation } from '../assets/js/lead-times.js';
import {
  isThroughputSheet, extractThroughput, combineThroughput, selectDays, polishHolidays, isDayOff, aggregateWeeks,
} from '../assets/js/throughput.js';

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

test('combining throughput files sums the same date; days off can be skipped', () => {
  const day = (t, lead) => ({ date: Date.parse(`${t}T00:00:00Z`), lead });
  const combined = combineThroughput([
    { name: 'A', days: [day('2025-01-10', 2), day('2025-01-11', 0)] },
    { name: 'B', days: [day('2025-01-10', 3), day('2025-01-13', 4)] },
  ]);
  assert.deepEqual(combined.map((d) => [iso(d.date), d.lead, d.file, d.id]), [
    ['2025-01-10', 5, 'A, B', 0], ['2025-01-11', 0, 'A', 1], ['2025-01-13', 4, 'B', 2],
  ]);
  assert.deepEqual(selectDays(combined, null, { skipDaysOff: true }).map((d) => iso(d.date)), ['2025-01-10', '2025-01-13']);
  const period = { start: combined[1].date, end: combined[2].date };
  assert.deepEqual(selectDays(combined, period).map((d) => iso(d.date)), ['2025-01-11', '2025-01-13']);
});

const utcDay = (t) => Date.parse(`${t}T00:00:00Z`);

test('Polish public holidays: fixed dates, Easter-based dates and Christmas Eve from 2025', () => {
  assert.deepEqual([...polishHolidays(2025).keys()].map(iso), [
    '2025-01-01', '2025-01-06', '2025-04-20', '2025-04-21', '2025-05-01', '2025-05-03', '2025-06-08',
    '2025-06-19', '2025-08-15', '2025-11-01', '2025-11-11', '2025-12-24', '2025-12-25', '2025-12-26',
  ]);
  assert.equal(polishHolidays(2024).has(utcDay('2024-12-24')), false);
  assert.ok(polishHolidays(2024).has(utcDay('2024-05-30'))); // Boże Ciało 2024
  assert.equal(isDayOff(utcDay('2025-04-21')), true);
  assert.equal(isDayOff(utcDay('2025-01-11')), true); // Saturday
  assert.equal(isDayOff(utcDay('2025-01-07')), false);
});

test('weeks Monday–Friday: weekends never summed, holidays left out on request, empty weeks dropped', () => {
  const day = (t, lead, file = 'A') => ({ date: utcDay(t), lead, file });
  const days = [
    day('2025-04-18', 2), day('2025-04-19', 7), day('2025-04-20', 7), // Fri, Sat, Easter Sunday
    day('2025-04-21', 5), day('2025-04-22', 1), day('2025-04-25', 3, 'B'), // Easter Monday, Tue, Fri
    day('2025-04-26', 9), // Saturday only → no week
  ];
  const keep = aggregateWeeks(days);
  assert.deepEqual(keep.map((w) => [iso(w.weekStart), iso(w.weekEnd), w.lead, w.workdays, w.id]), [
    ['2025-04-14', '2025-04-18', 2, 1, 0], ['2025-04-21', '2025-04-25', 9, 3, 1],
  ]);
  assert.equal(keep[1].file, 'A, B');
  const skip = aggregateWeeks(days, { skipHolidays: true });
  assert.deepEqual(skip.map((w) => [w.lead, w.workdays, w.holidays]), [[2, 1, []], [4, 2, ['Poniedziałek Wielkanocny']]]);
});

test('median XmR: centre lines are medians, Wheeler factors, lower X limit not below 0', () => {
  const tasks = [0, 5, 1, 1, 6].map((lead, i) => ({ id: i, date: i, lead }));
  const xmr = computeXmR(tasks, { center: 'median', nonNegative: true });
  // mR: 5, 4, 0, 5 → median 4.5; median X = 1
  close(xmr.xMean, 1);
  close(xmr.mrMean, 4.5);
  close(xmr.limits.x.upper, 1 + 3.145 * 4.5);
  close(xmr.limits.x.rawLower, 1 - 3.145 * 4.5);
  assert.equal(xmr.limits.x.lower, 0);
  close(xmr.limits.mr.upper, 3.865 * 4.5);
  assert.ok(computeXmR(tasks).limits.x.lower < 0);
});
