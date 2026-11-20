import { readXlsx } from './xlsx-reader.js';
import {
  extractTasks, buildPeriods, selectSample, percentiles, groupOverlaps, mergePercentileLines,
  normalizeLevels, removeOutliers, combineImports, computeXmR, computeVariation, ruleTasks, ruleClosest, DEFAULT_LEVELS, KEY_LEVEL,
  taskKey, splitExcluded,
} from './lead-times.js';
import { createChart, shapePath } from './chart.js';
import { createXmrCharts } from './xmr-chart.js';
import { createVariationCharts } from './variation-charts.js';
import { isThroughputSheet, extractThroughput, combineThroughput, selectDays } from './throughput.js';

const $ = (id) => document.getElementById(id);
const page = document.querySelector('.page');
const defaultSource = page.dataset.source;
const manifestUrl = page.dataset.manifest;
const DAY = 86400000;
const MAX_LEVELS = 8;

const numberFmt = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const format = { number: (v) => numberFmt.format(v), date: (t) => dateFmt.format(new Date(t)) };
const fixed2Fmt = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const xmrFormat = {
  number: format.number,
  fixed2: (v) => fixed2Fmt.format(v),
  dateTime: (task) => (task.hasTime ? `${format.date(task.date)}, godz. ${timeFmt.format(new Date(task.completedAt))}` : format.date(task.date)),
};

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
// The delivery-rate tab shows a separate panel; the percentile method of the lead-time tabs is kept meanwhile.
const DELIVERY = 'delivery';
const DELIVERY_HASH = 'tempo-dostarczania';
const TITLES = { lead: $('page-title').textContent, delivery: 'Tempo dostarczania' };
const SUBTITLES = {
  lead: $('subtitle').textContent,
  delivery: 'Każdy punkt to jeden dzień: liczba zadań dostarczonych tego dnia. Granice procesu i sygnały liczone są metodą Shewharta (XmR).',
};
const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabFromHash = () => {
  const h = location.hash.slice(1);
  return h === DELIVERY_HASH ? DELIVERY : Object.hasOwn(METHODS, h) ? h : 'inc';
};
let currentTab = tabFromHash();
let method = currentTab === DELIVERY ? 'inc' : currentTab;
let onMethodChange = () => {};

function setMethod(next, { focus = false, updateHash = true } = {}) {
  currentTab = next;
  if (next !== DELIVERY) method = next;
  const delivery = next === DELIVERY;
  for (const tab of tabs) {
    const selected = tab.dataset.method === next;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) {
      if (!delivery) $('dashboard').setAttribute('aria-labelledby', tab.id);
      if (focus) tab.focus();
    }
  }
  $('dashboard').hidden = delivery;
  $('source').hidden = delivery;
  $('delivery').hidden = !delivery;
  $('page-title').textContent = TITLES[delivery ? 'delivery' : 'lead'];
  $('subtitle').textContent = SUBTITLES[delivery ? 'delivery' : 'lead'];
  $('method-note').textContent = METHODS[method].note;
  if (updateHash) {
    const hash = delivery ? `#${DELIVERY_HASH}` : method === 'inc' ? '' : `#${method}`;
    history.replaceState(null, '', hash || location.pathname + location.search);
  }
  if (!delivery) onMethodChange();
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
window.addEventListener('hashchange', () => setMethod(tabFromHash(), { updateHash: false }));
setMethod(currentTab, { updateHash: false });

// ---------- Import files ----------

let nextImportId = 0;
// kind 'lead': lead-time tasks; kind 'throughput': daily delivered-task counts (delivery-rate tab).
const imports = []; // { id, name, origin: 'repo' | 'local', kind, tasks, days, skipped, unit, sheetName, error }
const selected = new Set();
const leadImports = () => imports.filter((i) => i.kind === 'lead');
const throughputImports = () => imports.filter((i) => i.kind === 'throughput');

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
  const entry = { id: nextImportId++, name, origin, kind: 'lead', tasks: [], days: [], skipped: [], unit: null, sheetName: null, error: null };
  try {
    const sheet = await readXlsx(await getBuffer());
    if (isThroughputSheet(sheet)) Object.assign(entry, { kind: 'throughput' }, extractThroughput(sheet), { sheetName: sheet.sheetName });
    else Object.assign(entry, extractTasks(sheet), { sheetName: sheet.sheetName });
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
  renderFileList($('file-list'), leadImports(), (imp) => tasksWord(imp.tasks.length), dataChanged);
  renderFileList($('tp-file-list'), throughputImports(), (imp) => daysWord(imp.days.length), deliveryDataChanged);
}

function renderFileList(list, entries, countText, onChange) {
  list.replaceChildren();
  if (loaded && !entries.length) {
    const li = document.createElement('li');
    li.className = 'file-loading';
    li.textContent = 'Brak plików tego rodzaju.';
    list.append(li);
  }
  for (const imp of entries) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(imp.id);
    box.disabled = Boolean(imp.error);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(imp.id); else selected.delete(imp.id);
      onChange();
    });
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = imp.name;
    label.append(box, name);
    const meta = document.createElement('small');
    const origin = imp.origin === 'repo' ? 'repozytorium' : 'z dysku (tylko w tej karcie)';
    meta.textContent = imp.error ? `${origin} · błąd: ${imp.error}` : `${origin} · ${countText(imp)}`;
    if (imp.error) meta.classList.add('error');
    li.append(label, meta);
    list.append(li);
  }
}

function renderSource() {
  const box = $('source');
  box.classList.remove('error');
  box.replaceChildren();
  const active = leadImports().filter((i) => selected.has(i.id));
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
let poolVersion = 0;
let domain = null; // { start, end } of the selected files
let range = null; // { start, end } chosen by the user
let periods = [];
let levels = [...DEFAULT_LEVELS];
const excludedKeys = new Set(); // tasks removed by hand (shared by both tabs)
let loaded = false;

const startInput = $('range-start');
const endInput = $('range-end');
const dateStart = $('date-start');
const dateEnd = $('date-end');
const toIndex = (t) => Math.round((t - domain.start) / DAY);
const fromIndex = (i) => domain.start + Number(i) * DAY;

/** Recomputes the pooled data after the file selection changes, keeping the user's range when possible. */
function dataChanged() {
  pool = combineImports(leadImports().filter((i) => selected.has(i.id)));
  poolVersion++;
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
    const item = document.createElement('li');
    item.className = 'level-item';
    const prefix = document.createElement('span');
    prefix.className = 'level-prefix';
    prefix.textContent = 'P';
    prefix.setAttribute('aria-hidden', 'true');
    const field = document.createElement('span');
    field.className = 'level-field';
    const suffix = document.createElement('span');
    suffix.className = 'level-suffix';
    suffix.textContent = '%';
    suffix.setAttribute('aria-hidden', 'true');
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
    remove.textContent = 'Usuń';
    remove.setAttribute('aria-label', `Usuń percentyl ${i + 1}`);
    remove.addEventListener('click', () => {
      item.remove();
      levelsChanged();
      list.querySelector('input')?.focus();
    });
    field.append(input, suffix);
    item.append(prefix, field, remove);
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

function toggleExcluded(group) {
  const keys = group.tasks.map(taskKey);
  if (group.excluded) keys.forEach((k) => excludedKeys.delete(k));
  else keys.forEach((k) => excludedKeys.add(k));
  update({ keepActive: true });
  const n = group.tasks.length;
  $('chart-live').textContent = group.excluded
    ? `Przywrócono ${tasksWord(n)} do próby.`
    : `Wykluczono ${tasksWord(n)} z próby.`;
}

const chart = createChart($('chart'), {
  format,
  onActive: (text) => { $('chart-live').textContent = text; },
  onToggle: toggleExcluded,
});

function renderExcluded() {
  const box = $('excluded');
  const list = pool.tasks.filter((t) => excludedKeys.has(taskKey(t))).sort((a, b) => a.date - b.date || a.lead - b.lead);
  box.hidden = !list.length;
  if (!list.length) return;
  $('excluded-count').textContent = `Wykluczone ręcznie: ${tasksWord(list.length)}`;
  const ul = $('excluded-list');
  ul.replaceChildren();
  for (const t of list) {
    const li = document.createElement('li');
    const text = `${format.date(t.date)} · ${t.size} · ${format.number(t.lead)}${leadImports().filter((i) => selected.has(i.id)).length > 1 ? ` · ${t.file}` : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn';
    btn.textContent = 'Przywróć';
    btn.setAttribute('aria-label', `Przywróć zadanie: ${text}`);
    btn.addEventListener('click', () => {
      excludedKeys.delete(taskKey(t));
      update();
      ($('excluded-list').querySelector('button') || $('chart').querySelector('svg')).focus();
    });
    li.append(text, ' ', btn);
    ul.append(li);
  }
}

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

function update({ keepActive = false } = {}) {
  const size = document.querySelector('input[name="size"]:checked').value;
  const inFilter = range ? selectSample(pool.tasks, size, range) : [];
  const { kept: raw, excluded: manual } = splitExcluded(inFilter, excludedKeys);
  const dropOutliers = $('outliers').checked;
  const { kept: sample, removed, fences } = dropOutliers ? removeOutliers(raw) : { kept: raw, removed: [], fences: null };
  const n = sample.length;
  const p = percentiles(sample.map((t) => t.lead), method, levels);

  $('period-range').textContent = range
    ? `${format.date(range.start)} – ${format.date(range.end)} · ${tasksWord(n)} w próbie${manual.length ? ` (${manual.length} ${plural(manual.length, 'wykluczone', 'wykluczone', 'wykluczonych')} ręcznie)` : ''}`
    : '';
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
  empty.hidden = n > 0 || manual.length > 0;
  empty.textContent = !loaded ? 'Wczytywanie danych…'
    : !leadImports().some((i) => selected.has(i.id)) ? 'Nie wybrano żadnego pliku importu.'
      : !pool.tasks.length ? 'Wybrane pliki nie zawierają poprawnych zadań.'
        : 'Brak zadań dla wybranego rozmiaru i okresu';

  const groups = [
    ...groupOverlaps(sample),
    ...groupOverlaps(manual).map((g) => ({ ...g, excluded: true })),
  ].sort((a, b) => a.date - b.date || a.lead - b.lead || Number(Boolean(a.excluded)) - Number(Boolean(b.excluded)));
  renderExcluded();
  const sizeText = size === 'ALL' ? 'wszystkie rozmiary' : `rozmiar ${size}`;
  const leadName = 'Czas realizacji';
  const rangeText = range ? `${format.date(range.start)} – ${format.date(range.end)}` : 'brak okresu';
  const pText = p.filter((x) => x.value !== null).map((x) => `${x.label} ${format.number(x.value)}`).join(', ');
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (!keepActive) chart.reset();
  chart.render({
    xDomain: range ? [range.start, range.end] : [today - 90 * DAY, today],
    yMax: n || manual.length ? Math.max(...sample.map((t) => t.lead), ...manual.map((t) => t.lead)) : Math.max(1, ...pool.tasks.map((t) => t.lead)),
    yTitle: pool.unit ? `${leadName} (${pool.unit})` : leadName,
    leadName,
    showFile: leadImports().filter((i) => selected.has(i.id)).length > 1,
    groups,
    lines: n ? mergePercentileLines(p) : [],
    ariaLabel: n
      ? `Wykres punktowy: ${tasksWord(n)}, ${sizeText}, ${rangeText}.${manual.length ? ` Wykluczone ręcznie: ${manual.length}.` : ''}${pText ? ` Percentyle (${METHODS[method].name}): ${pText}.` : ''} Strzałki przełączają punkty, Enter wyklucza lub przywraca punkt.`
      : `Brak zadań dla wybranego rozmiaru i okresu (${sizeText}, ${rangeText}).`,
  });

  renderLeadXmr({ sample, sizeText, rangeText, dropOutliers, removedCount: removed.length, emptyText: empty.textContent });
}

// ---------- XmR control charts and Western Electric rules, shared by the lead-time and delivery-rate tabs ----------

const weekdayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', timeZone: 'UTC' });
const daysWord = (n) => `${n} ${plural(n, 'dzień', 'dni', 'dni')}`;
const rangesWord = (n) => `${n} ${plural(n, 'rozstęp', 'rozstępy', 'rozstępów')}`;

/** Vocabulary of one series: what a point is (a task or a day) and how it is described. */
const TASK_TERMS = {
  count: tasksWord,
  plural: 'zadania',
  Plural: 'Zadania',
  gen: 'zadań',
  two: 'dwóch zadań',
  order: 'w kolejności ukończenia',
  ref: (i, t) => `zadanie nr ${i}${t.taskId ? ` (ID ${t.taskId})` : ''}`,
  Ref: (i) => `Zadanie nr ${i}`,
  pairs: (a, b) => `zadania ${a} → ${b}`,
  series: 'seria zadań',
  window: 'okno zadań',
  lastOfRun: (d) => `ostatnie zadanie serii ukończono ${d}`,
  lastInWindow: (d) => `ostatnie ukończone ${d}`,
  noneBeyond: 'Żadne zadanie nie przekracza',
  satisfy: (n) => `${n} ${plural(n, 'zadanie spełnia', 'zadania spełniają', 'zadań spełnia')}`,
  inViewHits: (n) => plural(n, 'zadania spełniającego', 'zadań spełniających', 'zadań spełniających'),
  extraParts: (t) => [`rozmiar ${t.size}`],
  dateTime: xmrFormat.dateTime,
};

const dayDate = (t) => `${format.date(t.date)} (${weekdayFmt.format(new Date(t.date))})`;
const DAY_TERMS = {
  count: daysWord,
  plural: 'dni',
  Plural: 'Dni',
  gen: 'dni',
  two: 'dwóch dni',
  order: 'w kolejności dat',
  ref: (i) => `dzień nr ${i}`,
  Ref: (i) => `Dzień nr ${i}`,
  pairs: (a, b) => `dni ${a} → ${b}`,
  series: 'seria dni',
  window: 'okno dni',
  lastOfRun: (d) => `ostatni dzień serii: ${d}`,
  lastInWindow: (d) => `ostatni dzień ${d}`,
  noneBeyond: 'Żaden dzień nie przekracza',
  satisfy: (n) => `${n} ${plural(n, 'dzień spełnia', 'dni spełniają', 'dni spełnia')}`,
  inViewHits: (n) => plural(n, 'dnia spełniającego', 'dni spełniających', 'dni spełniających'),
  extraParts: () => [],
  dateTime: dayDate,
};

/** Chart wording for days (tooltips and axis); lead-time tasks use the chart modules' defaults. */
const DAY_DESCRIBE = {
  xTitle: 'Nr dnia (kolejność dat)',
  title: (i) => `Dzień nr ${i}`,
  rangeTitle: (a, b) => `Rozstęp kroczący: dni ${a} i ${b}`,
  runText: 'Seria dni',
  detectText: 'wykrycie przy dniu',
  lines: (item, { format: fmt, showFile }) => {
    const lines = [`Data: ${dayDate(item.task)}`, `Dostarczone zadania: ${fmt.number(item.value)}`];
    if (showFile && item.task.file) lines.push(`Plik: ${item.task.file}`);
    return lines;
  },
  pair: (no, t, { format: fmt }) => `Dzień ${no}: ${dayDate(t)}, ${fmt.number(t.lead)}`,
};

/** Wires one XmR section and one variation section whose element ids start with `prefix`. */
function createSeriesView(prefix, terms) {
  const q = (id) => $(prefix + id);
  const xmrRoot = q('xmr');
  const variationRoot = q('variation');
  const viewText = (view, n, what) => {
    const zoomed = n > 1 && (view.start > 1 || view.end < n);
    const text = !n ? ''
      : zoomed ? `Widok: ${terms.plural} ${view.start}–${view.end} z ${n}. Przybliżenie zmienia tylko widok – ${what} liczone dla wszystkich ${terms.count(n)}.`
        : `Widok: wszystkie ${terms.plural} (1–${n}).`;
    return { zoomed, text };
  };
  const setZoomButtons = (buttons, attr, view, n, zoomed) => {
    for (const b of buttons) {
      const a = b.dataset[attr];
      b.disabled = n < 2 || (a === 'in' && view.end - view.start <= 1) || ((a === 'out' || a === 'reset') && !zoomed)
        || (a === 'left' && view.start <= 1) || (a === 'right' && view.end >= n);
    }
  };
  const chartFormat = { ...xmrFormat, dateTime: terms.dateTime };
  const sv = { q, terms, xmrRoot, variationRoot, hits: [] };

  sv.xmrCharts = createXmrCharts({
    xContainer: q('xmr-x-chart'),
    mrContainer: q('xmr-mr-chart'),
    format: chartFormat,
    onActive: (text) => { q('xmr-live').textContent = text; },
    onViewChange: (view, n) => {
      const { zoomed, text } = viewText(view, n, 'granice są');
      q('xmr-view').textContent = text;
      setZoomButtons(xmrRoot.querySelectorAll('[data-zoom]'), 'zoom', view, n, zoomed);
    },
  });
  xmrRoot.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => sv.xmrCharts.zoom(b.dataset.zoom)));

  sv.variationCharts = createVariationCharts({
    containers: [1, 2, 3, 4].map((i) => q(`we-chart-${i}`)),
    format: chartFormat,
    onActive: (text) => { q('variation-live').textContent = text; },
    onViewChange: (view, n) => {
      const { zoomed, text } = viewText(view, n, 'granice i sygnały są');
      q('variation-view').textContent = text;
      renderVariationViewCounts(sv, view, zoomed);
      setZoomButtons(variationRoot.querySelectorAll('[data-variation-zoom]'), 'variationZoom', view, n, zoomed);
    },
  });
  variationRoot.querySelectorAll('[data-variation-zoom]').forEach((b) => b.addEventListener('click', () => sv.variationCharts.zoom(b.dataset.variationZoom)));
  return sv;
}

const leadView = createSeriesView('', TASK_TERMS);
const deliveryView = createSeriesView('tp-', DAY_TERMS);

/**
 * Draws the XmR summary, signal list and both charts of one view, then its Western Electric charts.
 * opts: { sample, unit, valueTitle, mrTitle, showFile, scope, skippedText, emptyText, key, describe }
 */
function renderXmr(sv, opts) {
  const { q, terms } = sv;
  const { sample, unit, scope, emptyText } = opts;
  const xmr = computeXmR(sample);
  const { n, limits } = xmr;
  const f = xmrFormat.fixed2;
  const unitText = unit ? ` ${unit}` : '';

  q('xmr-skipped').textContent = opts.skippedText;
  q('xmr-scope').textContent = scope;
  q('xmr-single').hidden = n !== 1;

  const summary = q('xmr-summary');
  summary.replaceChildren();
  const group = (title, items) => {
    const box = document.createElement('div');
    box.className = 'xmr-group';
    const h = document.createElement('h3');
    h.textContent = title;
    const stats = document.createElement('div');
    stats.className = 'stats xmr-stats';
    for (const [name, value, note, cls] of items) {
      const div = document.createElement('div');
      div.className = `stat ${cls || ''}`;
      const a = document.createElement('span');
      a.className = 'stat-name';
      a.textContent = name;
      const b = document.createElement('span');
      b.className = 'stat-value';
      b.textContent = value;
      div.append(a, b);
      if (note) {
        const c = document.createElement('span');
        c.className = 'stat-note';
        c.textContent = note;
        div.append(c);
      }
      stats.append(div);
    }
    box.append(h, stats);
    summary.append(box);
  };
  const dash = '–';
  group('Karta X', [
    ['Linia środkowa (średnia)', n ? f(xmr.xMean) : dash, null, 'stat-key'],
    ['Górna granica', limits ? f(limits.x.upper) : dash, null, 'stat-limit'],
    ['Dolna granica', limits ? f(limits.x.lower) : dash, limits && limits.x.lower < 0 ? 'ujemna – poniżej zakresu wykresu (oś od 0)' : null, 'stat-limit'],
    [terms.Plural, String(n), null],
    ['Sygnały', limits ? String(xmr.xSignals.length) : dash, null, xmr.xSignals.length ? 'stat-signal' : ''],
  ]);
  group('Karta mR', [
    ['Linia środkowa (średni mR)', limits ? f(xmr.mrMean) : dash, null, 'stat-key'],
    ['Górna granica (URL)', limits ? f(limits.mr.upper) : dash, null, 'stat-limit'],
    ['Dolna granica (LRL)', limits ? f(limits.mr.lower) : dash, null, 'stat-limit'],
    ['Rozstępy', String(xmr.ranges.length), null],
    ['Sygnały', limits ? String(xmr.mrSignals.length) : dash, null, xmr.mrSignals.length ? 'stat-signal' : ''],
  ]);

  const signals = [
    ...xmr.xSignals.map((p) => `Karta X: ${terms.ref(p.index, p.task)}, ${terms.dateTime(p.task)} – ${f(p.value)}${unitText}, ${p.signal === 'high' ? `powyżej górnej granicy ${f(limits.x.upper)}` : `poniżej dolnej granicy ${f(limits.x.lower)}`}`),
    ...xmr.mrSignals.map((r) => `Karta mR: ${terms.pairs(r.index - 1, r.index)} – różnica ${f(r.value)}${unitText} (${f(r.from.lead)} → ${f(r.to.lead)}), powyżej górnej granicy ${f(limits.mr.upper)}`),
  ];
  q('xmr-signals').hidden = !signals.length;
  q('xmr-signals-title').textContent = `Sygnał do sprawdzenia: ${signals.length} ${plural(signals.length, 'punkt', 'punkty', 'punktów')} ściśle poza granicami`;
  q('xmr-signals-list').replaceChildren(...signals.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));

  const xEmpty = q('xmr-x-empty');
  xEmpty.hidden = n > 0;
  xEmpty.textContent = emptyText;
  const mrEmpty = q('xmr-mr-empty');
  mrEmpty.hidden = n > 1;
  mrEmpty.textContent = n === 1 ? `Do obliczenia rozstępu i granic potrzeba co najmniej ${terms.two}.` : emptyText;

  const limitsText = limits
    ? ` Średnia ${f(xmr.xMean)}, granice ${f(limits.x.lower)} i ${f(limits.x.upper)}. Sygnały: ${xmr.xSignals.length}.`
    : '';
  const mrText = limits
    ? ` Średni rozstęp ${f(xmr.mrMean)}, granice ${f(0)} i ${f(limits.mr.upper)}. Sygnały: ${xmr.mrSignals.length}.`
    : '';
  const key = `${opts.key}|${xmr.points.map((p) => p.task.id).join(',')}`;
  sv.xmrCharts.render({
    key,
    xmr,
    unit,
    showFile: opts.showFile,
    describe: opts.describe,
    yTitle: { x: opts.valueTitle, mr: opts.mrTitle },
    aria: {
      x: n ? `Karta X: ${terms.count(n)} ${terms.order}.${limitsText} Strzałki przełączają punkty.` : `Karta X: brak ${terms.gen}.`,
      mr: n > 1 ? `Karta mR: ${rangesWord(n - 1)}.${mrText} Strzałki przełączają punkty.` : `Karta mR: za mało ${terms.gen} do obliczenia rozstępu.`,
    },
  });

  renderVariation(sv, { ...opts, xmr, key });
}

const RULE_NAMES = ['Punkt poza granicami procesu', 'Dwa z trzech poza 2σ', 'Cztery z pięciu poza 1σ', 'Osiem po jednej stronie średniej'];
const SIDE_TEXT = { high: 'powyżej średniej', low: 'poniżej średniej' };

/** Counts the points satisfying each rule inside the zoomed view (sv.hits holds them per rule). */
function renderVariationViewCounts(sv, view, zoomed) {
  sv.variationRoot.querySelectorAll('.variation-rule').forEach((box, idx) => {
    const hits = sv.hits[idx];
    let span = box.querySelector('.we-view-count');
    if (!span) {
      span = document.createElement('span');
      span.className = 'we-view-count';
      box.querySelector('.we-verdict').after(span);
    }
    const inView = hits ? hits.filter((i) => i >= view.start && i <= view.end).length : 0;
    span.hidden = !zoomed || !hits?.length;
    span.textContent = zoomed && hits?.length
      ? `W bieżącym widoku (${sv.terms.plural} ${view.start}–${view.end}): ${inView} z ${hits.length} ${sv.terms.inViewHits(hits.length)} regułę.`
      : '';
  });
}

function renderVariation(sv, { xmr, unit, valueTitle, variationTitle, showFile, scope, emptyText, key, describe }) {
  const { q, terms } = sv;
  const variation = computeVariation(xmr);
  const { zones } = variation;
  const { n, points } = xmr;
  const f = xmrFormat.fixed2;
  const unitText = unit ? ` ${unit}` : '';
  const ref = (i) => terms.ref(i, points[i - 1].task);

  q('variation-scope').textContent = scope && zones
    ? `Te same ${terms.plural}, średnia i granice ±3σ co na karcie X. Średnia ${f(zones.center)}, krok σ ${f(zones.sigma)}: ±1σ ${f(zones.low[1])} i ${f(zones.high[1])}, ±2σ ${f(zones.low[2])} i ${f(zones.high[2])}, ±3σ ${f(zones.lower)} i ${f(zones.upper)}. Każda reguła jest stosowana niezależnie.`
    : scope ? `Te same ${terms.plural} co na karcie X.` : '';

  // A point flagged by more than one rule → show the shared hint.
  const cover = new Map();
  variation.rules.forEach((rule) => {
    for (const ev of rule.events) for (let i = ev.start; i <= ev.end; i++) cover.set(i, (cover.get(i) || new Set()).add(rule.id));
  });
  q('variation-overlap').hidden = ![...cover.values()].some((s) => s.size > 1);

  sv.variationRoot.querySelectorAll('.variation-rule').forEach((box, idx) => {
    const rule = variation.rules[idx];
    const status = box.querySelector('.variation-status');
    status.hidden = !n || rule.status === 'ok';
    status.textContent = rule.status === 'no-limits' ? 'Brak podstaw do wyznaczenia stref sygnału'
      : rule.status === 'too-short' ? `Za mało ${terms.gen} do oceny tej reguły` : '';
    const empty = box.querySelector('.empty');
    empty.hidden = n > 0;
    empty.textContent = emptyText;

    const items = rule.events.map((ev) => {
      const last = points[ev.end - 1].task;
      if (rule.kind === 'run') {
        return `Sygnał do sprawdzenia: ${terms.series} ${ev.start}–${ev.end} (${terms.count(ev.end - ev.start + 1)}) ${SIDE_TEXT[ev.side]} ${f(zones.center)} – wykrycie przy ósmym punkcie: ${ref(ev.detectedAt)}, ${terms.dateTime(points[ev.detectedAt - 1].task)}; ${terms.lastOfRun(terms.dateTime(last))}.`;
      }
      if (rule.window === 1) {
        const p = points[ev.start - 1];
        const where = ev.side === 'high' ? `powyżej górnej granicy ${f(zones.upper)}` : `poniżej dolnej granicy ${f(zones.lower)}`;
        return `Sygnał do sprawdzenia: ${ref(ev.start)}, ${terms.dateTime(p.task)} – ${f(p.value)}${unitText}, ${SIDE_TEXT[ev.side]}, ${where}.`;
      }
      const k = rule.zone;
      const line = ev.side === 'high' ? `+${k}σ (${f(zones.high[k])})` : `−${k}σ (${f(zones.low[k])})`;
      return `Sygnał do sprawdzenia: ${terms.window} ${ev.start}–${ev.end}, ${terms.lastInWindow(terms.dateTime(last))} – ${ev.matched.length} z ${rule.window} ściśle ${ev.side === 'high' ? 'powyżej' : 'poniżej'} ${line}, ${SIDE_TEXT[ev.side]} (${terms.plural} ${ev.matched.join(', ')}).`;
    });
    const details = box.querySelector('.xmr-signals');
    details.hidden = !items.length || rule.window === 1;
    const count = items.length;
    details.querySelector('summary').textContent = rule.kind === 'run'
      ? `Szczegóły serii: ${count}`
      : `Szczegóły pasujących okien: ${count}`;
    details.querySelector('ul').replaceChildren(...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));

    renderVerdict(box, rule, idx);
  });

  function renderVerdict(box, rule, idx) {
    const badge = box.querySelector('.we-badge');
    const result = box.querySelector('.we-result');
    const verdict = box.querySelector('.we-verdict');
    const listTitle = box.querySelector('.we-list-title');
    const list = box.querySelector('.we-task-list');
    const hits = rule.status === 'ok' ? ruleTasks(rule) : [];
    sv.hits[idx] = rule.status === 'ok' ? hits.map((t) => t.index) : null;
    const state = !n ? null : rule.status !== 'ok' ? 'na' : hits.length ? 'hit' : 'none';
    box.classList.toggle('we-rule-hit', state === 'hit');
    box.classList.toggle('we-rule-none', state === 'none');
    badge.hidden = !state;
    badge.className = `we-badge we-badge-${state}`;
    badge.textContent = state === 'hit' ? '⚠ Zachodzi' : state === 'none' ? '✓ Nie zachodzi' : state === 'na' ? 'Nie da się ocenić' : '';
    result.hidden = state !== 'hit' && state !== 'none';
    result.className = `we-result we-result-${state}`;
    listTitle.hidden = state !== 'hit';
    list.hidden = state !== 'hit';
    list.replaceChildren();
    if (state !== 'hit' && state !== 'none') { verdict.textContent = ''; return; }

    const scopeText = `w wybranym zakresie (${terms.count(n)})`;
    if (state === 'none') {
      const values = points.map((p) => p.value);
      const near = ruleClosest(values, zones, rule);
      const lineOf = (side) => (side === 'high' ? `+${rule.zone}σ (${f(zones.high[rule.zone])})` : `−${rule.zone}σ (${f(zones.low[rule.zone])})`);
      let text;
      if (rule.kind === 'run') {
        text = `Reguła NIE zachodzi ${scopeText}: nie ma ośmiu kolejnych ${terms.gen} po jednej stronie średniej ${f(zones.center)}.`;
        if (near) text += ` Najdłuższa seria: ${terms.count(near.count)} ${SIDE_TEXT[near.side]} (nr ${near.start}–${near.end}).`;
      } else if (rule.window === 1) {
        text = `Reguła NIE zachodzi ${scopeText}: wszystkie ${terms.plural} mieszczą się w granicach procesu ${f(zones.lower)} – ${f(zones.upper)}.`;
      } else {
        text = `Reguła NIE zachodzi ${scopeText}: nie ma ${rule.window} kolejnych ${terms.gen}, z których co najmniej ${rule.need} przekraczają linię ${rule.zone}σ po tej samej stronie średniej.`;
        text += near
          ? ` Najbliżej: ${terms.plural} ${near.start}–${near.end} – ${near.count} z ${rule.window} ${near.side === 'high' ? 'powyżej' : 'poniżej'} ${lineOf(near.side)}.`
          : ` ${terms.noneBeyond} linii ±${rule.zone}σ.`;
      }
      verdict.textContent = text;
      return;
    }

    const what = rule.kind === 'run'
      ? `${rule.events.length} ${plural(rule.events.length, 'seria', 'serie', 'serii')} po jednej stronie średniej`
      : rule.window === 1 ? `${hits.length} ${plural(hits.length, 'punkt', 'punkty', 'punktów')} poza granicami procesu`
        : `${rule.events.length} ${plural(rule.events.length, 'pasujące okno', 'pasujące okna', 'pasujących okien')}`;
    verdict.textContent = `Reguła ZACHODZI ${scopeText}: ${what}. ${terms.satisfy(hits.length)} założenie – na wykresie mają czerwoną obwódkę, pozostałe punkty są przygaszone.`;
    listTitle.textContent = `${terms.Plural} spełniające regułę (${hits.length}):`;
    list.replaceChildren(...hits.map((h) => {
      const p = points[h.index - 1];
      const li = document.createElement('li');
      li.value = h.index;
      const strong = document.createElement('strong');
      strong.textContent = terms.Ref(h.index);
      const parts = [];
      if (p.task.taskId) parts.push(`ID ${p.task.taskId}`);
      parts.push(terms.dateTime(p.task), `${f(p.value)}${unitText}`, ...terms.extraParts(p.task));
      if (rule.kind === 'run') {
        const ev = h.events[0];
        parts.push(`seria ${ev.start}–${ev.end} ${SIDE_TEXT[h.side]}${ev.detectedAt === h.index ? ' – 8. punkt (moment wykrycia)' : ev.start === h.index ? ' – początek serii' : ''}`);
      } else if (rule.window === 1) {
        parts.push(h.side === 'high' ? `powyżej górnej granicy ${f(zones.upper)}` : `poniżej dolnej granicy ${f(zones.lower)}`);
      } else {
        const line = h.side === 'high' ? `powyżej +${rule.zone}σ (${f(zones.high[rule.zone])})` : `poniżej −${rule.zone}σ (${f(zones.low[rule.zone])})`;
        parts.push(`${line}, ${plural(h.events.length, 'okno', 'okna', 'okien')} ${h.events.map((e) => `${e.start}–${e.end}`).join(', ')}`);
      }
      li.append(strong, ` – ${parts.join(' · ')}`);
      if (rule.kind === 'run' && h.events[0].detectedAt === h.index) li.classList.add('we-detected');
      return li;
    }));
  }

  const ariaFor = (rule, i) => {
    if (!n) return `${RULE_NAMES[i]}: brak ${terms.gen}.`;
    if (rule.status === 'no-limits') return `${RULE_NAMES[i]}: brak podstaw do wyznaczenia stref sygnału.`;
    if (rule.status === 'too-short') return `${RULE_NAMES[i]}: za mało ${terms.gen} do oceny tej reguły.`;
    const what = rule.kind === 'run' ? 'Serie' : rule.window === 1 ? 'Punkty poza granicami' : 'Pasujące okna';
    return `${RULE_NAMES[i]}: ${terms.count(n)} ${terms.order}. ${what}: ${rule.events.length}. Strzałki przełączają punkty.`;
  };
  sv.variationCharts.render({
    key,
    xmr,
    variation,
    unit,
    showFile,
    describe,
    yTitle: variationTitle ?? valueTitle,
    aria: variation.rules.map(ariaFor),
  });
}

/** Lead-time XmR: the same filtered sample as the scatterplot. */
function renderLeadXmr({ sample, sizeText, rangeText, dropOutliers, removedCount, emptyText }) {
  const n = sample.length;
  const active = leadImports().filter((i) => selected.has(i.id) && !i.error);
  const skipped = active.flatMap((i) => i.skipped);
  const blank = skipped.filter((s) => s.reason === 'pusty wiersz').length;
  const invalid = skipped.length - blank;
  const files = active.length > 1 ? `, pliki: ${active.map((i) => `„${i.name}”`).join(', ')}` : '';
  const outliers = dropOutliers ? `, bez ${removedCount} ${plural(removedCount, 'wartości skrajnej', 'wartości skrajnych', 'wartości skrajnych')} (reguła Tukeya)` : '';
  const unit = pool.unit || 'dni';
  renderXmr(leadView, {
    sample,
    unit,
    valueTitle: pool.unit ? `Czas realizacji (${pool.unit})` : 'Czas realizacji',
    mrTitle: pool.unit ? `Rozstęp (${pool.unit})` : 'Rozstęp kroczący',
    variationTitle: `Czas realizacji (${unit})`,
    showFile: active.length > 1,
    skippedText: !active.length ? ''
      : `Pominięte rekordy: ${invalid} (brakująca lub niepoprawna data, rozmiar albo czas realizacji – np. ujemny lub nieliczbowy)${blank ? `; puste wiersze: ${blank}` : ''}.`,
    scope: range
      ? `Granice obliczono dla: ${sizeText}, okres ${rangeText}${outliers}${files} – ${tasksWord(n)}, ${rangesWord(Math.max(n - 1, 0))}. Zmiana filtrów przelicza karty od nowa.`
      : '',
    emptyText,
    key: `lead|${poolVersion}`,
  });
}

// ---------- Delivery rate (daily throughput) tab ----------

let deliveryDays = [];
let deliveryVersion = 0;
let deliveryDomain = null;
let deliveryRange = null;
let deliveryPeriods = [];
const tpStart = $('tp-date-start');
const tpEnd = $('tp-date-end');

/** Recombines the selected throughput files, keeping the chosen period when it still fits. */
function deliveryDataChanged() {
  deliveryDays = combineThroughput(throughputImports().filter((i) => selected.has(i.id) && !i.error));
  deliveryVersion++;
  const prev = deliveryDomain;
  deliveryDomain = deliveryDays.length ? { start: deliveryDays[0].date, end: deliveryDays.at(-1).date } : null;
  deliveryPeriods = deliveryDomain ? buildPeriods(deliveryDays) : [];
  const wasFull = !deliveryRange || !prev || (deliveryRange.start === prev.start && deliveryRange.end === prev.end);
  if (!deliveryDomain) deliveryRange = null;
  else if (wasFull) deliveryRange = { ...deliveryDomain };
  else {
    const start = Math.max(deliveryRange.start, deliveryDomain.start);
    const end = Math.min(deliveryRange.end, deliveryDomain.end);
    deliveryRange = start <= end ? { start, end } : { ...deliveryDomain };
  }

  const presets = $('tp-presets');
  presets.replaceChildren();
  for (const el of [tpStart, tpEnd]) {
    el.disabled = !deliveryDomain;
    if (deliveryDomain) { el.min = isoDay(deliveryDomain.start); el.max = isoDay(deliveryDomain.end); }
  }
  for (const p of deliveryPeriods) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = p.months ? `${p.months} mies.` : 'Cały okres';
    b.title = periodName(p);
    b.addEventListener('click', () => setDeliveryRange(p.start, p.end));
    presets.append(b);
  }
  renderDeliverySource();
  renderDelivery();
}

function setDeliveryRange(start, end, moved = 'start') {
  if (!deliveryDomain) return;
  start = Math.min(Math.max(start, deliveryDomain.start), deliveryDomain.end);
  end = Math.min(Math.max(end, deliveryDomain.start), deliveryDomain.end);
  if (start > end) { if (moved === 'start') start = end; else end = start; }
  deliveryRange = { start, end };
  renderDelivery();
}

tpStart.addEventListener('change', () => {
  const t = parseDateInput(tpStart.value);
  if (t === null || !deliveryRange) renderDelivery(); else setDeliveryRange(t, deliveryRange.end, 'start');
});
tpEnd.addEventListener('change', () => {
  const t = parseDateInput(tpEnd.value);
  if (t === null || !deliveryRange) renderDelivery(); else setDeliveryRange(deliveryRange.start, t, 'end');
});
$('tp-weekends').addEventListener('change', () => renderDelivery());

function renderDeliverySource() {
  const box = $('tp-source');
  box.replaceChildren();
  const active = throughputImports().filter((i) => selected.has(i.id) && !i.error);
  if (!active.length) { box.textContent = loaded ? 'Nie wybrano żadnego pliku przepustowości.' : 'Wczytywanie danych…'; return; }
  for (const imp of active) {
    const p = document.createElement('div');
    p.append(`Źródło: „${imp.name}”${imp.sheetName ? ` (arkusz „${imp.sheetName}”)` : ''}. Wczytano ${daysWord(imp.days.length)}, pominięto ${imp.skipped.length} ${plural(imp.skipped.length, 'wiersz', 'wiersze', 'wierszy')} (puste, błędne lub z powtórzoną datą).`);
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

function renderDelivery() {
  const skipWeekends = $('tp-weekends').checked;
  const inRange = deliveryRange ? selectDays(deliveryDays, deliveryRange) : [];
  const sample = skipWeekends ? selectDays(inRange, null, { skipWeekends }) : inRange;
  const n = sample.length;
  const weekendCount = inRange.length - n;
  const active = throughputImports().filter((i) => selected.has(i.id) && !i.error);
  const rangeText = deliveryRange ? `${format.date(deliveryRange.start)} – ${format.date(deliveryRange.end)}` : 'brak okresu';
  const total = sample.reduce((s, d) => s + d.lead, 0);

  if (deliveryRange) {
    tpStart.value = isoDay(deliveryRange.start);
    tpEnd.value = isoDay(deliveryRange.end);
  }
  const match = deliveryPeriods.find((p) => deliveryRange && p.start === deliveryRange.start && p.end === deliveryRange.end);
  [...$('tp-presets').children].forEach((b, i) => b.setAttribute('aria-pressed', String(deliveryPeriods[i] === match)));
  $('tp-period-name').textContent = !deliveryRange ? '–' : match ? periodName(match) : 'Własny zakres';
  $('tp-period-range').textContent = deliveryRange
    ? `${rangeText} · ${daysWord(n)} w próbie${weekendCount ? ` (pominięto ${weekendCount} ${plural(weekendCount, 'dzień weekendowy', 'dni weekendowe', 'dni weekendowych')})` : ''} · dostarczono ${tasksWord(total)}`
    : '';

  const skipped = active.flatMap((i) => i.skipped);
  const blank = skipped.filter((s) => s.reason === 'pusty wiersz').length;
  const files = active.length > 1 ? `, pliki: ${active.map((i) => `„${i.name}”`).join(', ')} (wartości z tego samego dnia zsumowane)` : '';
  const emptyText = !loaded ? 'Wczytywanie danych…'
    : !throughputImports().length ? 'Brak pliku przepustowości (kolumny „Data” i „Przepustowość”).'
      : !active.length ? 'Nie wybrano żadnego pliku przepustowości.'
        : !deliveryDays.length ? 'Wybrane pliki nie zawierają poprawnych dni.'
          : 'Brak dni w wybranym okresie.';
  renderXmr(deliveryView, {
    sample,
    unit: 'zad.',
    valueTitle: 'Dostarczone zadania (na dzień)',
    mrTitle: 'Rozstęp kroczący (zadania)',
    showFile: active.length > 1,
    describe: DAY_DESCRIBE,
    skippedText: !active.length ? ''
      : `Pominięte rekordy: ${skipped.length - blank} (brakująca lub niepoprawna data albo przepustowość, powtórzona data)${blank ? `; puste wiersze: ${blank}` : ''}.`,
    scope: deliveryRange
      ? `Granice obliczono dla: okres ${rangeText}${skipWeekends ? ', bez sobót i niedziel' : ''}${files} – ${daysWord(n)}, ${rangesWord(Math.max(n - 1, 0))}. Zmiana filtrów przelicza karty od nowa.`
      : '',
    emptyText,
    key: `delivery|${deliveryVersion}|${skipWeekends}`,
  });
}

document.querySelectorAll('input[name="size"]').forEach((r) => r.addEventListener('change', () => update()));
$('excluded-clear').addEventListener('click', () => {
  excludedKeys.clear();
  update();
  $('chart').querySelector('svg').focus();
});
$('outliers').addEventListener('change', () => update());
$('files-all').addEventListener('click', () => {
  leadImports().filter((i) => !i.error).forEach((i) => selected.add(i.id));
  renderFiles();
  dataChanged();
});
$('files-none').addEventListener('click', () => {
  leadImports().forEach((i) => selected.delete(i.id));
  renderFiles();
  dataChanged();
});
// Both upload buttons accept either kind of file; each file goes to the tab matching its columns.
async function uploadFiles(e) {
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
  deliveryDataChanged();
}
$('file-upload').addEventListener('change', uploadFiles);
$('tp-file-upload').addEventListener('change', uploadFiles);
onMethodChange = () => update();

async function load() {
  const names = await listRepoFiles();
  const results = await Promise.all(names.map((name) => parseImport(name, 'repo', () => fetchRepoFile(name))));
  imports.push(...results);
  for (const imp of results) if (!imp.error) selected.add(imp.id);
  loaded = true;
  renderFiles();
  dataChanged();
  deliveryDataChanged();
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
renderDelivery();
load();
