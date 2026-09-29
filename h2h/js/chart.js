// The "over time" card: a single-series line chart (win rate or series lead) with a
// range selector, like chess.com's rating graph. Drag or hover to read any game; arrow keys
// work too. A visually hidden table carries the same values for screen readers.
import { esc, haptic, reducedMotion } from './ui.js';

const DAY = 86400000;

export const METRICS = {
  winPct: { label: 'Win Rate', short: 'Win %', base: null, minSpan: 10, fmt: (v) => `${Math.round(v)}%`, delta: (d) => `${signed(Math.round(d))} pts`, even: '50%', evenAt: 50 },
  lead: { label: 'Series Lead', short: 'Lead', base: 0, minSpan: 2, fmt: (v) => (Math.round(v) === 0 ? 'Even' : signed(Math.round(v))), delta: (d) => signed(Math.round(d)), even: 'Even' },
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
  let inRange = points.filter((p) => start === null || p.t >= start);
  const prior = start === null ? null : [...points].reverse().find((p) => p.t < start);
  // Win rate swings wildly over the first few games (1 game = 0% or 100%), so the all-time view
  // starts from game 5 once there's enough history, and doesn't claim a "change" from game 1.
  const settle = metricId === 'winPct' && start === null && points.length >= 8;
  if (settle) inRange = inRange.slice(4);

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
  const change = metricId === 'winPct' && start === null ? null : from == null || current == null ? null : current - from;
  return { metric, range, anchor, series, xMin, xMax, current, change, settled: settle, peak: values.length ? Math.max(...values) : null, low: values.length ? Math.min(...values) : null };
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
export function renderTrendCard(card, { points, metric: metricId, range: rangeId, opponent, onChange, titleId = 'trend-title' }) {
  const s = slice(points, metricId, rangeId);
  const { metric } = s;
  const hasPlot = s.series.length > 0 || s.anchor;
  const changeClass = s.change > 0.5 ? 'is-win' : s.change < -0.5 ? 'is-loss' : '';
  const arrow = s.change > 0.5 ? '▲' : s.change < -0.5 ? '▼' : '';
  const games = s.series.length;

  card.innerHTML = `
    <div class="trend__top">
      <h3 class="tile__title" id="${titleId}">${esc(metric.label)} ${esc(opponent)}</h3>
      ${segmented('metric', 'Chart shows', Object.entries(METRICS).map(([value, m]) => ({ value, label: m.short })), metricId)}
    </div>
    <div class="trend__hero">
      <span class="trend__value">${s.current == null ? '—' : esc(metric.fmt(s.current))}</span>
      ${s.change != null ? `<span class="trend__delta ${changeClass}">${arrow ? `<span aria-hidden="true">${arrow}</span> ` : ''}${esc(metric.delta(s.change))}</span>` : ''}<span class="trend__phrase">${esc(s.range.phrase)}</span>
    </div>
    <p class="trend__sub">${s.settled ? `${points.length} games · from game 5` : games ? `${games} ${games === 1 ? 'game' : 'games'}` : 'No games in this period'}${s.peak != null && games ? ` · High ${esc(metric.fmt(s.peak))} · Low ${esc(metric.fmt(s.low))}` : ''}</p>
    <div class="trend__plot" data-plot>
      ${hasPlot ? '' : '<p class="trend__empty">Log a game to start the chart.</p>'}
    </div>
    ${segmented('range', 'Time range', RANGES.map((r) => ({ value: r.id, label: r.id })), s.range.id)}
    <table class="visually-hidden"><caption>${esc(metric.label)} after each game, ${esc(s.range.phrase)}</caption>
      <thead><tr><th>Date</th><th>Result</th><th>${esc(metric.label)}</th></tr></thead>
      <tbody>${s.series.slice(-60).map((p) => `<tr><td>${esc(p.game.date)}</td><td>${p.game.win ? 'Win' : p.game.draw ? 'Draw' : 'Loss'} ${p.game.myScore}–${p.game.oppScore}</td><td>${esc(metric.fmt(p.v))}</td></tr>`).join('')}</tbody>
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

  if (hasPlot) drawPlot(card.querySelector('[data-plot]'), s, titleId);
}

function drawPlot(host, s, titleId) {
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
    <svg class="trend__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${titleId}" tabindex="0">
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
    tip.innerHTML = `<strong>${esc(metric.fmt(p.v))}</strong><span>${esc(date)} · ${g.result} ${g.myScore}–${g.oppScore}${g.shootout ? ` (${g.myPens}–${g.oppPens} pens)` : g.overtime ? (g.sport === 'fifa' ? ' ET' : ' OT') : ''}</span>`;
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
/** "5–3", or "5–1–3" (W–D–L) when there were draws. */
const recText = (w, d, l) => (d ? `${w}–${d}–${l}` : `${w}–${l}`);

// ---------- activity calendar ----------

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * A normal month calendar. Days you played are tinted by who won the day (won / lost / split),
 * with one dot per game underneath the date (up to 3). ‹ › move between months, from the month of
 * your first game to this month. Tap or arrow-key a day to read it.
 *   days: Map 'YYYY-MM-DD' → { wins, draws, losses } (a day of only draws counts as split)
 *   opts: { month: Date (any day in it), onMonth(Date) }
 */
export function renderMonthCalendar(host, days, { month, onMonth }) {
  const today = new Date();
  const keys = [...days.keys()].sort();
  const first = keys.length ? monthStart(new Date(`${keys[0]}T12:00:00`)) : monthStart(today);
  const last = monthStart(today);
  let shown = monthStart(month || today);
  if (shown < first) shown = first;
  if (shown > last) shown = last;
  const canPrev = shown > first, canNext = shown < last;

  const firstWeekday = shown.getDay();
  const daysInMonth = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
  const weekdayNames = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  const fullWeekday = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' }));

  let games = 0, wins = 0, draws = 0, losses = 0;
  const cells = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(shown.getFullYear(), shown.getMonth(), d, 12);
    const rec = days.get(iso(date));
    const n = rec ? rec.wins + (rec.draws || 0) + rec.losses : 0;
    if (n) (games += n), (wins += rec.wins), (draws += rec.draws || 0), (losses += rec.losses);
    const kind = !n ? 'none' : rec.wins > rec.losses ? 'win' : rec.losses > rec.wins ? 'loss' : 'split';
    cells.push({ d, date, rec, n, kind, future: date > today, today: iso(date) === iso(today) });
  }
  const title = shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const describe = (c) => {
    const when = c.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (!c.n) return `${when}: no games`;
    const result = c.kind === 'win' ? 'you won the day' : c.kind === 'loss' ? 'you lost the day' : 'split';
    return `${when}: ${c.n} ${c.n === 1 ? 'game' : 'games'}, ${result} ${recText(c.rec.wins, c.rec.draws || 0, c.rec.losses)}`;
  };

  host.innerHTML = `
    <div class="cal__nav">
      <button type="button" class="cal__arrow" data-cal="-1" aria-label="Previous month"${canPrev ? '' : ' disabled'}><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.75 8.25 12l6.25 6.25"/></svg></button>
      <div class="cal__title"><span>${esc(title)}</span><span class="cal__summary">${games ? `${games} ${games === 1 ? 'game' : 'games'} · ${recText(wins, draws, losses)}` : 'No games'}</span></div>
      <button type="button" class="cal__arrow" data-cal="1" aria-label="Next month"${canNext ? '' : ' disabled'}><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.75 6.25 6.25-6.25 6.25"/></svg></button>
    </div>
    <div class="cal__grid" role="grid" aria-label="${esc(title)}">
      <div class="cal__week" role="row">${weekdayNames.map((w, i) => `<span class="cal__wd" role="columnheader" aria-label="${esc(fullWeekday[i])}">${esc(w)}</span>`).join('')}</div>
      ${(() => {
        const slots = [...Array(firstWeekday).fill(null), ...cells];
        while (slots.length % 7) slots.push(null);
        const rows = [];
        for (let i = 0; i < slots.length; i += 7) rows.push(slots.slice(i, i + 7));
        return rows
          .map(
            (row) => `<div class="cal__week" role="row">${row
              .map((c) =>
                c
                  ? `<button type="button" role="gridcell" class="cal__day cal__day--${c.kind}${c.n ? ` cal__day--l${Math.min(3, c.n)}` : ''}${c.today ? ' is-today' : ''}${c.future ? ' is-future' : ''}" data-d="${c.d}" tabindex="-1" aria-label="${esc(describe(c))}">
                      <span class="cal__num">${c.d}</span>${c.n ? `<span class="cal__dots" aria-hidden="true">${'<i></i>'.repeat(Math.min(3, c.n))}</span>` : ''}
                    </button>`
                  : '<span class="cal__blank" role="gridcell"></span>',
              )
              .join('')}</div>`,
          )
          .join('');
      })()}
    </div>
    <p class="cal__readout" role="status" aria-live="polite">${games ? 'Tap a day to see its games.' : ''}</p>`;

  const readout = host.querySelector('.cal__readout');
  const buttons = [...host.querySelectorAll('.cal__day')];
  let active = cells.findIndex((c) => c.today);
  if (active < 0) active = 0;
  buttons[active].tabIndex = 0;
  const select = (i, focus) => {
    i = Math.max(0, Math.min(cells.length - 1, i));
    buttons.forEach((b, j) => {
      b.tabIndex = j === i ? 0 : -1;
      b.classList.toggle('is-selected', j === i);
    });
    active = i;
    readout.textContent = describe(cells[i]);
    if (focus) buttons[i].focus();
  };
  host.querySelector('.cal__grid').addEventListener('click', (e) => {
    const b = e.target.closest('.cal__day');
    if (b) select(+b.dataset.d - 1);
  });
  host.querySelector('.cal__grid').addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step == null) return;
    e.preventDefault();
    select(active + step, true);
  });
  host.querySelectorAll('[data-cal]').forEach((b) =>
    b.addEventListener('click', () => {
      haptic('light');
      onMonth(new Date(shown.getFullYear(), shown.getMonth() + Number(b.dataset.cal), 1));
    }),
  );
}
