// SVG scatterplot renderer for the lead-time dashboard (no external libraries).

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

/** Marker paths with roughly equal area so no size looks more important. */
export function shapePath(size, r = 5) {
  if (size === 'M') {
    const h = r * 0.886;
    return `M${-h},${-h}H${h}V${h}H${-h}Z`;
  }
  if (size === 'L') {
    const s = r * 1.35;
    return `M0,${-s}L${s * 0.866},${s * 0.5}L${-s * 0.866},${s * 0.5}Z`;
  }
  return `M${r},0A${r},${r} 0 1,1 ${-r},0A${r},${r} 0 1,1 ${r},0Z`;
}

function niceStep(range, count) {
  const raw = range / Math.max(count, 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function monthTicks(start, end, maxTicks) {
  const steps = [1, 2, 3, 6, 12];
  const s = new Date(start);
  const first = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + (s.getUTCDate() > 1 ? 1 : 0), 1);
  for (const step of steps) {
    const ticks = [];
    const f = new Date(first);
    let y = f.getUTCFullYear();
    let m = f.getUTCMonth();
    // Align multi-month steps to calendar quarters/halves for readable labels.
    while (step > 1 && m % step !== 0) { m++; if (m > 11) { m = 0; y++; } }
    for (let t = Date.UTC(y, m, 1); t <= end; m += step, t = Date.UTC(y, m, 1)) ticks.push(t);
    if (ticks.length <= maxTicks || step === 12) return ticks;
  }
  return [];
}

export function createChart(container, { format, onActive }) {
  const svg = el('svg', {
    class: 'plot',
    tabindex: '0',
    role: 'group',
    'aria-roledescription': 'wykres punktowy',
  });
  container.prepend(svg);
  const tooltip = container.querySelector('#tooltip');
  let state = null;
  let layout = null;
  let active = -1;

  function render(next) {
    if (next) state = next;
    if (!state) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    const narrow = W < 560;
    const m = { top: 14, right: narrow ? 74 : 104, bottom: 50, left: narrow ? 46 : 62 };
    const iw = Math.max(W - m.left - m.right, 50);
    const ih = Math.max(H - m.top - m.bottom, 50);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', state.ariaLabel);
    svg.replaceChildren();

    const [x0, x1] = state.xDomain;
    const pad = Math.max((x1 - x0) * 0.03, 3 * DAY);
    const dx0 = x0 - pad;
    const dx1 = x1 + pad;
    const x = (t) => m.left + ((t - dx0) / (dx1 - dx0)) * iw;

    const yStep = niceStep(state.yMax || 1, Math.max(3, Math.round(ih / 55)));
    const yTop = Math.max(yStep, Math.ceil(((state.yMax || 1) * 1.04) / yStep) * yStep);
    const y = (v) => m.top + ih - (v / yTop) * ih;

    const grid = el('g', { class: 'grid' }, svg);
    const yAxis = el('g', { class: 'axis' }, svg);
    for (let v = 0; v <= yTop + 1e-9; v += yStep) {
      el('line', { x1: m.left, x2: m.left + iw, y1: y(v), y2: y(v) }, grid);
      const tick = el('g', { class: 'tick' }, yAxis);
      const text = el('text', { x: m.left - 8, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, tick);
      text.textContent = format.number(v);
    }
    const xAxis = el('g', { class: 'axis' }, svg);
    el('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih }, xAxis);
    el('line', { x1: m.left, x2: m.left, y1: m.top, y2: m.top + ih }, yAxis);
    const ticks = monthTicks(dx0, dx1, Math.max(2, Math.floor(iw / (narrow ? 48 : 70))));
    ticks.forEach((t, i) => {
      const d = new Date(t);
      el('line', { x1: x(t), x2: x(t), y1: m.top, y2: m.top + ih }, grid);
      el('line', { x1: x(t), x2: x(t), y1: m.top + ih, y2: m.top + ih + 5 }, xAxis);
      const g = el('g', { class: 'tick' }, xAxis);
      const text = el('text', { x: x(t), y: m.top + ih + 18, 'text-anchor': 'middle' }, g);
      text.textContent = MONTHS_SHORT[d.getUTCMonth()];
      if (i === 0 || d.getUTCMonth() === 0 || ticks.length === 1) {
        const yr = el('text', { x: x(t), y: m.top + ih + 31, 'text-anchor': 'middle' }, g);
        yr.textContent = String(d.getUTCFullYear());
      }
    });
    const xt = el('text', { class: 'axis-title', x: m.left + iw / 2, y: H - 4, 'text-anchor': 'middle' }, svg);
    xt.textContent = 'Data ukończenia';
    const yt = el('text', {
      class: 'axis-title',
      transform: `translate(14 ${m.top + ih / 2}) rotate(-90)`,
      'text-anchor': 'middle',
    }, svg);
    yt.textContent = state.yTitle;
    el('rect', { class: 'plot-frame', x: m.left, y: m.top, width: iw, height: ih }, svg);

    // Percentile reference lines with direct labels; labels are nudged apart if they collide.
    const pg = el('g', { class: 'percentiles' }, svg);
    const labels = state.lines.map((l) => ({ ...l, py: y(l.value), ty: y(l.value) }));
    labels.sort((a, b) => b.py - a.py);
    const gap = 15;
    for (let i = 1; i < labels.length; i++) labels[i].ty = Math.min(labels[i].ty, labels[i - 1].ty - gap);
    const overflow = m.top + 6 - Math.min(...labels.map((l) => l.ty), Infinity);
    if (overflow > 0) labels.forEach((l) => { l.ty += overflow; });
    for (const l of labels) {
      const cls = l.keys.includes('p85') ? 'p85' : '';
      el('line', { class: `pline ${cls}`, x1: m.left, x2: m.left + iw, y1: l.py, y2: l.py }, pg);
      const t = el('text', {
        class: `plabel ${cls}`,
        x: m.left + iw + 6,
        y: l.ty,
        'dominant-baseline': 'middle',
      }, pg);
      t.textContent = narrow && l.keys.length > 1 ? `${l.label}` : `${l.label}: ${format.number(l.value)}`;
      if (narrow && l.keys.length > 1) {
        const v = el('tspan', { x: m.left + iw + 6, dy: '1.15em' }, t);
        v.textContent = format.number(l.value);
      }
    }

    const pts = el('g', { class: 'points' }, svg);
    const r = narrow ? 4.5 : 5.5;
    layout = state.groups.map((g, i) => {
      const cx = x(g.date);
      const cy = y(g.lead);
      const node = el('g', { class: 'marker-group', transform: `translate(${cx} ${cy})` }, pts);
      for (const task of g.tasks) el('path', { class: 'marker', 'data-shape': task.size, d: shapePath(task.size, r) }, node);
      if (g.tasks.length > 1) el('circle', { class: 'overlap-ring', r: r + 3.5 }, node);
      return { cx, cy, node, group: g, index: i };
    });
    if (active >= layout.length) active = -1;
    if (active >= 0) highlight(active, false);
  }

  function tooltipContent(group) {
    tooltip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = format.date(group.date);
    tooltip.append(title);
    const lines = [];
    if (group.tasks.length === 1) {
      lines.push(`Rozmiar: ${group.tasks[0].size}`);
      lines.push(`${state.leadName}: ${format.number(group.lead)}`);
    } else {
      const counts = {};
      for (const t of group.tasks) counts[t.size] = (counts[t.size] || 0) + 1;
      lines.push(`Nakładające się zadania: ${group.tasks.length}`);
      lines.push(`Rozmiary: ${Object.entries(counts).map(([s, c]) => (c > 1 ? `${s} ×${c}` : s)).join(', ')}`);
      lines.push(`${state.leadName}: ${format.number(group.lead)}`);
    }
    lines.forEach((text, i) => {
      if (i) tooltip.append(document.createElement('br'));
      tooltip.append(text);
    });
    return [title.textContent, ...lines].join(', ');
  }

  function highlight(index, announce = true) {
    layout.forEach((p) => p.node.classList.toggle('active', p.index === index));
    active = index;
    if (index < 0) { tooltip.hidden = true; return; }
    const p = layout[index];
    const text = tooltipContent(p.group);
    tooltip.hidden = false;
    const W = container.clientWidth;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = p.cx + 12;
    if (left + tw > W - 4) left = p.cx - tw - 12;
    let top = p.cy - th - 10;
    if (top < 4) top = p.cy + 12;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${top}px`;
    if (announce) onActive?.(text);
  }

  function nearest(evt, radius) {
    const rect = svg.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    let best = -1;
    let bestD = radius * radius;
    for (const p of layout || []) {
      const d = (p.cx - px) ** 2 + (p.cy - py) ** 2;
      if (d <= bestD) { bestD = d; best = p.index; }
    }
    return best;
  }

  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') highlight(nearest(e, 24), false);
  });
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') highlight(nearest(e, 32), false);
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') highlight(-1);
  });
  svg.addEventListener('keydown', (e) => {
    if (!layout?.length) return;
    const last = layout.length - 1;
    const keys = {
      ArrowRight: Math.min(active + 1, last),
      ArrowUp: Math.min(active + 1, last),
      ArrowLeft: active < 0 ? 0 : Math.max(active - 1, 0),
      ArrowDown: active < 0 ? 0 : Math.max(active - 1, 0),
      Home: 0,
      End: last,
    };
    if (e.key in keys) { e.preventDefault(); highlight(keys[e.key]); }
    else if (e.key === 'Escape') highlight(-1);
  });
  svg.addEventListener('blur', () => highlight(-1));

  new ResizeObserver(() => render()).observe(container);
  return { render, reset: () => { active = -1; tooltip.hidden = true; } };
}
