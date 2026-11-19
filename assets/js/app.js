import { readXlsx } from './xlsx-reader.js';
import {
  extractTasks, buildPeriods, selectSample, percentiles, groupOverlaps, mergePercentileLines,
  normalizeLevels, removeOutliers, combineImports, DEFAULT_LEVELS, KEY_LEVEL,
} from './lead-times.js';
import { createChart, shapePath } from './chart.js';

const $ = (id) => document.getElementById(id);
const page = document.querySelector('.page');
const defaultSource = page.dataset.source;
const manifestUrl = page.dataset.manifest;
const DAY = 86400000;
const MAX_LEVELS = 8;

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
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const levelText = (l) => String(l).replace('.', ',');

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

// ---------- Import files ----------

let nextImportId = 0;
const imports = []; // { id, name, origin: 'repo' | 'local', tasks, skipped, unit, sheetName, error }
const selected = new Set();

/** Lists the XLSX files committed to the repository (manifest generated on deploy); falls back to the default file. */
async function listRepoFiles() {
  try {
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (res.ok) {
      const { files } = await res.json();
      if (Array.isArray(files) && files.length) return files;
    }
  } catch { /* manifest missing, e.g. in a local preview */ }
  return [defaultSource];
}

async function parseImport(name, origin, getBuffer) {
  const entry = { id: nextImportId++, name, origin, tasks: [], skipped: [], unit: null, sheetName: null, error: null };
  try {
    const sheet = await readXlsx(await getBuffer());
    Object.assign(entry, extractTasks(sheet), { sheetName: sheet.sheetName });
  } catch (err) {
    entry.error = err.message;
  }
  return entry;
}

async function fetchRepoFile(path) {
  const res = await fetch(encodeURI(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

function renderFiles() {
  const list = $('file-list');
  list.replaceChildren();
  for (const imp of imports) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(imp.id);
    box.disabled = Boolean(imp.error);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(imp.id); else selected.delete(imp.id);
      dataChanged();
    });
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = imp.name;
    label.append(box, name);
    const meta = document.createElement('small');
    const origin = imp.origin === 'repo' ? 'repozytorium' : 'z dysku (tylko w tej karcie)';
    meta.textContent = imp.error ? `${origin} · błąd: ${imp.error}` : `${origin} · ${tasksWord(imp.tasks.length)}`;
    if (imp.error) meta.classList.add('error');
    li.append(label, meta);
    list.append(li);
  }
}

function renderSource() {
  const box = $('source');
  box.classList.remove('error');
  box.replaceChildren();
  const active = imports.filter((i) => selected.has(i.id));
  if (!active.length) { box.textContent = 'Nie wybrano żadnego pliku importu.'; return; }
  for (const imp of active) {
    const p = document.createElement('div');
    const unitText = imp.unit ? `Jednostka czasu: ${imp.unit}.` : 'Plik nie określa jednostki czasu realizacji.';
    p.append(`Źródło: „${imp.name}”${imp.sheetName ? ` (arkusz „${imp.sheetName}”)` : ''}. Wczytano ${tasksWord(imp.tasks.length)}, pominięto ${imp.skipped.length} ${plural(imp.skipped.length, 'wiersz', 'wiersze', 'wierszy')} (puste lub błędne). ${unitText}`);
    if (imp.skipped.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Pokaż pominięte wiersze';
      const list = document.createElement('ul');
      for (const s of imp.skipped) {
        const li = document.createElement('li');
        li.textContent = `Wiersz ${s.rowNumber}: ${s.reason}`;
        list.append(li);
      }
      details.append(summary, list);
      p.append(details);
    }
    box.append(p);
  }
}

// ---------- Shared state (the same for both percentile tabs) ----------

let pool = { tasks: [], unit: null, mixedUnits: false };
let domain = null; // { start, end } of the selected files
let range = null; // { start, end } chosen by the user
let periods = [];
let levels = [...DEFAULT_LEVELS];
let loaded = false;

const startInput = $('range-start');
const endInput = $('range-end');
const dateStart = $('date-start');
const dateEnd = $('date-end');
const toIndex = (t) => Math.round((t - domain.start) / DAY);
const fromIndex = (i) => domain.start + Number(i) * DAY;

/** Recomputes the pooled data after the file selection changes, keeping the user's range when possible. */
function dataChanged() {
  pool = combineImports(imports.filter((i) => selected.has(i.id)));
  const prevDomain = domain;
  if (pool.tasks.length) {
    const dates = pool.tasks.map((t) => t.date);
    domain = { start: Math.min(...dates), end: Math.max(...dates) };
  } else {
    domain = null;
  }
  periods = domain ? buildPeriods(pool.tasks) : [];
  const wasFull = !range || !prevDomain || (range.start === prevDomain.start && range.end === prevDomain.end);
  if (!domain) range = null;
  else if (wasFull) range = { ...domain };
  else {
    const start = Math.max(range.start, domain.start);
    const end = Math.min(range.end, domain.end);
    range = start <= end ? { start, end } : { ...domain };
  }
  setupRangeControls();
  renderSource();
  update();
}

function setupRangeControls() {
  const disabled = !domain;
  for (const el of [startInput, endInput, dateStart, dateEnd]) el.disabled = disabled;
  const presets = $('presets');
  presets.replaceChildren();
  if (disabled) {
    $('range-fill').style.left = '0';
    $('range-fill').style.right = '100%';
    $('period-name').textContent = '–';
    return;
  }
  const max = String(toIndex(domain.end));
  for (const el of [startInput, endInput]) el.max = max;
  for (const el of [dateStart, dateEnd]) { el.min = isoDay(domain.start); el.max = isoDay(domain.end); }
  for (const p of periods) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = p.months ? `${p.months} mies.` : 'Cały okres';
    b.title = periodName(p);
    b.addEventListener('click', () => setRange(p.start, p.end));
    presets.append(b);
  }
  syncRangeControls();
}

function syncRangeControls() {
  if (!domain) return;
  startInput.value = String(toIndex(range.start));
  endInput.value = String(toIndex(range.end));
  dateStart.value = isoDay(range.start);
  dateEnd.value = isoDay(range.end);
  const total = Math.max(toIndex(domain.end), 1);
  $('range-fill').style.left = `${(toIndex(range.start) / total) * 100}%`;
  $('range-fill').style.right = `${100 - (toIndex(range.end) / total) * 100}%`;
  // When both thumbs overlap, keep the one that can still move on top.
  const startOnTop = toIndex(range.start) > total / 2;
  startInput.style.zIndex = startOnTop ? '3' : '2';
  endInput.style.zIndex = startOnTop ? '2' : '3';
  startInput.setAttribute('aria-valuetext', `Od ${format.date(range.start)}`);
  endInput.setAttribute('aria-valuetext', `Do ${format.date(range.end)}`);
  const match = periods.find((p) => p.start === range.start && p.end === range.end);
  [...$('presets').children].forEach((b, i) => b.setAttribute('aria-pressed', String(periods[i] === match)));
  $('period-name').textContent = match ? periodName(match) : 'Własny zakres';
}

function setRange(start, end, moved = 'start') {
  if (!domain) return;
  start = Math.min(Math.max(start, domain.start), domain.end);
  end = Math.min(Math.max(end, domain.start), domain.end);
  if (start > end) { if (moved === 'start') start = end; else end = start; }
  range = { start, end };
  syncRangeControls();
  update();
}

startInput.addEventListener('input', () => setRange(fromIndex(startInput.value), range.end, 'start'));
endInput.addEventListener('input', () => setRange(range.start, fromIndex(endInput.value), 'end'));
// Not every browser maps Home/End on range inputs, so handle them explicitly.
for (const [input, which] of [[startInput, 'start'], [endInput, 'end']]) {
  input.addEventListener('keydown', (e) => {
    if (!domain || (e.key !== 'Home' && e.key !== 'End')) return;
    e.preventDefault();
    const t = e.key === 'Home' ? domain.start : domain.end;
    if (which === 'start') setRange(t, range.end, 'start'); else setRange(range.start, t, 'end');
  });
}
// With a mouse, bring the thumb nearest to the pointer to the front so either end can be grabbed.
$('dual-range').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !domain || e.buttons) return;
  const rect = startInput.getBoundingClientRect();
  const total = Math.max(toIndex(domain.end), 1);
  const pos = (i) => rect.left + 9 + (i / total) * (rect.width - 18);
  const ds = Math.abs(e.clientX - pos(toIndex(range.start)));
  const de = Math.abs(e.clientX - pos(toIndex(range.end)));
  const startOnTop = ds < de || (ds === de && e.clientX < pos(toIndex(range.start)));
  startInput.style.zIndex = startOnTop ? '3' : '2';
  endInput.style.zIndex = startOnTop ? '2' : '3';
});
const parseDateInput = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : null);
dateStart.addEventListener('change', () => {
  const t = parseDateInput(dateStart.value);
  if (t === null) syncRangeControls(); else setRange(t, range.end, 'start');
});
dateEnd.addEventListener('change', () => {
  const t = parseDateInput(dateEnd.value);
  if (t === null) syncRangeControls(); else setRange(range.start, t, 'end');
});

// ---------- Percentile levels ----------

function renderLevelInputs(values) {
  const list = $('level-list');
  list.replaceChildren();
  values.forEach((v, i) => {
    const item = document.createElement('span');
    item.className = 'level-item';
    const prefix = document.createElement('span');
    prefix.textContent = 'P';
    prefix.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.size = 4;
    input.value = v === '' ? '' : levelText(v);
    input.setAttribute('aria-label', `Percentyl ${i + 1} (w procentach)`);
    input.addEventListener('input', levelsChanged);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'level-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Usuń percentyl ${i + 1}`);
    remove.addEventListener('click', () => {
      item.remove();
      levelsChanged();
      list.querySelector('input')?.focus();
    });
    item.append(prefix, input, remove);
    list.append(item);
  });
  $('level-add').disabled = values.length >= MAX_LEVELS;
}

function levelsChanged() {
  const inputs = [...$('level-list').querySelectorAll('input')];
  const invalid = [];
  for (const input of inputs) {
    const ok = input.value.trim() === '' || normalizeLevels([input.value]).length === 1;
    input.setAttribute('aria-invalid', String(!ok));
    if (!ok) invalid.push(input.value.trim());
  }
  levels = normalizeLevels(inputs.map((i) => i.value));
  const err = $('level-error');
  err.hidden = !invalid.length;
  err.textContent = invalid.length ? `Pominięto niepoprawne wartości: ${invalid.join(', ')}. Wpisz liczbę większą od 0 i nie większą niż 100 (np. 85 lub 99,5).` : '';
  $('level-add').disabled = inputs.length >= MAX_LEVELS;
  update();
}

$('level-add').addEventListener('click', () => {
  const inputs = [...$('level-list').querySelectorAll('input')];
  if (inputs.length >= MAX_LEVELS) return;
  renderLevelInputs([...inputs.map((i) => i.value), '']);
  [...$('level-list').querySelectorAll('input')].at(-1).focus();
  levelsChanged();
});
$('level-reset').addEventListener('click', () => {
  renderLevelInputs(DEFAULT_LEVELS);
  levelsChanged();
});
renderLevelInputs(levels);

// ---------- Rendering ----------

const chart = createChart($('chart'), { format, onActive: (text) => { $('chart-live').textContent = text; } });

function renderStats(p, n) {
  const stats = $('stats');
  stats.replaceChildren();
  const card = (name, value, key = false) => {
    const div = document.createElement('div');
    div.className = key ? 'stat stat-key' : 'stat';
    const a = document.createElement('span');
    a.className = 'stat-name';
    a.textContent = name;
    const b = document.createElement('span');
    b.className = 'stat-value';
    b.textContent = value;
    div.append(a, b);
    stats.append(div);
  };
  for (const x of p) card(x.label, x.value === null ? '–' : format.number(x.value), x.level === KEY_LEVEL);
  card('Próba', n === null ? '–' : tasksWord(n));
}

function update() {
  const size = document.querySelector('input[name="size"]:checked').value;
  const raw = range ? selectSample(pool.tasks, size, range) : [];
  const dropOutliers = $('outliers').checked;
  const { kept: sample, removed, fences } = dropOutliers ? removeOutliers(raw) : { kept: raw, removed: [], fences: null };
  const n = sample.length;
  const p = percentiles(sample.map((t) => t.lead), method, levels);

  $('period-range').textContent = range ? `${format.date(range.start)} – ${format.date(range.end)} · ${tasksWord(n)} w próbie` : '';
  renderStats(p, range ? n : null);

  const warn = $('small-sample');
  warn.hidden = !(n > 0 && n < 20);
  warn.textContent = `Mała próba (${tasksWord(n)}, mniej niż 20): percentyle są orientacyjne, a najwyższe percentyle silnie zależą od najdłuższych realizacji.`;
  $('mixed-units').hidden = !pool.mixedUnits;

  const note = $('outlier-note');
  note.hidden = !dropOutliers || !range;
  if (dropOutliers) {
    const times = removed.map((t) => t.lead).sort((a, b) => a - b).map(format.number).join(', ');
    note.textContent = !fences
      ? 'Odrzucanie wartości skrajnych wymaga co najmniej 4 zadań w próbie – nic nie odrzucono.'
      : `Odrzucono ${tasksWord(removed.length)} spoza przedziału ${format.number(Math.max(fences.low, 0))} – ${format.number(fences.high)}${removed.length ? ` (czasy: ${times})` : ''}.`;
  }

  const key = p.find((x) => x.level === KEY_LEVEL) || p.at(-1);
  $('explain').textContent = key
    ? `${key.label} to historyczny próg, w którym mieści się około ${levelText(key.level)}% czasów realizacji z wybranej próby. Można go użyć jako punktu odniesienia przy planowaniu podobnych zadań.`
    : 'Wpisz co najmniej jeden poziom percentyla, aby zobaczyć progi czasu realizacji.';

  const empty = $('empty');
  empty.hidden = n > 0;
  empty.textContent = !loaded ? 'Wczytywanie danych…'
    : !selected.size ? 'Nie wybrano żadnego pliku importu.'
      : !pool.tasks.length ? 'Wybrane pliki nie zawierają poprawnych zadań.'
        : 'Brak zadań dla wybranego rozmiaru i okresu';

  const groups = groupOverlaps(sample).sort((a, b) => a.date - b.date || a.lead - b.lead);
  const sizeText = size === 'ALL' ? 'wszystkie rozmiary' : `rozmiar ${size}`;
  const leadName = 'Czas realizacji';
  const rangeText = range ? `${format.date(range.start)} – ${format.date(range.end)}` : 'brak okresu';
  const pText = p.filter((x) => x.value !== null).map((x) => `${x.label} ${format.number(x.value)}`).join(', ');
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  chart.reset();
  chart.render({
    xDomain: range ? [range.start, range.end] : [today - 90 * DAY, today],
    yMax: n ? Math.max(...sample.map((t) => t.lead)) : Math.max(1, ...pool.tasks.map((t) => t.lead)),
    yTitle: pool.unit ? `${leadName} (${pool.unit})` : leadName,
    leadName,
    showFile: selected.size > 1,
    groups,
    lines: n ? mergePercentileLines(p) : [],
    ariaLabel: n
      ? `Wykres punktowy: ${tasksWord(n)}, ${sizeText}, ${rangeText}.${pText ? ` Percentyle (${METHODS[method].name}): ${pText}.` : ''} Strzałki przełączają punkty.`
      : `Brak zadań dla wybranego rozmiaru i okresu (${sizeText}, ${rangeText}).`,
  });
}

document.querySelectorAll('input[name="size"]').forEach((r) => r.addEventListener('change', update));
$('outliers').addEventListener('change', update);
$('files-all').addEventListener('click', () => {
  imports.filter((i) => !i.error).forEach((i) => selected.add(i.id));
  renderFiles();
  dataChanged();
});
$('files-none').addEventListener('click', () => {
  selected.clear();
  renderFiles();
  dataChanged();
});
$('file-upload').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const taken = imports.some((i) => i.name === file.name);
    const entry = await parseImport(taken ? `${file.name} (z dysku)` : file.name, 'local', () => file.arrayBuffer());
    imports.push(entry);
    if (!entry.error) selected.add(entry.id);
  }
  renderFiles();
  dataChanged();
});
onMethodChange = update;

async function load() {
  const names = await listRepoFiles();
  const results = await Promise.all(names.map((name) => parseImport(name, 'repo', () => fetchRepoFile(name))));
  imports.push(...results);
  for (const imp of results) if (!imp.error) selected.add(imp.id);
  loaded = true;
  renderFiles();
  dataChanged();
  const failed = results.filter((i) => i.error);
  if (failed.length === results.length) {
    const box = $('source');
    box.classList.add('error');
    box.textContent = `Nie udało się wczytać danych: ${failed.map((i) => `„${i.name}”: ${i.error}`).join(' ')}${location.protocol === 'file:' ? ' Otwórz stronę przez serwer HTTP (np. GitHub Pages), a nie bezpośrednio z dysku.' : ''}`;
    $('empty').hidden = false;
    $('empty').textContent = 'Nie udało się wczytać danych.';
  }
}

update();
load();
