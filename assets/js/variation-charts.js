// Four stacked Western Electric charts on the X-chart series ("Zrozumienie zmienności").
// They share one task-number axis, one Y scale (the same as the X chart) and one zoom; zooming never
// changes the series, the limits or the detected signals.
import { el, niceStep, shapePath } from './chart.js';

let clipSeq = 0;

const SIDE = { high: 'powyżej średniej', low: 'poniżej średniej' };

/**
 * model: { key, xmr, variation (computeVariation result), unit, yTitle, showFile, aria: [4 strings] }
 * format: { number, fixed2, dateTime(task) }
 */
export function createVariationCharts({ containers, format, onActive, onViewChange }) {
  let model = null;
  let view = null;
  let active = -1;
  let activePanel = null;
  let brush = null;

  const panels = containers.map((container, i) => {
    const svg = el('svg', { class: 'plot xmr-plot', tabindex: '0', role: 'group', 'aria-roledescription': 'wykres reguły' });
    container.prepend(svg);
    return { rule: i, container, svg, tooltip: container.querySelector('.tooltip'), clipId: `we-clip-${clipSeq++}`, nodes: new Map(), guide: null, brushRect: null, geo: null };
  });
  const points = () => model?.xmr.points || [];
  const taskCount = () => model?.xmr.n || 0;
  const ruleOf = (panel) => model?.variation.rules[panel.rule];

  /** Per task: the events of this rule it belongs to, and whether it is a "strong" point. */
  function membership(rule) {
    const map = new Map();
    for (const ev of rule?.events || []) {
      for (let i = ev.start; i <= ev.end; i++) {
        if (!map.has(i)) map.set(i, { events: [], matched: new Set() });
        const m = map.get(i);
        m.events.push(ev);
        if (ev.matched.includes(i) && (rule.kind !== 'run' || i === ev.detectedAt)) m.matched.add(ev.side);
      }
    }
    return map;
  }

  /** Merges overlapping/adjacent windows of the same side into bands, so overlaps stay "delicate". */
  function bands(events) {
    const out = [];
    for (const side of ['high', 'low']) {
      const list = events.filter((e) => e.side === side).sort((a, b) => a.start - b.start);
      for (const e of list) {
        const last = out.at(-1);
        if (last && last.side === side && e.start <= last.end + 1) last.end = Math.max(last.end, e.end);
        else out.push({ side, start: e.start, end: e.end });
      }
    }
    return out;
  }

  function renderPanel(panel) {
    const { svg, container } = panel;
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
    svg.setAttribute('aria-label', model ? model.aria[panel.rule] : '');

    const n = taskCount();
    const v = view || { start: 1, end: Math.max(n, 1) };
    const dx0 = v.start - 0.5;
    const dx1 = v.end + 0.5;
    const x = (i) => m.left + ((i - dx0) / (dx1 - dx0)) * iw;
    const list = points();
    const lim = model?.xmr.limits?.x || null;
    const zones = model?.variation.zones || null;
    const rule = ruleOf(panel);
    // Same vertical scale as the X chart: whole series and its upper limit, fixed while zooming.
    const yMax = Math.max(1, ...list.map((p) => p.value), lim ? lim.upper : 0);
    const yStep = niceStep(yMax, Math.max(3, Math.round(ih / 45)));
    const yTop = Math.max(yStep, Math.ceil((yMax * 1.06) / yStep) * yStep);
    const y = (val) => m.top + ih - (val / yTop) * ih;
    panel.geo = { m, iw, ih, x, dx0, dx1 };

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
    xt.textContent = 'Nr zadania (kolejność ukończenia)';
    const yt = el('text', { class: 'axis-title', transform: `translate(14 ${m.top + ih / 2}) rotate(-90)`, 'text-anchor': 'middle' }, svg);
    yt.textContent = model ? model.yTitle : '';
    el('rect', { class: 'plot-frame', x: m.left, y: m.top, width: iw, height: ih }, svg);

    // Matching windows / runs as light bands behind the points.
    const bandLayer = el('g', { class: 'we-bands', 'clip-path': `url(#${panel.clipId})` }, svg);
    if (rule?.events.length && !(rule.kind === 'window' && rule.window === 1)) {
      for (const b of bands(rule.events)) {
        if (b.end < v.start - 1 || b.start > v.end + 1) continue;
        el('rect', { class: `we-band we-band-${b.side}`, x: x(b.start - 0.5), width: x(b.end + 0.5) - x(b.start - 0.5), y: m.top, height: ih }, bandLayer);
      }
    }

    // Reference lines: mean, ±3σ (X-chart limits) and the rule's own ±kσ lines, with right-margin labels.
    const lg = el('g', { class: 'xmr-lines' }, svg);
    const offscale = [];
    if (lim) {
      const lines = [
        { key: 'upper', val: lim.upper, cls: 'xmr-limit', name: ['Górna granica (+3σ)', '+3σ'] },
        { key: 'center', val: lim.center, cls: 'xmr-center', name: ['Średnia', 'Średnia'] },
        { key: 'lower', val: lim.lower, cls: 'xmr-limit', name: ['Dolna granica (−3σ)', '−3σ'] },
      ];
      const k = rule?.kind === 'window' && rule.zone < 3 ? rule.zone : 0;
      if (zones && k) {
        lines.push({ val: zones.high[k], cls: 'we-zone', name: [`+${k}σ`, `+${k}σ`] });
        lines.push({ val: zones.low[k], cls: 'we-zone', name: [`−${k}σ`, `−${k}σ`] });
      }
      const labels = [];
      for (const l of lines) {
        if (l.val < 0) { offscale.push(`${l.name[0]}: ${format.fixed2(l.val)}`); continue; }
        el('line', { class: `xmr-line ${l.cls}`, x1: m.left, x2: m.left + iw, y1: y(l.val), y2: y(l.val) }, lg);
        labels.push({ ...l, py: y(l.val), ty: y(l.val) });
      }
      labels.sort((a, b) => b.py - a.py);
      for (let i = 1; i < labels.length; i++) labels[i].ty = Math.min(labels[i].ty, labels[i - 1].ty - 28);
      const overflow = m.top + 8 - Math.min(...labels.map((l) => l.ty - 7), Infinity);
      if (overflow > 0) labels.forEach((l) => { l.ty += overflow; });
      for (const l of labels) {
        const t = el('text', { class: `xmr-label ${l.cls}`, x: m.left + iw + 6, y: l.ty - 7, 'dominant-baseline': 'middle' }, lg);
        t.append(l.name[narrow ? 1 : 0]);
        const value = el('tspan', { class: 'xmr-label-value', x: m.left + iw + 6, dy: '1.2em' }, t);
        value.textContent = format.fixed2(l.val);
      }
      if (offscale.length) {
        const t = el('text', { class: 'xmr-offscale', x: m.left + 8, y: m.top + ih - 8 }, lg);
        t.textContent = `↓ ${offscale.join('; ')} – poniżej zakresu wykresu`;
      }
    }

    const series = el('g', { class: 'xmr-series', 'clip-path': `url(#${panel.clipId})` }, svg);
    const visible = list.filter((p) => p.index >= v.start - 1 && p.index <= v.end + 1);
    if (visible.length > 1) {
      el('polyline', { class: 'xmr-path', points: visible.map((p) => `${x(p.index)},${y(p.value)}`).join(' ') }, series);
    }
    panel.guide = el('line', { class: 'xmr-guide', y1: m.top, y2: m.top + ih, visibility: 'hidden' }, series);
    const member = membership(rule);
    const r = narrow ? 4.5 : 5.5;
    for (const p of visible) {
      const cx = x(p.index);
      const cy = y(p.value);
      const info = member.get(p.index);
      const strong = info?.matched.size > 0;
      const cls = `marker-group${strong ? ' signal' : info ? ' we-in-window' : ''}`;
      const g = el('g', { class: cls, transform: `translate(${cx} ${cy})` }, series);
      if (strong) el('circle', { class: 'signal-ring', r: r + 4 }, g);
      el('path', { class: 'marker', 'data-shape': p.task.size, d: shapePath(p.task.size, r) }, g);
      if (rule?.kind === 'run' && info?.events.some((e) => e.detectedAt === p.index)) {
        const t = el('text', { class: 'we-detect-label', y: -(r + 9), 'text-anchor': 'middle' }, g);
        t.textContent = '8.';
      }
      panel.nodes.set(p.index, { node: g, cx, cy, item: p, info });
    }
    panel.brushRect = el('rect', { class: 'xmr-brush', y: m.top, height: ih, x: 0, width: 0, visibility: 'hidden' }, svg);
  }

  /** Rules (other than this panel's) whose events cover the task. */
  function otherRules(index, ruleIdx) {
    return model.variation.rules
      .filter((r, i) => i !== ruleIdx && r.events.some((e) => index >= e.start && index <= e.end))
      .map((r) => r.id);
  }

  function signalLines(panel, item, info) {
    const rule = ruleOf(panel);
    const zones = model.variation.zones;
    const out = [];
    if (!info) return out;
    const f = format.fixed2;
    if (rule.kind === 'run') {
      for (const ev of info.events) {
        out.push({ signal: `Sygnał do sprawdzenia: ${SIDE[ev.side]}` });
        out.push(`Seria zadań ${ev.start}–${ev.end} (${ev.end - ev.start + 1}) ${SIDE[ev.side]}, wykrycie przy zadaniu ${ev.detectedAt}${item.index === ev.detectedAt ? ' (ten punkt)' : ''}`);
      }
      return out;
    }
    if (rule.window === 1) {
      const ev = info.events[0];
      const where = ev.side === 'high' ? `powyżej górnej granicy ${f(zones.upper)}` : `poniżej dolnej granicy ${f(zones.lower)}`;
      out.push({ signal: `Sygnał do sprawdzenia: ${SIDE[ev.side]}, ${where}` });
      return out;
    }
    const k = rule.zone;
    for (const side of ['high', 'low']) {
      const evs = info.events.filter((e) => e.side === side);
      if (!evs.length) continue;
      const line = side === 'high' ? `+${k}σ (${f(zones.high[k])})` : `−${k}σ (${f(zones.low[k])})`;
      out.push({ signal: `Sygnał do sprawdzenia: ${SIDE[side]}` });
      out.push(info.matched.has(side) ? `Punkt ściśle ${side === 'high' ? 'powyżej' : 'poniżej'} ${line}` : `Punkt w pasującym oknie, nie przekracza ${line}`);
      out.push(`Pasujące okna: ${evs.map((e) => `${e.start}–${e.end}`).join(', ')}`);
    }
    return out;
  }

  function tooltipLines(panel, e) {
    const unit = model.unit ? ` ${model.unit}` : '';
    const t = e.item.task;
    const lines = [
      `Data ukończenia: ${format.dateTime(t)}`,
      `Czas realizacji: ${format.fixed2(e.item.value)}${unit}`,
      `Rozmiar: ${t.size}`,
    ];
    if (t.taskId) lines.push(`ID zadania: ${t.taskId}`);
    if (model.showFile && t.file) lines.push(`Plik: ${t.file}`);
    if (t.contextChange) lines.push(`Zmiana kontekstu: ${t.contextChange}`);
    if (t.comment) lines.push(`Komentarz: ${t.comment}`);
    lines.push(...signalLines(panel, e.item, e.info));
    if (e.info) {
      const others = otherRules(e.item.index, panel.rule);
      if (others.length) lines.push(`Kilka reguł może wskazać ten sam fragment procesu (także reguła ${others.join(', ')}).`);
    }
    return { title: `Zadanie nr ${e.item.index}`, lines };
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
    const { title, lines } = tooltipLines(panel, e);
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

  const localX = (panel, evt) => evt.clientX - panel.svg.getBoundingClientRect().left;

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
        panel.brushRect.setAttribute('x', Math.min(brush.x0, brush.x1));
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
      const indices = points().map((p) => p.index);
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
  };
}
