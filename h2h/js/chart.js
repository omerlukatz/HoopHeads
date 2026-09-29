// The "over time" card: a single-series line chart (rating, series lead or win %) with a
// range selector, like chess.com's rating graph. Drag or hover to read any game; arrow keys
// work too. A visually hidden table carries the same values for screen readers.
import { RATING_START } from './stats.js';
import { esc, haptic, reducedMotion } from './ui.js';

const DAY = 86400000;

export const METRICS = {
  rating: { label: 'Rating', short: 'Rating', base: RATING_START, minSpan: 24, fmt: (v) => Math.round(v).toLocaleString(), delta: (d) => signed(Math.round(d)), even: 'Even (1,200)' },
  lead: { label: 'Series Lead', short: 'Lead', base: 0, minSpan: 2, fmt: (v) => (Math.round(v) === 0 ? 'Even' : signed(Math.round(v))), delta: (d) => signed(Math.round(d)), even: 'Even' },
  winPct: { label: 'Win Rate', short: 'Win %', base: null, minSpan: 10, fmt: (v) => `${Math.round(v)}%`, delta: (d) => `${signed(Math.round(d))} pts`, even: '50%', evenAt: 50 },
};

export const RANGES = [
  { id: '1W', days: 7, phrase: 'in the last week' },
  { id: '1M', days: 30, phrase: 'in the last month' },
  { id: '3M', days: 90, phrase: 'in the last 3 months' },
  { id: '1Y', days: 365, phrase: 'in the last year' },
  { id: 'All', days: null, phrase: 'all time' },
];

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

/** Round step for ~`count` ticks across `span`: 1, 2 or 5 × 10^n. */
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** The slice of the timeline a range shows, with an anchor carrying the value from before it. */
export function slice(points, metricId, rangeId, now = Date.now()) {
  const metric = METRICS[metricId];
  const range = RANGES.find((r) => r.id === rangeId) || RANGES.at(-1);
  const start = range.days ? now - range.days * DAY : null;
  const inRange = points.filter((p) => start === null || p.t >= start);
  const prior = start === null ? null : [...points].reverse().find((p) => p.t < start);

  let anchor = null;
  if (prior) anchor = { t: start, v: prior[metricId] };
  else if (metric.base !== null && (inRange.length || points.length)) {
    const firstT = (inRange[0] || points[0]).t;
    anchor = { t: start ?? firstT - DAY / 2, v: metric.base };
  }

  const series = inRange.map((p) => ({ t: p.t, v: p[metricId], game: p.game }));
  const xMin = anchor ? anchor.t : series[0]?.t ?? (start ?? now - DAY);
  let xMax = start === null ? series.at(-1)?.t ?? now : now;
  if (xMax - xMin < DAY) xMax = xMin + DAY;
  const current = points.length ? points.at(-1)[metricId] : metric.base;
  const from = anchor ? anchor.v : series[0]?.v;
  const values = [...(anchor ? [anchor.v] : []), ...series.map((s) => s.v)];
  return { metric, range, anchor, series, xMin, xMax, current, change: from == null || current == null ? null : current - from, peak: values.length ? Math.max(...values) : null, low: values.length ? Math.min(...values) : null };
}

function dateTick(t, span) {
  const d = new Date(t);
  if (span > 200 * DAY) return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function segmented(name, label, options, value) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return `<div class="seg" role="radiogroup" aria-label="${esc(label)}" data-seg="${name}" style="--count:${options.length};--index:${index}">
    <span class="seg__thumb" aria-hidden="true"></span>
    ${options.map((o, i) => `<button type="button" class="seg__item" role="radio" aria-checked="${i === index}" tabindex="${i === index ? 0 : -1}" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
  </div>`;
}

/**
 * Renders the whole card into `card`.
 * opts: { points, metric, range, opponent, onChange({ metric?, range? }) }
 */
export function renderTrendCard(card, { points, metric: metricId, range: rangeId, opponent, onChange }) {
  const s = slice(points, metricId, rangeId);
  const { metric } = s;
  const hasPlot = s.series.length > 0 || s.anchor;
  const changeClass = s.change > 0.5 ? 'is-win' : s.change < -0.5 ? 'is-loss' : '';
  const arrow = s.change > 0.5 ? '▲' : s.change < -0.5 ? '▼' : '';
  const games = s.series.length;

  card.innerHTML = `
    <div class="trend__top">
      <h3 class="tile__title" id="trend-title">${esc(metric.label)} vs ${esc(opponent)}</h3>
      ${segmented('metric', 'Chart shows', Object.entries(METRICS).map(([value, m]) => ({ value, label: m.short })), metricId)}
    </div>
    <div class="trend__hero">
      <span class="trend__value">${s.current == null ? '—' : esc(metric.fmt(s.current))}</span>
      ${s.change != null ? `<span class="trend__delta ${changeClass}">${arrow ? `<span aria-hidden="true">${arrow}</span> ` : ''}${esc(metric.delta(s.change))}</span><span class="trend__phrase">${esc(s.range.phrase)}</span>` : ''}
    </div>
    <p class="trend__sub">${games ? `${games} ${games === 1 ? 'game' : 'games'}` : 'No games in this period'}${s.peak != null && games ? ` · High ${esc(metric.fmt(s.peak))} · Low ${esc(metric.fmt(s.low))}` : ''}</p>
    <div class="trend__plot" data-plot>
      ${hasPlot ? '' : '<p class="trend__empty">Log a game to start the chart.</p>'}
    </div>
    ${segmented('range', 'Time range', RANGES.map((r) => ({ value: r.id, label: r.id })), s.range.id)}
    <table class="visually-hidden"><caption>${esc(metric.label)} after each game, ${esc(s.range.phrase)}</caption>
      <thead><tr><th>Date</th><th>Result</th><th>${esc(metric.label)}</th></tr></thead>
      <tbody>${s.series.slice(-60).map((p) => `<tr><td>${esc(p.game.date)}</td><td>${p.game.win ? 'Win' : 'Loss'} ${p.game.myScore}–${p.game.oppScore}</td><td>${esc(metric.fmt(p.v))}</td></tr>`).join('')}</tbody>
    </table>`;

  // Segmented controls (radio semantics: arrows move, Enter/Space/click select)
  card.querySelectorAll('.seg').forEach((seg) => {
    const pick = (btn) => {
      if (!btn || btn.getAttribute('aria-checked') === 'true') return;
      haptic('light');
      onChange({ [seg.dataset.seg]: btn.dataset.value });
    };
    seg.addEventListener('click', (e) => pick(e.target.closest('.seg__item')));
    seg.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const items = [...seg.querySelectorAll('.seg__item')];
      const i = items.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
      pick(next);
      requestAnimationFrame(() => card.querySelector(`[data-seg="${seg.dataset.seg}"] [aria-checked="true"]`)?.focus());
    });
  });

  if (hasPlot) drawPlot(card.querySelector('[data-plot]'), s);
}

function drawPlot(host, s) {
  const { metric, anchor, series } = s;
  const W = Math.max(240, host.clientWidth);
  const H = W >= 520 ? 220 : 176;
  const M = { top: 12, right: 10, bottom: 24, left: 44 };
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;

  const all = [...(anchor ? [anchor] : []), ...series];
  let lo = Math.min(...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v));
  if (hi - lo < metric.minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - metric.minSpan / 2;
    hi = mid + metric.minSpan / 2;
  }
  const step = niceStep(hi - lo, 3);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (metricIsPct(metric)) (lo = Math.max(0, lo)), (hi = Math.min(100, hi));

  const x = (t) => M.left + ((t - s.xMin) / (s.xMax - s.xMin)) * iw;
  const y = (v) => M.top + ih - ((v - lo) / (hi - lo)) * ih;

  const yTicks = [];
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(v);
  const xCount = W >= 520 ? 5 : 3;
  const xTicks = Array.from({ length: xCount }, (_, i) => s.xMin + ((s.xMax - s.xMin) * i) / (xCount - 1));

  // Carry the line to "now" when the range ends after the last game, so flat stretches read as flat
  const pts = [...all];
  if (s.range.days && pts.length && pts.at(-1).t < s.xMax) pts.push({ t: s.xMax, v: pts.at(-1).v, carry: true });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.at(-1).t).toFixed(1)},${(M.top + ih).toFixed(1)}L${x(pts[0].t).toFixed(1)},${(M.top + ih).toFixed(1)}Z`;
  const evenV = metric.evenAt ?? metric.base;
  const showEven = evenV != null && evenV > lo && evenV < hi;
  const last = series.at(-1);

  host.innerHTML = `
    <svg class="trend__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="trend-title" tabindex="0">
      <g class="trend__grid">
        ${yTicks.map((v) => `<line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}"/><text class="trend__ylabel" x="${M.left - 8}" y="${y(v)}" dy="0.32em">${esc(metric.fmt(v))}</text>`).join('')}
        ${xTicks.map((t, i) => `<text class="trend__xlabel" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}">${esc(dateTick(t, s.xMax - s.xMin))}</text>`).join('')}
      </g>
      ${showEven ? `<line class="trend__even" x1="${M.left}" x2="${W - M.right}" y1="${y(evenV)}" y2="${y(evenV)}"/>` : ''}
      <path class="trend__area" d="${area}"/>
      <path class="trend__line" d="${line}"/>
      ${last ? `<circle class="trend__end" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/>` : ''}
      <g class="trend__cursor" hidden><line y1="${M.top}" y2="${M.top + ih}"/><circle r="5"/></g>
    </svg>
    <div class="trend__tip" role="status" aria-live="polite" hidden></div>`;

  const svg = host.querySelector('svg');
  const path = host.querySelector('.trend__line');
  if (!reducedMotion.matches && path.getTotalLength) {
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 700ms cubic-bezier(0.32, 0.72, 0, 1)';
    path.style.strokeDashoffset = '0';
    path.addEventListener('transitionend', () => (path.style.strokeDasharray = ''), { once: true });
  }

  if (!series.length) return;
  const cursor = svg.querySelector('.trend__cursor');
  const tip = host.querySelector('.trend__tip');
  let active = -1;

  const show = (i) => {
    if (i === active) return;
    active = i;
    const p = series[i];
    const cx = x(p.t), cy = y(p.v);
    cursor.hidden = false;
    cursor.querySelector('line').setAttribute('x1', cx);
    cursor.querySelector('line').setAttribute('x2', cx);
    cursor.querySelector('circle').setAttribute('cx', cx);
    cursor.querySelector('circle').setAttribute('cy', cy);
    const g = p.game;
    const date = new Date(`${g.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    tip.innerHTML = `<strong>${esc(metric.fmt(p.v))}</strong><span>${esc(date)} · ${g.win ? 'W' : 'L'} ${g.myScore}–${g.oppScore}${g.overtime ? ' OT' : ''}</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px`;
    tip.style.top = `${Math.max(0, cy - 58)}px`;
  };
  const hide = () => {
    active = -1;
    cursor.hidden = true;
    tip.hidden = true;
  };
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    series.forEach((p, i) => Math.abs(x(p.t) - px) < Math.abs(x(series[best].t) - px) && (best = i));
    return best;
  };

  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
  svg.addEventListener('pointerup', (e) => e.pointerType !== 'mouse' && setTimeout(hide, 1500));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? series.length - 1 : Math.min(series.length - 1, Math.max(0, (active < 0 ? series.length : active) + (e.key === 'ArrowRight' ? 1 : -1)));
    show(i);
  });
}

const metricIsPct = (m) => m === METRICS.winPct;

// ---------- activity calendar ----------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * GitHub-style grid: one column per week (Sunday first), newest week on the right.
 * Colour = who won the day (won / lost / split); shade = how many games (1, 2, 3+).
 * `days` is Map 'YYYY-MM-DD' → { wins, losses }. Tap, hover or arrow-key a day to read it.
 */
export function renderActivity(host, days) {
  const width = Math.max(260, host.clientWidth);
  const cell = width >= 520 ? 15 : 13, gap = 3, left = 28, top = 16;
  const weeks = Math.max(12, Math.min(26, Math.floor((width - left + gap) / (cell + gap))));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - (weeks - 1) * 7); // Sunday, `weeks` weeks ago

  const cells = [];
  let games = 0, gameDays = 0, busiest = 0;
  const monthLabels = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) continue;
      if (d === 0 && (w === 0 || date.getDate() <= 7)) monthLabels.push({ w, label: date.toLocaleDateString(undefined, { month: 'short' }) });
      const key = iso(date);
      const rec = days.get(key);
      const n = rec ? rec.wins + rec.losses : 0;
      if (n) (games += n), gameDays++, (busiest = Math.max(busiest, n));
      const kind = !n ? 'none' : rec.wins > rec.losses ? 'win' : rec.losses > rec.wins ? 'loss' : 'split';
      cells.push({ w, d, key, date, n, rec, kind, level: Math.min(3, n) });
    }
  }
  // Drop a month label that would collide with the next one
  const labels = monthLabels.filter((m, i) => !monthLabels[i + 1] || monthLabels[i + 1].w - m.w >= 3);
  const W = left + weeks * (cell + gap) - gap, H = top + 7 * (cell + gap) - gap;

  const describe = (c) => {
    const when = c.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!c.n) return `${when} · No games`;
    const result = c.kind === 'win' ? 'won the day' : c.kind === 'loss' ? 'lost the day' : 'split the day';
    return `${when} · ${c.n} ${c.n === 1 ? 'game' : 'games'} · ${result} ${c.rec.wins}–${c.rec.losses}`;
  };

  host.innerHTML = `
    <svg class="cal__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0"
         aria-label="Activity over the last ${weeks} weeks: ${games} games on ${gameDays} days. Use arrow keys to read each day.">
      ${labels.map((m) => `<text class="cal__label" x="${left + m.w * (cell + gap)}" y="10">${esc(m.label)}</text>`).join('')}
      ${[1, 3, 5].map((d) => `<text class="cal__label" x="0" y="${top + d * (cell + gap) + cell - 3}">${DAY_NAMES[d]}</text>`).join('')}
      ${cells.map((c, i) => `<rect class="cal__day cal__day--${c.kind} cal__day--l${c.level}" data-i="${i}" x="${left + c.w * (cell + gap)}" y="${top + c.d * (cell + gap)}" width="${cell}" height="${cell}" rx="3"/>`).join('')}
      <rect class="cal__focus" width="${cell + 4}" height="${cell + 4}" rx="4" hidden/>
    </svg>
    <p class="cal__readout" role="status" aria-live="polite">${esc(games ? `Tap a day to see it. Busiest day: ${busiest} ${busiest === 1 ? 'game' : 'games'}.` : 'No games in this stretch yet.')}</p>`;

  const svg = host.querySelector('svg');
  const readout = host.querySelector('.cal__readout');
  const ring = svg.querySelector('.cal__focus');
  let active = -1;
  const select = (i) => {
    if (i < 0 || i >= cells.length) return;
    active = i;
    const c = cells[i];
    ring.hidden = false;
    ring.setAttribute('x', left + c.w * (cell + gap) - 2);
    ring.setAttribute('y', top + c.d * (cell + gap) - 2);
    readout.textContent = describe(c);
  };
  svg.addEventListener('pointerdown', (e) => {
    const r = e.target.closest?.('.cal__day');
    if (r) select(+r.dataset.i);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.target.closest?.('.cal__day');
    if (r) select(+r.dataset.i);
  });
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (step == null) return;
    e.preventDefault();
    select(active < 0 ? cells.length - 1 : Math.min(cells.length - 1, Math.max(0, active + step)));
  });
}
