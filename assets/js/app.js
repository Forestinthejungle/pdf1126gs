import { readXlsx } from './xlsx-reader.js';
import {
  extractTasks, buildPeriods, selectSample, percentiles, groupOverlaps, mergePercentileLines,
} from './lead-times.js';
import { createChart, shapePath } from './chart.js';

const $ = (id) => document.getElementById(id);
const page = document.querySelector('.page');
const source = page.dataset.source;

const numberFmt = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const format = { number: (v) => numberFmt.format(v), date: (t) => dateFmt.format(new Date(t)) };

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}
const tasksWord = (n) => `${n} ${plural(n, 'zadanie', 'zadania', 'zadań')}`;
const periodName = (p) => (p.months ? `ostatnie ${p.months} ${plural(p.months, 'miesiąc', 'miesiące', 'miesięcy')}` : 'Cały okres');

document.querySelectorAll('.legend [data-shape]').forEach((path) => path.setAttribute('d', shapePath(path.dataset.shape, 5.5)));

const METHODS = {
  inc: {
    name: 'interpolacja liniowa',
    note: 'Metoda: interpolacja liniowa, taka sama jak w Excelu (PERCENTILE.INC). Gdy percentyl wypada między dwoma zadaniami, wynik leży pomiędzy ich czasami, więc nie musi być czasem żadnego konkretnego zadania.',
  },
  'nearest-rank': {
    name: 'nearest rank',
    note: 'Metoda: nearest rank (najbliższa ranga). Wynikiem jest czas konkretnego zadania z próby: najmniejsza wartość, przy której co najmniej P% zadań ma czas nie dłuższy. Wyniki mogą się różnić od Excela (PERCENTILE.INC).',
  },
};
const tabs = [...document.querySelectorAll('[role="tab"]')];
const methodFromHash = () => (Object.hasOwn(METHODS, location.hash.slice(1)) ? location.hash.slice(1) : 'inc');
let method = methodFromHash();
let onMethodChange = () => {};

function setMethod(next, { focus = false, updateHash = true } = {}) {
  method = next;
  for (const tab of tabs) {
    const selected = tab.dataset.method === method;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) {
      $('dashboard').setAttribute('aria-labelledby', tab.id);
      if (focus) tab.focus();
    }
  }
  $('method-note').textContent = METHODS[method].note;
  if (updateHash) history.replaceState(null, '', method === 'inc' ? location.pathname + location.search : `#${method}`);
  onMethodChange();
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => setMethod(tab.dataset.method));
  tab.addEventListener('keydown', (e) => {
    const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    setMethod(tabs[(target + tabs.length) % tabs.length].dataset.method, { focus: true });
  });
});
window.addEventListener('hashchange', () => setMethod(methodFromHash(), { updateHash: false }));
setMethod(method, { updateHash: false });

async function load() {
  const res = await fetch(encodeURI(source), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku „${source}” (HTTP ${res.status}).`);
  const sheet = await readXlsx(await res.arrayBuffer());
  return { sheet, ...extractTasks(sheet) };
}

function renderSource({ sheet, tasks, skipped, unit }) {
  const box = $('source');
  box.replaceChildren();
  const unitText = unit ? `Jednostka czasu: ${unit}.` : 'Plik źródłowy nie określa jednostki czasu realizacji.';
  box.append(`Źródło: „${source}”${sheet.sheetName ? ` (arkusz „${sheet.sheetName}”)` : ''}. Wczytano ${tasksWord(tasks.length)}, pominięto ${skipped.length} ${plural(skipped.length, 'wiersz', 'wiersze', 'wierszy')} (puste lub błędne). ${unitText}`);
  if (skipped.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Pokaż pominięte wiersze';
    const list = document.createElement('ul');
    for (const s of skipped) {
      const li = document.createElement('li');
      li.textContent = `Wiersz ${s.rowNumber}: ${s.reason}`;
      list.append(li);
    }
    details.append(summary, list);
    box.append(details);
  }
}

function init(data) {
  const { tasks, unit } = data;
  renderSource(data);
  if (!tasks.length) {
    $('empty').hidden = false;
    $('empty').textContent = 'Plik nie zawiera poprawnych zadań.';
    return;
  }
  const periods = buildPeriods(tasks);
  const slider = $('period');
  slider.max = String(periods.length - 1);
  slider.value = String(periods.length - 1);
  const ticks = $('period-ticks');
  periods.forEach((p, i) => {
    const span = document.createElement('span');
    span.style.left = periods.length > 1 ? `${(i / (periods.length - 1)) * 100}%` : '0';
    const long = document.createElement('b');
    long.className = 'tick-long';
    long.textContent = p.months ? `${p.months} mies.` : 'Cały okres';
    const short = document.createElement('b');
    short.className = 'tick-short';
    short.textContent = p.months ? `${p.months} m` : 'Całość';
    span.append(long, short);
    ticks.append(span);
  });
  const allMax = Math.max(...tasks.map((t) => t.lead));
  const leadName = 'Czas realizacji';
  const yTitle = unit ? `${leadName} (${unit})` : leadName;

  const chart = createChart($('chart'), { format, onActive: (text) => { $('chart-live').textContent = text; } });

  function update() {
    const size = document.querySelector('input[name="size"]:checked').value;
    const period = periods[Number(slider.value)];
    const sample = selectSample(tasks, size, period);
    const p = sample.length ? percentiles(sample.map((t) => t.lead), method) : { p50: null, p85: null, p95: null };
    const n = sample.length;

    $('period-name').textContent = periodName(period);
    slider.setAttribute('aria-valuetext', `${periodName(period)}: ${format.date(period.start)} – ${format.date(period.end)}`);
    $('period-range').textContent = `${format.date(period.start)} – ${format.date(period.end)} · ${tasksWord(n)} w próbie`;
    for (const k of ['p50', 'p85', 'p95']) $(k).textContent = p[k] === null ? '–' : format.number(p[k]);
    $('n').textContent = tasksWord(n);

    const warn = $('small-sample');
    warn.hidden = !(n > 0 && n < 20);
    warn.textContent = `Mała próba (${tasksWord(n)}, mniej niż 20): percentyle są orientacyjne, a P95 silnie zależy od najdłuższych realizacji.`;
    $('empty').hidden = n > 0;

    const groups = groupOverlaps(sample).sort((a, b) => a.date - b.date || a.lead - b.lead);
    const sizeText = size === 'ALL' ? 'wszystkie rozmiary' : `rozmiar ${size}`;
    chart.reset();
    chart.render({
      xDomain: [period.start, period.end],
      yMax: n ? Math.max(...sample.map((t) => t.lead)) : allMax,
      yTitle,
      leadName,
      groups,
      lines: n ? mergePercentileLines(p) : [],
      ariaLabel: n
        ? `Wykres punktowy: ${tasksWord(n)}, ${sizeText}, ${periodName(period)}. Percentyle (${METHODS[method].name}): P50 ${format.number(p.p50)}, P85 ${format.number(p.p85)}, P95 ${format.number(p.p95)}. Strzałki przełączają punkty.`
        : `Brak zadań dla wybranego rozmiaru i okresu (${sizeText}, ${periodName(period)}).`,
    });
  }

  document.querySelectorAll('input[name="size"]').forEach((r) => r.addEventListener('change', update));
  slider.addEventListener('input', update);
  // Not every browser maps Home/End on range inputs, so handle them explicitly.
  slider.addEventListener('keydown', (e) => {
    if (e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    slider.value = e.key === 'Home' ? slider.min : slider.max;
    update();
  });
  onMethodChange = update;
  update();
}

load().then(init).catch((err) => {
  const box = $('source');
  box.classList.add('error');
  box.textContent = `Nie udało się wczytać danych: ${err.message}${location.protocol === 'file:' ? ' Otwórz stronę przez serwer HTTP (np. GitHub Pages), a nie bezpośrednio z dysku.' : ''}`;
  $('empty').hidden = false;
  $('empty').textContent = 'Nie udało się wczytać danych.';
});
