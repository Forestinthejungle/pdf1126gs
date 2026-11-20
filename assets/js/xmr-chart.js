// Two synchronised SVG control charts (X on top, mR below) sharing one task-number axis and one zoom.
// The charts only draw a precomputed model: zooming changes the visible range, never the limits.
import { el, niceStep, shapePath } from './chart.js';

const LINE_NAMES = {
  x: {
    upper: ['Górna granica', 'Górna gr.'],
    center: ['Średnia', 'Średnia'],
    lower: ['Dolna granica', 'Dolna gr.'],
  },
  mr: {
    upper: ['Górna granica (URL)', 'URL'],
    center: ['Średni rozstęp', 'Średni mR'],
    lower: ['Dolna granica (LRL)', 'LRL'],
  },
};

let clipSeq = 0;

/** Default wording for lead-time tasks; a model may override any field via model.describe. */
export const TASK_DESCRIBE = {
  xTitle: 'Nr zadania (kolejność ukończenia)',
  title: (index) => `Zadanie nr ${index}`,
  runText: 'Seria zadań',
  detectText: 'wykrycie przy zadaniu',
  rangeTitle: (a, b) => `Rozstęp kroczący: zadania ${a} i ${b}`,
  lines: (item, { format, unit, showFile }) => {
    const t = item.task;
    const lines = [`Data ukończenia: ${format.dateTime(t)}`, `Czas realizacji: ${format.fixed2(item.value)}${unit}`, `Rozmiar: ${t.size}`];
    if (t.taskId) lines.push(`ID zadania: ${t.taskId}`);
    if (showFile && t.file) lines.push(`Plik: ${t.file}`);
    return lines;
  },
  pair: (no, t, { format, unit }) => `Zadanie ${no}${t.taskId ? ` (ID ${t.taskId})` : ''}: ${format.dateTime(t)}, ${format.fixed2(t.lead)}${unit}`,
};

/**
 * model: { key, xmr (computeXmR result), yTitle: { x, mr }, unit, showFile, aria: { x, mr }, describe? }
 * format: { number, fixed2, dateTime(task) }
 */
export function createXmrCharts({ xContainer, mrContainer, format, onActive, onViewChange }) {
  let model = null;
  let view = null; // { start, end } inclusive task numbers
  let active = -1; // task number highlighted in both charts
  let activePanel = null;
  let brush = null;

  function makePanel(kind, container) {
    const svg = el('svg', { class: 'plot xmr-plot', tabindex: '0', role: 'group', 'aria-roledescription': 'karta kontrolna' });
    container.prepend(svg);
    return { kind, container, svg, tooltip: container.querySelector('.tooltip'), clipId: `xmr-clip-${clipSeq++}`, nodes: new Map(), guide: null, brushRect: null, geo: null };
  }
  const panels = [makePanel('x', xContainer), makePanel('mr', mrContainer)];
  const itemsOf = (kind) => (!model ? [] : kind === 'x' ? model.xmr.points : model.xmr.ranges);
  const taskCount = () => model?.xmr.n || 0;
  const describe = () => ({ ...TASK_DESCRIBE, ...model?.describe });

  function renderPanel(panel) {
    const { svg, container, kind } = panel;
    const W = container.clientWidth;
    const H = container.clientHeight;
    panel.nodes = new Map();
    panel.guide = null;
    svg.replaceChildren();
    if (!W || !H) { panel.geo = null; return; }
    const narrow = W < 560;
    const m = { top: 14, right: narrow ? 78 : 138, bottom: 44, left: narrow ? 46 : 62 };
    const iw = Math.max(W - m.left - m.right, 50);
    const ih = Math.max(H - m.top - m.bottom, 40);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', model ? model.aria[kind] : '');

    const n = taskCount();
    const v = view || { start: 1, end: Math.max(n, 1) };
    const dx0 = v.start - 0.5;
    const dx1 = v.end + 0.5;
    const x = (i) => m.left + ((i - dx0) / (dx1 - dx0)) * iw;
    const list = itemsOf(kind);
    const lim = model?.xmr.limits?.[kind] || null;
    // The vertical scale depends on the whole series and its limits, so it stays fixed while zooming.
    const yMax = Math.max(1, ...list.map((p) => p.value), lim ? lim.upper : 0);
    const yStep = niceStep(yMax, Math.max(3, Math.round(ih / 45)));
    const yTop = Math.max(yStep, Math.ceil((yMax * 1.06) / yStep) * yStep);
    const y = (val) => m.top + ih - (val / yTop) * ih;
    panel.geo = { m, iw, ih, x, dx0, dx1, W };

    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: panel.clipId }, defs);
    el('rect', { x: m.left, y: m.top - 10, width: iw, height: ih + 20 }, clip);

    const grid = el('g', { class: 'grid' }, svg);
    const yAxis = el('g', { class: 'axis' }, svg);
    for (let k = 0; k * yStep <= yTop + 1e-9; k++) {
      const val = k * yStep;
      el('line', { x1: m.left, x2: m.left + iw, y1: y(val), y2: y(val) }, grid);
      const text = el('text', { x: m.left - 8, y: y(val), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, el('g', { class: 'tick' }, yAxis));
      text.textContent = format.number(val);
    }
    const xAxis = el('g', { class: 'axis' }, svg);
    el('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih }, xAxis);
    el('line', { x1: m.left, x2: m.left, y1: m.top, y2: m.top + ih }, yAxis);
    if (n) {
      const xStep = Math.max(1, Math.ceil(niceStep(dx1 - dx0, Math.max(2, Math.floor(iw / (narrow ? 40 : 56))))));
      for (let t = Math.ceil(v.start / xStep) * xStep; t <= v.end; t += xStep) {
        if (t < 1) continue;
        el('line', { x1: x(t), x2: x(t), y1: m.top + ih, y2: m.top + ih + 5 }, xAxis);
        const text = el('text', { x: x(t), y: m.top + ih + 18, 'text-anchor': 'middle' }, el('g', { class: 'tick' }, xAxis));
        text.textContent = String(t);
      }
    }
    const xt = el('text', { class: 'axis-title', x: m.left + iw / 2, y: m.top + ih + 38, 'text-anchor': 'middle' }, svg);
    xt.textContent = describe().xTitle;
    const yt = el('text', { class: 'axis-title', transform: `translate(14 ${m.top + ih / 2}) rotate(-90)`, 'text-anchor': 'middle' }, svg);
    yt.textContent = model ? model.yTitle[kind] : '';
    el('rect', { class: 'plot-frame', x: m.left, y: m.top, width: iw, height: ih }, svg);

    // Centre line and limits with direct two-line labels in the right margin, nudged apart when they collide.
    if (lim) {
      const lg = el('g', { class: 'xmr-lines' }, svg);
      const names = LINE_NAMES[kind];
      const labels = [];
      let offscale = null;
      for (const key of ['upper', 'center', 'lower']) {
        const val = lim[key];
        const cls = key === 'center' ? 'xmr-center' : 'xmr-limit';
        if (val < 0) { offscale = val; continue; }
        el('line', { class: `xmr-line ${cls}`, x1: m.left, x2: m.left + iw, y1: y(val), y2: y(val) }, lg);
        labels.push({ cls, val, name: names[key][narrow ? 1 : 0], py: y(val), ty: y(val) });
      }
      labels.sort((a, b) => b.py - a.py);
      for (let i = 1; i < labels.length; i++) labels[i].ty = Math.min(labels[i].ty, labels[i - 1].ty - 28);
      const overflow = m.top + 8 - Math.min(...labels.map((l) => l.ty - 7), Infinity);
      if (overflow > 0) labels.forEach((l) => { l.ty += overflow; });
      for (const l of labels) {
        const t = el('text', { class: `xmr-label ${l.cls}`, x: m.left + iw + 6, y: l.ty - 7, 'dominant-baseline': 'middle' }, lg);
        t.append(l.name);
        const value = el('tspan', { class: 'xmr-label-value', x: m.left + iw + 6, dy: '1.2em' }, t);
        value.textContent = format.fixed2(l.val);
      }
      if (offscale !== null) {
        const t = el('text', { class: 'xmr-offscale', x: m.left + 8, y: m.top + ih - 8 }, lg);
        t.textContent = `↓ ${names.lower[0]}: ${format.fixed2(offscale)} – poniżej zakresu wykresu`;
      }
    }

    const series = el('g', { class: 'xmr-series', 'clip-path': `url(#${panel.clipId})` }, svg);
    const visible = list.filter((p) => p.index >= v.start - 1 && p.index <= v.end + 1);
    if (visible.length > 1) {
      el('polyline', { class: 'xmr-path', points: visible.map((p) => `${x(p.index)},${y(p.value)}`).join(' ') }, series);
    }
    panel.guide = el('line', { class: 'xmr-guide', y1: m.top, y2: m.top + ih, visibility: 'hidden' }, series);
    const r = narrow ? 4.5 : 5.5;
    for (const p of visible) {
      const cx = x(p.index);
      const cy = y(p.value);
      const g = el('g', { class: `marker-group${p.signal ? ' signal' : ''}`, transform: `translate(${cx} ${cy})` }, series);
      if (p.signal) el('circle', { class: 'signal-ring', r: r + 4 }, g);
      if (kind === 'x') el('path', { class: 'marker', 'data-shape': p.task.size, d: shapePath(p.task.size, r) }, g);
      else el('circle', { class: 'marker mr-marker', r: r * 0.85 }, g);
      panel.nodes.set(p.index, { node: g, cx, cy, item: p });
    }
    panel.brushRect = el('rect', { class: 'xmr-brush', y: m.top, height: ih, x: 0, width: 0, visibility: 'hidden' }, svg);
  }

  function tooltipLines(kind, item) {
    const unit = model.unit ? ` ${model.unit}` : '';
    const lim = model.xmr.limits?.[kind];
    const d = describe();
    const opts = { format, unit, showFile: model.showFile };
    let title;
    let lines;
    if (kind === 'x') {
      title = d.title(item.index);
      lines = d.lines(item, opts);
    } else {
      title = d.rangeTitle(item.index - 1, item.index);
      lines = [[item.index - 1, item.from], [item.index, item.to]].map(([no, t]) => d.pair(no, t, opts));
      lines.push(`Bezwzględna różnica: ${format.fixed2(item.value)}${unit}`);
    }
    if (item.signal && lim) {
      const where = item.signal === 'high' ? `powyżej górnej granicy ${format.fixed2(lim.upper)}` : `poniżej dolnej granicy ${format.fixed2(lim.lower)}`;
      lines.push({ signal: `Sygnał do sprawdzenia: ${where}` });
    }
    return { title, lines };
  }

  function applyActive(panel) {
    for (const [idx, e] of panel.nodes) e.node.classList.toggle('active', idx === active);
    if (!panel.guide || !panel.geo) return;
    const show = active >= 1 && view && active >= view.start && active <= view.end;
    panel.guide.setAttribute('visibility', show ? 'visible' : 'hidden');
    if (show) {
      const gx = panel.geo.x(active);
      panel.guide.setAttribute('x1', gx);
      panel.guide.setAttribute('x2', gx);
    }
  }

  function highlight(index, panel, announce = true) {
    active = index;
    activePanel = index >= 0 ? panel : null;
    for (const p of panels) { applyActive(p); p.tooltip.hidden = true; }
    const e = index >= 0 && panel ? panel.nodes.get(index) : null;
    if (!e) return;
    const { title, lines } = tooltipLines(panel.kind, e.item);
    const tip = panel.tooltip;
    tip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = title;
    tip.append(strong);
    lines.forEach((line, i) => {
      if (i) tip.append(document.createElement('br'));
      if (typeof line === 'string') tip.append(line);
      else {
        const s = document.createElement('span');
        s.className = 'tooltip-signal';
        s.textContent = line.signal;
        tip.append(s);
      }
    });
    tip.hidden = false;
    const W = panel.container.clientWidth;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = e.cx + 12;
    if (left + tw > W - 4) left = e.cx - tw - 12;
    let top = e.cy - th - 10;
    if (top < 4) top = e.cy + 12;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${top}px`;
    if (announce) onActive?.([title, ...lines.map((l) => (typeof l === 'string' ? l : l.signal))].join(', '));
  }

  function renderAll() {
    panels.forEach(renderPanel);
    if (active >= 0) highlight(active, activePanel, false);
    else panels.forEach(applyActive);
  }

  function setView(start, end) {
    const n = taskCount();
    if (n < 2) view = { start: 1, end: Math.max(n, 1) };
    else {
      let s = Math.round(start);
      let e = Math.round(end);
      if (e - s < 1) { s = Math.floor((s + e) / 2); e = s + 1; }
      const span = e - s;
      if (s < 1) { s = 1; e = Math.min(n, 1 + span); }
      if (e > n) { e = n; s = Math.max(1, n - span); }
      view = { start: s, end: e };
    }
    renderAll();
    onViewChange?.({ ...view }, n);
  }

  function zoom(action) {
    const n = taskCount();
    if (!view || n < 2) return;
    const span = view.end - view.start;
    const c = (view.start + view.end) / 2;
    if (action === 'in') {
      if (span <= 1) return;
      const half = Math.max(0.5, span / 4);
      setView(Math.round(c - half), Math.round(c - half) + Math.max(1, Math.round(half * 2)));
    } else if (action === 'out') setView(Math.round(c - span), Math.round(c - span) + span * 2);
    else if (action === 'left' || action === 'right') {
      const shift = Math.max(1, Math.round(span / 2)) * (action === 'left' ? -1 : 1);
      setView(view.start + shift, view.end + shift);
    } else setView(1, n);
  }

  function localX(panel, evt) {
    return evt.clientX - panel.svg.getBoundingClientRect().left;
  }

  function indexAt(panel, evt) {
    if (!panel.geo) return -1;
    const rect = panel.svg.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    const { m, iw, ih, dx0, dx1 } = panel.geo;
    if (px < m.left || px > m.left + iw || py < m.top - 12 || py > m.top + ih + 12) return -1;
    const i = Math.round(dx0 + ((px - m.left) / iw) * (dx1 - dx0));
    return panel.nodes.has(i) ? i : -1;
  }

  for (const panel of panels) {
    const { svg } = panel;
    const clampX = (px) => Math.min(Math.max(px, panel.geo.m.left), panel.geo.m.left + panel.geo.iw);
    svg.addEventListener('pointerdown', (e) => {
      if (!taskCount() || !panel.geo) return;
      if (e.pointerType !== 'mouse') { highlight(indexAt(panel, e), panel, false); return; }
      if (e.button !== 0 || taskCount() < 2) return;
      const px = localX(panel, e);
      if (px < panel.geo.m.left || px > panel.geo.m.left + panel.geo.iw) return;
      brush = { panel, x0: px, x1: px };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (brush && brush.panel === panel) {
        brush.x1 = clampX(localX(panel, e));
        const left = Math.min(brush.x0, brush.x1);
        panel.brushRect.setAttribute('x', left);
        panel.brushRect.setAttribute('width', Math.abs(brush.x1 - brush.x0));
        panel.brushRect.setAttribute('visibility', 'visible');
        return;
      }
      if (e.pointerType === 'mouse' && !brush) highlight(indexAt(panel, e), panel, false);
    });
    const endBrush = () => {
      if (!brush || brush.panel !== panel) return;
      const { x0, x1 } = brush;
      brush = null;
      panel.brushRect.setAttribute('visibility', 'hidden');
      if (Math.abs(x1 - x0) < 6) return;
      const { m, iw, dx0, dx1 } = panel.geo;
      const toIndex = (px) => dx0 + ((px - m.left) / iw) * (dx1 - dx0);
      highlight(-1);
      setView(Math.ceil(toIndex(Math.min(x0, x1))), Math.floor(toIndex(Math.max(x0, x1))));
    };
    svg.addEventListener('pointerup', endBrush);
    svg.addEventListener('pointercancel', endBrush);
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !brush) highlight(-1);
    });
    svg.addEventListener('dblclick', () => zoom('reset'));
    svg.addEventListener('keydown', (e) => {
      const zoomKeys = { '+': 'in', '=': 'in', '-': 'out', 0: 'reset' };
      if (e.key in zoomKeys) { e.preventDefault(); zoom(zoomKeys[e.key]); return; }
      const indices = itemsOf(panel.kind).map((p) => p.index);
      if (!indices.length) return;
      if (e.key === 'Escape') { highlight(-1); return; }
      const pos = indices.indexOf(active);
      const last = indices.length - 1;
      const target = {
        ArrowRight: pos < 0 ? 0 : Math.min(pos + 1, last),
        ArrowUp: pos < 0 ? 0 : Math.min(pos + 1, last),
        ArrowLeft: pos < 0 ? 0 : Math.max(pos - 1, 0),
        ArrowDown: pos < 0 ? 0 : Math.max(pos - 1, 0),
        Home: 0,
        End: last,
      }[e.key];
      if (target === undefined) return;
      e.preventDefault();
      const idx = indices[target];
      // Keyboard navigation pans the zoomed view so the selected point stays visible.
      if (idx < view.start) setView(idx, idx + (view.end - view.start));
      else if (idx > view.end) setView(idx - (view.end - view.start), idx);
      highlight(idx, panel);
    });
    svg.addEventListener('blur', () => { if (activePanel === panel) highlight(-1); });
  }

  const ro = new ResizeObserver(() => renderAll());
  panels.forEach((p) => ro.observe(p.container));

  return {
    /** Draws a new model; the zoom is kept only when the series itself is unchanged (same key). */
    render(next) {
      const sameSeries = model && view && next.key === model.key;
      model = next;
      active = -1;
      activePanel = null;
      panels.forEach((p) => { p.tooltip.hidden = true; });
      const n = taskCount();
      setView(sameSeries ? view.start : 1, sameSeries ? view.end : Math.max(n, 1));
    },
    zoom,
    getView: () => (view ? { ...view } : null),
  };
}
