import { TEAMS, getTeam, searchTeams } from './teams.js';
import * as store from './store.js';
import { state } from './store.js';
import { isDemo, demoControls } from './api.js';
import { views, computeStats, record, recentTeams, timeline, teamRecords, clutch, activityByDay, opponentRecords, CLOSE_MARGIN, BLOWOUT_MARGIN } from './stats.js';
import { renderTrendCard, renderMonthCalendar, METRICS, RANGES } from './chart.js';
import { showLock, isLocked, avatar, AVATARS, changePinFlow } from './lock.js';
import { icon, logo, esc, haptic, openSheet, openPopup, alertDialog, toast, animateNumbers, formatNumber, reducedMotion } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  screen: 'dashboard',
  shown: {}, // last values rendered on the dashboard, so numbers count from old → new
  signature: '', // skip re-rendering when nothing changed (most polls return the same data)
  views: [],
  stats: { total: 0 },
  justSaved: false,
  trend: loadTrendPrefs(),
  teamsSide: 'myTeam',
  calMonth: null, // first day of the month shown in the Activity calendar
};

function loadTrendPrefs() {
  try {
    const t = JSON.parse(localStorage.getItem('h2h.trend') || '{}');
    return { metric: METRICS[t.metric] ? t.metric : 'winPct', range: RANGES.some((r) => r.id === t.range) ? t.range : 'All' };
  } catch {
    return { metric: 'winPct', range: 'All' };
  }
}

const meId = () => state.session?.userId;
const meName = () => state.me?.display_name || '';
const oppName = () => store.rival()?.display_name || 'Opponent';

// ---------- formatting ----------

const asDate = (iso) => new Date(`${iso}T12:00:00`);
const fmt = (iso, opts) => asDate(iso).toLocaleDateString(undefined, opts);
const shortDate = (iso) => fmt(iso, { month: 'short', day: 'numeric' });
const longDate = (iso) => fmt(iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthLabel = (iso) => fmt(iso, { month: 'long', year: 'numeric' });
const todayISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function relativeTime(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- navigation ----------

const SCREENS = ['dashboard', 'history', 'friends', 'settings'];

/** `sub` is the friend profile open in the Friends tab: an id, null for the list, or undefined to keep it. */
function show(screen, sub) {
  if (!SCREENS.includes(screen)) screen = 'dashboard';
  const same = ui.screen === screen;
  ui.screen = screen;
  for (const el of $$('.screen')) {
    const on = el.dataset.screen === screen;
    el.classList.toggle('is-active', on);
    el.inert = !on;
  }
  for (const el of $$('[data-nav]')) {
    if (el.dataset.nav === screen) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  document.title = `${{ dashboard: 'Dashboard', history: 'History', friends: 'Friends', settings: 'Settings' }[screen]} · Dubs`;
  if (screen === 'friends') showProfilePage(sub === undefined ? fp.userId : sub);
  const target = screen === 'friends' && fp.userId ? `friends/${fp.userId}` : screen;
  if (location.hash.slice(1) !== target) history.replaceState(history.state, '', `#${target}`);
  return same;
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    // Tapping Friends while a profile is open goes back to the list, like iOS
    if (nav.dataset.nav === 'friends' && ui.screen === 'friends' && fp.userId) {
      haptic('light');
      return closeProfile();
    }
    const wasActive = show(nav.dataset.nav);
    haptic('light');
    // Tapping the active tab scrolls to top, like iOS
    if (wasActive) $(`.screen[data-screen="${nav.dataset.nav}"] .scroller`).scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    return;
  }
  const action = e.target.closest('[data-action]');
  if (!action) return;
  const { action: name, id } = action.dataset;
  if (name === 'log') openGameSheet();
  else if (name === 'edit') openGameSheet({ id });
  else if (name === 'delete') removeGame(id);
  else if (name === 'retry') store.sync();
  else if (name === 'switch-rival') openRivalSwitcher();
  else if (name === 'open-rival') {
    store.setRival(id);
    show('dashboard');
    haptic('light');
  }
  else if (name === 'add-friend') addFriend(id, action);
  else if (name === 'friend-options') openFriendOptions(id);
  else if (name === 'open-profile') openProfile(id);
  else if (name === 'invite') shareInvite();
});

// "N" logs a new game on desktop keyboards
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isLocked() || document.documentElement.classList.contains('has-modal') || e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  openGameSheet();
});

/** #screen or #friends/<userId> */
function route() {
  const [screen, sub] = location.hash.slice(1).split('/');
  show(screen || 'dashboard', screen === 'friends' ? sub || null : undefined);
}

// ---------- large title → inline title on scroll ----------

function initNavBars() {
  for (const screen of $$('.screen')) {
    const scroller = $('.scroller', screen);
    const title = $('.large-title', screen);
    let ticking = false;
    const update = () => {
      ticking = false;
      const y = scroller.scrollTop;
      screen.classList.toggle('is-scrolled', y > title.offsetTop + title.offsetHeight - 52);
      // Large title grows slightly when pulled down (rubber-band), as on iOS
      title.style.transform = y < 0 ? `scale(${1 + Math.min(-y, 120) / 900})` : '';
    };
    scroller.addEventListener('scroll', () => ticking || ((ticking = true), requestAnimationFrame(update)), { passive: true });
  }
}

// ---------- sync indicator ----------

function renderSync() {
  const pending = store.pendingCount();
  let html = '';
  if (state.status === 'offline') {
    html = `<span class="sync sync--offline" role="status">${icon('offline')}<span>${pending ? `Offline · ${pending} pending` : 'Offline'}</span></span>`;
  } else if (state.status === 'error') {
    html = `<button type="button" class="sync sync--error" data-action="retry" title="${esc(state.error || '')}">${icon('alert')}<span>Couldn’t sync · Retry</span></button>`;
  } else if (state.status === 'syncing' && pending) {
    html = `<span class="sync" role="status"><span class="spinner spinner--sm" aria-hidden="true"></span><span>Saving</span></span>`;
  } else if (ui.justSaved) {
    html = `<span class="sync sync--ok" role="status">${icon('check')}<span>Saved</span></span>`;
  }
  $$('[data-sync]').forEach((slot) => {
    if (slot.innerHTML !== html) slot.innerHTML = html;
  });
}

// ---------- shared rendering pieces ----------

function emptyState({ iconName, text, button }) {
  return `<div class="empty">
    <span class="empty__icon">${icon(iconName)}</span>
    <p class="empty__text">${esc(text)}</p>
    <button type="button" class="btn btn--primary" data-action="log">${esc(button)}</button>
  </div>`;
}

const noFriendsState = () => `<div class="empty">
    <span class="empty__icon">${icon('people')}</span>
    <p class="empty__text">Add a friend to start a rivalry.</p>
    <button type="button" class="btn btn--primary" data-nav="friends">Find Friends</button>
  </div>`;

const wlPill = (win) =>
  `<span class="pill ${win ? 'pill--w' : 'pill--l'}" aria-label="${win ? 'Win' : 'Loss'}">${win ? 'W' : 'L'}</span>`;
const otPill = '<span class="pill pill--ot" aria-label="Overtime">O</span>';
/** W/L pill, plus an orange O when the game went to overtime. */
const resultPills = (g) => `<span class="row__pills">${g.overtime ? otPill : ''}${wlPill(g.win)}</span>`;

function gameRow(g) {
  const me = getTeam(g.myTeam), opp = getTeam(g.oppTeam);
  const byOpp = g.createdBy && g.createdBy !== meId();
  const meta = g.note || '';
  const tags = [
    g.pending ? `<span class="tag tag--pending">${icon('clock')}Not synced</span>` : '',
    byOpp ? `<span class="tag">Logged by ${esc(oppName())}</span>` : '',
  ].join('');
  const label = `${longDate(g.date)}. You, ${me?.name}, ${g.myScore}. ${oppName()}, ${opp?.name}, ${g.oppScore}. ${g.win ? 'Win' : 'Loss'}${g.overtime ? ' in overtime' : ''}. ${g.note ? g.note + '. ' : ''}${byOpp ? `Logged by ${oppName()}. ` : ''}${g.pending ? 'Not synced yet. ' : ''}Edit game.`;
  return `<li class="row-wrap" data-id="${g.id}">
    <div class="row-clip">
      <div class="row-actions" aria-hidden="true">
        <button type="button" class="row-delete" data-action="delete" data-id="${g.id}" tabindex="-1">${icon('trash')}<span>Delete</span></button>
      </div>
      <button type="button" class="row" data-action="edit" data-id="${g.id}" aria-label="${esc(label)}">
        <span class="row__date"><span class="row__day">${asDate(g.date).getDate()}</span><span class="row__dow">${fmt(g.date, { weekday: 'short' })}</span></span>
        <span class="row__main">
          <span class="row__match">
            ${logo(g.myTeam, { size: 'sm', alt: '' })}
            <span class="row__score"><span class="num num--end ${g.win ? 'is-winner' : ''}">${g.myScore}</span><span class="row__dash">–</span><span class="num ${g.win ? '' : 'is-winner'}">${g.oppScore}</span></span>
            ${logo(g.oppTeam, { size: 'sm', alt: '' })}
          </span>
          ${meta || tags ? `<span class="row__meta">${tags}${meta ? `<span class="row__note">${esc(meta)}</span>` : ''}</span>` : ''}
        </span>
        ${resultPills(g)}
      </button>
    </div>
  </li>`;
}

/** First load with nothing cached and no connection: say so instead of an endless skeleton. */
const loadFailed = () => !state.loaded && (state.status === 'offline' || state.status === 'error');
const loadError = () => `<div class="empty">
    <span class="empty__icon">${icon('offline')}</span>
    <p class="empty__text">Can’t load games right now.</p>
    <button type="button" class="btn btn--primary" data-action="retry">Try Again</button>
  </div>`;

const winsLosses = (w, l) => `${w} ${w === 1 ? 'win' : 'wins'}, ${l} ${l === 1 ? 'loss' : 'losses'}`;

const skeletonRows = (n) =>
  `<ul class="list" role="list" aria-hidden="true">${'<li class="skel-row"><span class="skel skel--date"></span><span class="skel skel--line"></span><span class="skel skel--pill"></span></li>'.repeat(n)}</ul>`;

// ---------- dashboard ----------

const RING_C = 2 * Math.PI * 52;

function renderDashboardHeader() {
  const r = store.rival();
  $('#t-dashboard').innerHTML = r
    ? `<button type="button" class="rival-switch" data-action="switch-rival" aria-label="Rivalry with ${esc(r.display_name)}. Switch friend">vs ${esc(r.display_name)}<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6.75 9.75 5.25 5.25 5.25-5.25"/></svg></button>`
    : 'Dashboard';
  $('#dash-navtitle').textContent = r ? `vs ${r.display_name}` : 'Dashboard';
  $('#history-eyebrow').textContent = r ? `vs ${r.display_name}` : '\u00a0';
}

function renderDashboard() {
  renderDashboardHeader();
  const el = $('#dashboard-content');
  const s = ui.stats;
  if (loadFailed()) {
    el.innerHTML = loadError();
    return;
  }
  if (!state.loaded) {
    el.innerHTML = `<div class="dash-grid" aria-busy="true" aria-label="Loading">
      <div class="card skel-card area-hero" style="min-height:236px"></div>
      <div class="card skel-card area-scoring" style="min-height:104px"></div>
      <div class="card skel-card area-trend" style="min-height:320px"></div></div>`;
    return;
  }
  if (!store.rival()) {
    el.innerHTML = noFriendsState();
    ui.shown = {};
    return;
  }
  if (!s.total) {
    el.innerHTML = emptyState({ iconName: 'basketball', text: `No games against ${oppName()} yet.`, button: 'Log First Game' });
    ui.shown = {};
    return;
  }
  const prev = ui.shown;
  const pct = Math.round(s.pct * 100);
  const num = (key, value, opts = {}) => {
    const from = prev[key] ?? 0;
    prev[key] = value;
    return `<span class="num" data-from="${from}" data-to="${value}"${opts.decimals ? ` data-decimals="${opts.decimals}"` : ''}${opts.signed ? ' data-signed' : ''}>${formatNumber(from, opts)}</span>`;
  };
  const opp = esc(oppName());
  const h2h =
    s.wins === s.losses
      ? `You and ${opp} are tied ${s.wins}–${s.losses}`
      : s.wins > s.losses
        ? `You lead ${opp} ${s.wins}–${s.losses}`
        : `${opp} leads you ${s.losses}–${s.wins}`;
  const gameTile = (key, title, g, emptyText) =>
    g
      ? `<section class="card tile area-${key}" aria-label="${title}: ${g.myScore} to ${g.oppScore}, ${shortDate(g.date)}">
          <h3 class="tile__title">${title}</h3>
          <span class="mini-match">${logo(g.myTeam, { size: 'sm', alt: '' })}${logo(g.oppTeam, { size: 'sm', alt: '' })}</span>
          <span class="tile__score"><span class="${g.win ? 'is-win' : 'is-loss'}">${g.myScore}</span><span class="dash">–</span>${g.oppScore}</span>
          <span class="tile__sub">${g.win ? 'Won' : 'Lost'} by ${Math.abs(g.margin)}${g.overtime ? ' · OT' : ''} · ${shortDate(g.date)}</span>
        </section>`
      : `<section class="card tile area-${key}"><h3 class="tile__title">${title}</h3><p class="tile__empty">${emptyText}</p></section>`;
  const prevRing = prev.ring ?? 0;
  prev.ring = pct;

  el.innerHTML = `
  <div class="dash-grid">
    <section class="card hero area-hero" aria-labelledby="hero-title">
      <h2 id="hero-title" class="visually-hidden">Your record</h2>
      <div class="hero__top">
        <div class="ring" role="img" aria-label="Win rate ${pct} percent">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="ring__track" cx="60" cy="60" r="52"/>
            <circle class="ring__value" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - prevRing / 100)}" data-offset="${RING_C * (1 - pct / 100)}"/>
          </svg>
          <span class="ring__label" aria-hidden="true"><span class="ring__pct">${num('pct', pct)}<span class="ring__unit">%</span></span><span class="ring__caption">Win Rate</span></span>
        </div>
        <div class="hero__record">
          <p class="eyebrow">Your Record</p>
          <p class="record" aria-label="${winsLosses(s.wins, s.losses)}">${num('wins', s.wins)}<span class="record__dash">–</span>${num('losses', s.losses)}</p>
          <p class="hero__sub">${h2h}</p>
        </div>
      </div>
      <dl class="hero__streaks">
        <div><dt>Current Streak</dt><dd class="${s.streak.win ? 'is-win' : 'is-loss'}" aria-label="${s.streak.count} ${s.streak.win ? (s.streak.count === 1 ? 'win' : 'wins') : s.streak.count === 1 ? 'loss' : 'losses'} in a row">${s.streak.win ? 'W' : 'L'}${num('streak', s.streak.count)}</dd></div>
        <div><dt>Longest Win</dt><dd class="${s.longestWin ? 'is-win' : ''}" aria-label="Longest winning streak: ${s.longestWin}">W${num('longestWin', s.longestWin)}</dd></div>
        <div><dt>Longest Loss</dt><dd class="${s.longestLoss ? 'is-loss' : ''}" aria-label="Longest losing streak: ${s.longestLoss}">L${num('longestLoss', s.longestLoss)}</dd></div>
      </dl>
    </section>

    <section class="card tile area-scoring">
      <h3 class="tile__title">Scoring</h3>
      <dl class="trio">
        <div><dt>Avg Scored</dt><dd>${num('for', s.avgFor, { decimals: 1 })}</dd></div>
        <div><dt>Avg Allowed</dt><dd>${num('against', s.avgAgainst, { decimals: 1 })}</dd></div>
        <div><dt>Avg Margin</dt><dd class="${s.avgMargin >= 0 ? 'is-win' : 'is-loss'}">${num('margin', s.avgMargin, { decimals: 1, signed: true })}</dd></div>
      </dl>
    </section>

    <section class="card trend area-trend" id="trend-card" aria-labelledby="trend-title"></section>

    ${gameTile('blowout', 'Biggest Win', s.biggestWin, 'No wins yet.')}
    ${gameTile('closest', 'Closest Game', s.closest)}

    ${clutchTile()}

    <section class="card teams area-teams" id="teams-card" aria-labelledby="teams-title"></section>

    <section class="card activity area-activity" aria-labelledby="activity-title">
      <div class="activity__top">
        <h3 class="tile__title" id="activity-title">Activity</h3>
        <span class="activity__legend" aria-hidden="true">
          <span><i class="cal-key cal-key--win"></i>Won</span><span><i class="cal-key cal-key--loss"></i>Lost</span><span><i class="cal-key cal-key--split"></i>Split</span>
        </span>
      </div>
      <p class="activity__sub">Days you played, coloured by who won the day. Dots show how many games.</p>
      <div class="activity__plot" id="activity-plot"></div>
    </section>

    <section class="area-recent" aria-labelledby="recent-title">
      <div class="section-head">
        <h2 id="recent-title" class="section-title">Recent Games</h2>
        <a href="#history" class="link" data-nav="history">See All</a>
      </div>
      <ul class="list list--games" role="list">${ui.views.slice(0, 3).map(gameRow).join('')}</ul>
    </section>
  </div>`;

  animateNumbers(el);
  renderTrend();
  renderTeams();
  renderCalendar();
  const ring = $('.ring__value', el);
  requestAnimationFrame(() => requestAnimationFrame(() => ring.setAttribute('stroke-dashoffset', ring.dataset.offset)));
}

// ---------- clutch, teams ----------

function clutchTile() {
  const c = clutch(ui.views);
  const cell = (label, r, hint, key) => {
    const n = r.wins + r.losses;
    const cls = !n || r.wins === r.losses ? '' : r.wins > r.losses ? 'is-win' : 'is-loss';
    return `<div><button type="button" class="stat-link" data-clutch="${key}" aria-label="${label}: ${n ? winsLosses(r.wins, r.losses) : 'no games'}. Show games">
      <span class="trio__dt">${label}</span><span class="trio__dd ${cls}">${n ? `${r.wins}–${r.losses}` : '—'}</span><span class="trio__hint">${n ? `${Math.round((r.wins / n) * 100)}%` : hint}</span>
    </button></div>`;
  };
  return `<section class="card tile area-clutch" aria-labelledby="clutch-title">
    <h3 class="tile__title" id="clutch-title">Clutch</h3>
    <div class="trio">
      ${cell(`Close (≤${CLOSE_MARGIN})`, c.close, 'None yet', 'close')}
      ${cell('Overtime', c.overtime, 'None yet', 'overtime')}
      ${cell(`Blowouts (${BLOWOUT_MARGIN}+)`, c.blowouts, 'None yet', 'blowouts')}
    </div>
  </section>`;
}

/**
 * Best and worst team for one side. Teams with 2+ games are preferred so a single lucky game
 * doesn't top the list. For the opponent's side the record is shown from their point of view.
 */
function bestAndWorst(side) {
  let rows = teamRecords(ui.views, side);
  if (side === 'oppTeam') rows = rows.map((r) => ({ ...r, wins: r.losses, losses: r.wins, pct: r.losses / r.games }));
  const pool = rows.some((r) => r.games >= 2) ? rows.filter((r) => r.games >= 2) : rows;
  const byBest = pool.slice().sort((a, b) => b.pct - a.pct || b.games - a.games);
  const best = byBest[0] || null;
  const worst = byBest.length > 1 ? byBest.at(-1) : null;
  return { best, worst, teams: rows.length };
}

function renderTeams() {
  const card = $('#teams-card');
  if (!card) return;
  const side = ui.teamsSide;
  const mine = side === 'myTeam';
  const who = mine ? 'You' : oppName();
  const { best, worst, teams } = bestAndWorst(side);
  const opts = [
    { value: 'myTeam', label: 'You' },
    { value: 'oppTeam', label: oppName() },
  ];
  const index = opts.findIndex((o) => o.value === side);
  const row = (kind, r) => {
    if (!r) return '';
    const t = getTeam(r.abbr);
    return `<li><button type="button" class="stat-link teams__row" data-team-games="${esc(r.abbr)}" data-team-side="${side}" aria-label="${kind === 'best' ? 'Best' : 'Worst'} team: ${esc(t?.name || r.abbr)}, ${winsLosses(r.wins, r.losses)}. Show games">
      <span class="teams__kind teams__kind--${kind}">${kind === 'best' ? 'Best' : 'Worst'}</span>
      ${logo(r.abbr, { size: 'md', alt: '' })}
      <span class="teams__name"><span>${esc(t?.nickname || r.abbr)}</span><span class="teams__meta">${r.games} ${r.games === 1 ? 'game' : 'games'} · ${Math.round(r.pct * 100)}% wins</span></span>
      <span class="teams__record">${r.wins}–${r.losses}</span>
    </button></li>`;
  };
  card.innerHTML = `
    <div class="teams__top">
      <h3 class="tile__title" id="teams-title">Best &amp; Worst Teams</h3>
      <div class="seg" role="radiogroup" aria-label="Whose teams" style="--count:2;--index:${index}">
        <span class="seg__thumb" aria-hidden="true"></span>
        ${opts.map((o, i) => `<button type="button" class="seg__item" role="radio" aria-checked="${i === index}" tabindex="${i === index ? 0 : -1}" data-teams="${o.value}">${esc(o.label)}</button>`).join('')}
      </div>
    </div>
    <p class="activity__sub">${mine ? 'Teams you played as, by your win rate with them.' : `Teams ${esc(oppName())} played as, by their win rate against you.`}${teams ? ` ${teams} ${teams === 1 ? 'team' : 'teams'} used.` : ''}</p>
    ${best ? `<ul class="teams__list" role="list">${row('best', best)}${row('worst', worst)}</ul>` : `<p class="tile__empty">No games yet.</p>`}
    ${best && !worst ? `<p class="activity__sub">Play with another team to see a worst team.</p>` : ''}`;
  card.querySelectorAll('[data-teams]').forEach((b) =>
    b.addEventListener('click', () => {
      if (ui.teamsSide === b.dataset.teams) return;
      haptic('light');
      ui.teamsSide = b.dataset.teams;
      renderTeams();
    }),
  );
}

function renderCalendar() {
  const host = $('#activity-plot');
  if (!host) return;
  renderMonthCalendar(host, activityByDay(ui.views), {
    month: ui.calMonth,
    onMonth: (m) => {
      ui.calMonth = m;
      renderCalendar();
    },
  });
}

// ---------- game-list pop-ups ----------

function gamesPopup(title, subtitle, list) {
  openPopup({
    title,
    subtitle,
    body: list.length
      ? `<ul class="list list--games" role="list">${list.map((g) => staticGameRow(g, null, { withMonth: true })).join('')}</ul>`
      : '<p class="popup__empty">No games yet.</p>',
  });
}

document.addEventListener('click', (e) => {
  const clutchBtn = e.target.closest('[data-clutch]');
  if (clutchBtn) {
    const kind = clutchBtn.dataset.clutch;
    const pick = {
      close: { title: `Close Games (≤${CLOSE_MARGIN})`, test: (g) => Math.abs(g.margin) <= CLOSE_MARGIN },
      overtime: { title: 'Overtime Games', test: (g) => g.overtime },
      blowouts: { title: `Blowouts (${BLOWOUT_MARGIN}+)`, test: (g) => Math.abs(g.margin) >= BLOWOUT_MARGIN },
    }[kind];
    const list = ui.views.filter(pick.test);
    const r = record(list);
    gamesPopup(pick.title, `vs ${oppName()} · You’re ${r.wins}–${r.losses}`, list);
    return;
  }
  const teamBtn = e.target.closest('[data-team-games]');
  if (teamBtn) {
    const abbr = teamBtn.dataset.teamGames;
    const mine = teamBtn.dataset.teamSide === 'myTeam';
    const list = ui.views.filter((g) => (mine ? g.myTeam : g.oppTeam) === abbr);
    const r = record(list);
    const name = getTeam(abbr)?.name || abbr;
    gamesPopup(
      mine ? `You as the ${name}` : `${oppName()} as the ${name}`,
      mine ? `You’re ${r.wins}–${r.losses} with them` : `${oppName()} is ${r.losses}–${r.wins} with them · you’re ${r.wins}–${r.losses}`,
      list,
    );
  }
});

// ---------- over-time chart ----------

function renderTrend() {
  const card = $('#trend-card');
  if (!card || !store.rival()) return;
  renderTrendCard(card, {
    points: timeline(store.pairGames(), meId()),
    metric: ui.trend.metric,
    range: ui.trend.range,
    opponent: `vs ${oppName()}`,
    onChange: (patch) => {
      Object.assign(ui.trend, patch);
      try {
        localStorage.setItem('h2h.trend', JSON.stringify(ui.trend));
      } catch { /* private mode */ }
      renderTrend();
    },
  });
}

// Redraw the chart when its width changes (rotation, window resize, sidebar breakpoint)
let trendWidth = 0;
new ResizeObserver(() => {
  const w = $('#trend-card')?.clientWidth || 0;
  if (w && Math.abs(w - trendWidth) > 2) {
    trendWidth = w;
    renderTrend();
  }
}).observe(document.getElementById('dashboard-content'));

// ---------- history ----------

function renderHistory() {
  const el = $('#history-content');
  if (loadFailed()) {
    el.innerHTML = loadError();
    return;
  }
  if (!state.loaded) {
    el.innerHTML = `<div class="group" aria-busy="true" aria-label="Loading"><div class="group__head"><span class="skel skel--label"></span></div>${skeletonRows(6)}</div>`;
    return;
  }
  if (!store.rival()) {
    el.innerHTML = noFriendsState();
    return;
  }
  if (!ui.views.length) {
    el.innerHTML = emptyState({ iconName: 'history', text: `Games against ${oppName()} will appear here.`, button: 'Log a Game' });
    return;
  }
  const months = new Map();
  for (const g of ui.views) {
    const key = g.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(g);
  }
  el.innerHTML =
    [...months.values()]
      .map((games, i) => {
        const r = record(games);
        return `<section class="group" aria-labelledby="month-${i}">
          <div class="group__head"><h2 id="month-${i}">${monthLabel(games[0].date)}</h2><span class="group__record" aria-label="${winsLosses(r.wins, r.losses)}">${r.wins}–${r.losses}</span></div>
          <ul class="list list--games" role="list">${games.map(gameRow).join('')}</ul>
        </section>`;
      })
      .join('') +
    `<p class="list-footer">${ui.views.length} ${ui.views.length === 1 ? 'game' : 'games'} · Swipe left on a game to delete it</p>`;
}

// ---------- settings ----------

// Theme colours. Each swaps the blue accent (see the end of tokens.css); the swatch shows the
// colour as it looks in light and dark mode. Saved per device and applied before first paint.
const ACCENTS = [
  { id: 'blue', name: 'Blue', light: '#007AFF', dark: '#0A84FF' },
  { id: 'indigo', name: 'Indigo', light: '#5856D6', dark: '#5E5CE6' },
  { id: 'purple', name: 'Purple', light: '#AF52DE', dark: '#BF5AF2' },
  { id: 'pink', name: 'Pink', light: '#FF2D55', dark: '#FF375F' },
  { id: 'orange', name: 'Orange', light: '#FF9500', dark: '#FF9F0A' },
  { id: 'teal', name: 'Teal', light: '#30B0C7', dark: '#40C8E0' },
  { id: 'graphite', name: 'Graphite', light: '#8E8E93', dark: '#98989D' },
];
const ACCENT_KEY = 'h2h.accent';
const currentAccent = () => document.documentElement.dataset.accent || 'blue';
function setAccent(id) {
  if (id === 'blue') document.documentElement.removeAttribute('data-accent');
  else document.documentElement.dataset.accent = id;
  try {
    if (id === 'blue') localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, id);
  } catch {}
}

function renderSettings() {
  const el = $('#settings-content');
  const me = state.me;
  const prefs = store.getPrefs();
  const pending = store.pendingCount();
  const syncFoot =
    state.status === 'error'
      ? `<span class="is-loss">${esc(state.error)}</span>`
      : state.status === 'offline'
        ? `You’re offline.${pending ? ` ${pending} ${pending === 1 ? 'change is' : 'changes are'} saved on this device and will sync when you’re back online.` : ''}`
        : 'Games your friends log show up automatically while the app is open.';

  el.innerHTML = `
  <section class="group" aria-labelledby="set-account">
    <div class="group__head"><h2 id="set-account">Account</h2></div>
    <ul class="list" role="list">
      <li><button type="button" class="cell cell--button cell--profile" id="profile-btn" aria-label="Edit profile: ${esc(meName())}, @${esc(me?.username || '')}">${avatar(me, 'md')}<span class="cell__stack"><span class="cell__title">${esc(meName())}</span><span class="cell__sub">@${esc(me?.username || '')} · ${state.friends.length} ${state.friends.length === 1 ? 'friend' : 'friends'}</span></span><span class="cell__value">Edit</span><svg class="icon cell__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.75 6.25 6.25-6.25 6.25"/></svg></button></li>
      <li><button type="button" class="cell cell--button" id="pin-btn">${icon('key')}<span>Change PIN</span></button></li>
      <li><button type="button" class="cell cell--button" id="blocked-btn">${icon('block')}<span>Blocked Users</span></button></li>
      <li class="cell"><label for="require-pin">Require PIN on Open</label><input type="checkbox" role="switch" class="switch" id="require-pin"${prefs.requirePin ? ' checked' : ''}></li>
      <li><button type="button" class="cell cell--button cell--destructive" id="signout-btn">Sign Out</button></li>
    </ul>
    <p class="group__foot">You stay signed in on this device. Changing your PIN signs you out everywhere else. Turn on Require PIN to be asked for it each time the app opens.</p>
  </section>

  <section class="group" aria-labelledby="set-theme">
    <div class="group__head"><h2 id="set-theme">Theme</h2></div>
    <div class="list swatches" role="radiogroup" aria-labelledby="set-theme">
      ${ACCENTS.map(
        (a) => `<button type="button" class="swatch" role="radio" data-swatch="${a.id}" aria-checked="${a.id === currentAccent()}" aria-label="${a.name}" style="--sw-light:${a.light};--sw-dark:${a.dark}">${icon('check', 'swatch__check')}</button>`,
      ).join('')}
    </div>
    <p class="group__foot">Changes the app’s colour on this device.</p>
  </section>

  <section class="group" aria-labelledby="set-sync">
    <div class="group__head"><h2 id="set-sync">Sync</h2></div>
    <ul class="list" role="list">
      <li><button type="button" class="cell cell--button" id="refresh-btn">${icon('refresh')}<span>Refresh Now</span><span class="cell__value">${state.status === 'syncing' ? 'Syncing…' : `Updated ${relativeTime(state.lastSynced)}`}</span></button></li>
      ${pending ? `<li class="cell"><span>Waiting to Sync</span><span class="cell__value">${pending} ${pending === 1 ? 'change' : 'changes'}</span></li>` : ''}
    </ul>
    <p class="group__foot">${syncFoot}</p>
  </section>

  <section class="group" aria-labelledby="set-data">
    <div class="group__head"><h2 id="set-data">Data</h2></div>
    <ul class="list" role="list">
      <li><button type="button" class="cell cell--button" id="export-btn"${state.games.length ? '' : ' disabled'}>${icon('export')}<span>Export Games</span></button></li>
    </ul>
    <p class="group__foot">Downloads all your games against every friend as JSON, exactly as stored in the Sheet.</p>
  </section>

  ${
    isDemo
      ? `<section class="group" aria-labelledby="set-demo">
    <div class="group__head"><h2 id="set-demo">Demo Mode</h2></div>
    <ul class="list" role="list">
      <li class="cell"><label for="sample-toggle">Sample Data</label><input type="checkbox" role="switch" class="switch" id="sample-toggle"${demoControls.sample ? ' checked' : ''}></li>
      <li class="cell"><label for="offline-toggle">Simulate Offline</label><input type="checkbox" role="switch" class="switch" id="offline-toggle"${demoControls.offline ? ' checked' : ''}></li>
    </ul>
    <p class="group__foot">Demo data lives in this browser only. Sign out to try the other demo accounts. Add your Apps Script URL to config.js to connect the shared Google Sheet (see SETUP.md).</p>
  </section>`
      : ''
  }
  <p class="group__foot group__foot--center">Dubs 2.0 · ${isDemo ? 'Demo mode' : 'Synced with Google Sheets'}</p>`;
}

function initSettings() {
  const root = $('#settings-content');
  root.addEventListener('change', async (e) => {
    const t = e.target;
    haptic('light');
    if (t.id === 'require-pin') store.setPrefs({ requirePin: t.checked });
    if (t.id === 'sample-toggle') {
      demoControls.setSample(t.checked);
      await store.sync();
      toast(t.checked ? 'Sample games added' : 'Sample games removed');
    }
    if (t.id === 'offline-toggle') {
      demoControls.offline = t.checked;
      if (t.checked) toast('Offline simulated. New games will queue.');
      else store.sync();
    }
  });
  root.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-swatch]');
    if (swatch) {
      haptic('light');
      setAccent(swatch.dataset.swatch);
      root.querySelectorAll('[data-swatch]').forEach((b) => b.setAttribute('aria-checked', String(b === swatch)));
      return;
    }
    const id = e.target.closest('button')?.id;
    if (id === 'refresh-btn') {
      haptic('light');
      store.sync();
    }
    if (id === 'export-btn') exportGames();
    if (id === 'signout-btn') confirmSignOut();
    if (id === 'profile-btn') openProfileSheet();
    if (id === 'pin-btn') changePin();
    if (id === 'blocked-btn') openBlockedSheet();
  });
}

async function changePin() {
  if (!navigator.onLine) return toast('You’re offline. Changing your PIN needs a connection.');
  if (await changePinFlow()) {
    haptic('success');
    toast('PIN changed. Other devices were signed out.');
  }
}

function openProfileSheet() {
  if (document.documentElement.classList.contains('has-modal')) return;
  const me = state.me;
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-sheet="cancel">Cancel</button>
      <h2 id="profile-title" class="sheet__title">Edit Profile</h2>
      <button type="submit" form="profile-form" class="btn-text btn-text--strong" data-sheet="save">Save</button>
    </header>
    <form id="profile-form" class="sheet__body profile-form" novalidate autocomplete="off">
      <div class="profile-form__avatar" data-avatar-preview>${avatar(me, 'xl')}</div>
      <ul class="list list--form" role="list">
        <li class="cell"><label for="pf-name">Name</label><input id="pf-name" name="displayName" class="cell__input" value="${esc(me.display_name)}" maxlength="24" autocomplete="nickname" enterkeyhint="next" required></li>
        <li class="cell"><label for="pf-username">Username</label><span class="cell__input-group"><span class="cell__prefix" aria-hidden="true">@</span><input id="pf-username" name="username" class="cell__input" value="${esc(me.username)}" maxlength="20" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" required></span></li>
      </ul>
      <p class="auth-help">Usernames are 3–20 letters, numbers, dots or underscores. Friends can find you by either one.</p>
      <div class="group__head"><h3 id="pf-avatar-title">Profile Picture</h3></div>
      <div class="list avatar-grid" role="radiogroup" aria-labelledby="pf-avatar-title">
        ${['', ...AVATARS]
          .map(
            (id, i) => `<button type="button" class="avatar-pick" role="radio" data-pick-avatar="${id}" aria-checked="${id === (me.avatar || '')}" aria-label="${id ? `Avatar ${i}` : 'Your initial'}">${avatar({ ...me, avatar: id }, 'lg')}</button>`,
          )
          .join('')}
      </div>
      <p class="auth-error" role="alert"></p>
    </form>`;
  const form = $('form', content);
  const err = $('.auth-error', content);
  let picked = me.avatar || '';
  // The preview (and the "initial" choice) follow the name as you type it
  const draftUser = () => {
    const name = form.displayName.value.trim();
    return { ...me, display_name: name, initial: (name[0] || '?').toUpperCase() };
  };
  const paintAvatars = () => {
    $('[data-avatar-preview]', content).innerHTML = avatar({ ...draftUser(), avatar: picked }, 'xl');
    $('[data-pick-avatar=""]', content).innerHTML = avatar({ ...draftUser(), avatar: '' }, 'lg');
  };
  form.username.addEventListener('input', () => {
    form.username.value = form.username.value.toLowerCase().replace(/[^a-z0-9_.]/g, '');
  });
  form.displayName.addEventListener('input', paintAvatars);
  content.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick-avatar]');
    if (!btn) return;
    haptic('light');
    picked = btn.dataset.pickAvatar;
    $$('[data-pick-avatar]', content).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    paintAvatars();
  });

  const sheet = openSheet({ content, labelledBy: 'profile-title', initialFocus: '#pf-name' });
  content.addEventListener('click', (e) => e.target.closest('[data-sheet="cancel"]') && sheet.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = form.displayName.value.trim().replace(/\s+/g, ' ');
    const username = form.username.value.trim();
    if (!displayName) return (err.textContent = 'Enter your name.');
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) return (err.textContent = 'Usernames are 3–20 letters, numbers, dots or underscores.');
    const patch = {};
    if (displayName !== me.display_name) patch.displayName = displayName;
    if (username !== me.username) patch.username = username;
    if (picked !== (me.avatar || '')) patch.avatar = picked;
    if (!Object.keys(patch).length) return sheet.close();
    const save = $('[data-sheet="save"]', content);
    save.disabled = true;
    err.textContent = '';
    try {
      await store.updateProfile(patch);
      haptic('success');
      sheet.close();
      toast(patch.username ? `You’re now @${username}` : 'Profile updated');
    } catch (ex) {
      haptic('warning');
      err.textContent = ex.code === 'network' ? 'You’re offline. Try again when you’re connected.' : ex.message;
      save.disabled = false;
    }
  });
}

async function confirmSignOut() {
  const pending = store.pendingCount();
  const ok = await alertDialog({
    title: 'Sign Out?',
    message: pending
      ? `${pending} ${pending === 1 ? 'change hasn’t' : 'changes haven’t'} synced yet. They’ll stay on this device and sync after the next sign-in.`
      : 'You can sign back in with your username and PIN.',
    actions: [{ label: 'Cancel', value: false, style: 'cancel' }, { label: 'Sign Out', value: true, style: 'destructive' }],
  });
  if (ok) store.signOut();
}

async function exportGames() {
  const data = {
    app: 'h2h',
    version: 2,
    exportedAt: new Date().toISOString(),
    exportedBy: state.me,
    friends: state.friends,
    games: state.games.map(({ _pending, ...g }) => g),
  };
  const name = `dubs-games-${todayISO()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Dubs games' });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${data.games.length} games`);
}

// ---------- delete with undo ----------

async function removeGame(id) {
  haptic('medium');
  const rows = $$(`.row-wrap[data-id="${id}"]`);
  rows.forEach((r) => r.classList.add('is-leaving'));
  if (!reducedMotion.matches && rows.length) await new Promise((r) => setTimeout(r, 320));
  const game = store.deleteGame(id);
  if (game) toast('Game deleted', { action: { label: 'Undo', onClick: () => store.restoreGame(game) } });
}

// ---------- swipe to delete ----------

/** A drag shouldn't also count as a tap. */
function swallowClick(el) {
  const block = (ev) => (ev.stopPropagation(), ev.preventDefault());
  el.addEventListener('click', block, { capture: true, once: true });
  setTimeout(() => el.removeEventListener('click', block, { capture: true }), 60);
}

const ACTION_W = 88;
function initSwipe() {
  let s = null;
  const closeOpen = (except) =>
    $$('.row-wrap.is-open').forEach((w) => {
      if (w === except) return;
      w.classList.remove('is-open');
      $('.row', w).style.transform = '';
      w.style.removeProperty('--reveal');
    });

  document.addEventListener('pointerdown', (e) => {
    const wrap = e.target.closest('.row-wrap');
    closeOpen(wrap);
    if (!wrap || e.button !== 0 || e.target.closest('.row-delete') || wrap.querySelector('.row--static')) return;
    const row = $('.row', wrap);
    s = { wrap, row, x0: e.clientX, y0: e.clientY, base: wrap.classList.contains('is-open') ? -ACTION_W : 0, x: 0, lock: null, id: e.pointerId, armed: false };
  });

  document.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.lock) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        s.lock = 'x';
        s.row.setPointerCapture(e.pointerId);
        s.wrap.classList.add('is-dragging');
      } else if (Math.abs(dy) > 8) {
        s = null;
        return;
      } else return;
    }
    let x = s.base + dx;
    if (x > 0) x /= 5; // resist swiping right
    s.x = x;
    s.row.style.transform = `translate3d(${x}px,0,0)`;
    s.wrap.style.setProperty('--reveal', `${Math.max(0, -x)}px`);
    const armed = -x > s.wrap.offsetWidth * 0.55;
    if (armed !== s.armed) {
      s.armed = armed;
      s.wrap.classList.toggle('is-armed', armed);
      if (armed) haptic('medium');
    }
  });

  const finish = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const { wrap, row, lock, x, armed } = s;
    s = null;
    if (lock !== 'x') return;
    wrap.classList.remove('is-dragging', 'is-armed');
    swallowClick(row);
    if (armed) {
      row.style.transform = `translate3d(${-wrap.offsetWidth}px,0,0)`;
      wrap.style.setProperty('--reveal', `${wrap.offsetWidth}px`);
      removeGame(wrap.dataset.id);
    } else if (-x > ACTION_W / 2) {
      wrap.classList.add('is-open');
      row.style.transform = `translate3d(${-ACTION_W}px,0,0)`;
      wrap.style.setProperty('--reveal', `${ACTION_W}px`);
      haptic('light');
    } else {
      wrap.classList.remove('is-open');
      row.style.transform = '';
      wrap.style.removeProperty('--reveal');
    }
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

// ---------- game sheet ----------

function teamTile(side, abbr, opponentName = oppName()) {
  const team = getTeam(abbr);
  const who = side === 'myTeam' ? 'Your team' : `${opponentName}’s team`;
  return `<button type="button" class="team-tile${team ? '' : ' is-empty'}" data-pick="${side}" aria-label="${esc(who)}: ${team ? esc(team.name) : 'none chosen'}. Change team">
    ${team ? logo(abbr, { size: 'xl', alt: '' }) : `<span class="team-tile__placeholder">${icon('log')}</span>`}
    <span class="team-tile__name">${team ? esc(team.nickname) : 'Choose Team'}</span>
  </button>`;
}

/** `id` edits an existing game; otherwise a new game pre-filled with the last matchup. */
function openGameSheet({ id = null } = {}) {
  if (document.documentElement.classList.contains('has-modal') || !state.session || isLocked()) return;
  if (!store.rival()) {
    toast('Add a friend first, then log your games against them.');
    show('friends');
    return;
  }
  const source = id ? state.games.find((g) => g.id === id) : null;
  if (id && !source) return;
  const editing = Boolean(source);
  const view = ui.views.find((g) => g.id === id);
  // Who the game is against: fixed when editing; for a new game it starts as the current rivalry
  // and can be switched by tapping the opponent's name.
  const otherId = editing ? (source.player1_id === meId() ? source.player2_id : source.player1_id) : state.rivalId;
  let opponent = state.friends.find((f) => f.id === otherId) || store.rival();
  const lastVs = (fid) => views(store.pairGames(fid), meId())[0];
  const last = lastVs(opponent.id);
  const draft = editing
    ? { date: view.date, myTeam: view.myTeam, oppTeam: view.oppTeam, myScore: view.myScore, oppScore: view.oppScore, overtime: view.overtime, note: view.note }
    : { date: todayISO(), myTeam: last?.myTeam ?? ui.views[0]?.myTeam ?? null, oppTeam: last?.oppTeam ?? null, myScore: '', oppScore: '', overtime: false, note: '' };
  const opp = opponent.display_name;
  const canSwitch = !editing && state.friends.length > 1;

  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-sheet="cancel">Cancel</button>
      <h2 id="game-sheet-title" class="sheet__title">${editing ? 'Edit Game' : 'New Game'}</h2>
      <button type="submit" form="game-form" class="btn-text btn-text--strong" data-sheet="save" disabled>Save</button>
    </header>
    <form id="game-form" class="sheet__body game-form" novalidate autocomplete="off">
      <div class="matchup">
        <div class="side">
          <span class="side__name">You</span>
          <div class="side__tile" data-slot="myTeam">${teamTile('myTeam', draft.myTeam)}</div>
          <input class="score-input" id="score-me" name="myScore" inputmode="numeric" pattern="[0-9]*" maxlength="3" enterkeyhint="next" placeholder="0" aria-label="Your score" value="${draft.myScore}">
        </div>
        <span class="matchup__vs" aria-hidden="true">VS</span>
        <div class="side">
          ${
            canSwitch
              ? `<button type="button" class="side__name side__name--switch" data-pick-opp aria-label="Playing against ${esc(opp)}. Change opponent"><span data-opp-name>${esc(opp)}</span><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6.75 9.75 5.25 5.25 5.25-5.25"/></svg></button>`
              : `<span class="side__name">${esc(opp)}</span>`
          }
          <div class="side__tile" data-slot="oppTeam">${teamTile('oppTeam', draft.oppTeam, opp)}</div>
          <input class="score-input" id="score-opp" name="oppScore" inputmode="numeric" pattern="[0-9]*" maxlength="3" enterkeyhint="done" placeholder="0" aria-label="${esc(opp)}’s score" value="${draft.oppScore}">
        </div>
      </div>
      <p class="form-hint" role="status" aria-live="polite"></p>

      <ul class="list list--form" role="list">
        <li class="cell"><label for="g-date">Date</label><input type="date" id="g-date" name="date" class="date-input" value="${draft.date}" max="${todayISO()}" required></li>
        <li class="cell"><label for="g-ot">Overtime</label><input type="checkbox" role="switch" class="switch" id="g-ot" name="overtime"${draft.overtime ? ' checked' : ''}></li>
        <li class="cell"><label for="g-note" class="visually-hidden">Note</label><input id="g-note" name="note" class="cell__input cell__input--full" placeholder="Note (optional)" maxlength="80" value="${esc(draft.note)}" enterkeyhint="done"></li>
      </ul>

      <button type="submit" class="btn btn--primary btn--block" data-sheet="save" disabled>${editing ? 'Save Changes' : 'Save Game'}</button>
      ${editing ? `<button type="button" class="btn btn--plain-destructive btn--block" data-sheet="delete">Delete Game</button>` : ''}
    </form>`;

  const form = $('form', content);
  const hint = $('.form-hint', content);
  const saveBtns = $$('[data-sheet="save"]', content);

  const read = () => ({
    ...draft,
    myScore: form.myScore.value,
    oppScore: form.oppScore.value,
    date: form.date.value,
    overtime: form.overtime.checked,
    note: form.note.value.trim(),
  });

  const validate = () => {
    const d = read();
    const filled = d.myScore !== '' && d.oppScore !== '';
    const tie = filled && +d.myScore === +d.oppScore;
    const ok = filled && !tie && d.myTeam && d.oppTeam && d.date;
    hint.textContent = tie ? 'Basketball has no ties. Someone has to win.' : '';
    saveBtns.forEach((b) => (b.disabled = !ok));
    return ok;
  };

  for (const input of $$('.score-input', content)) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 3);
      validate();
    });
    input.addEventListener('focus', () => input.select());
  }
  form.myScore.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), form.oppScore.focus()));
  form.addEventListener('input', validate);
  form.addEventListener('change', validate);

  const sheet = openSheet({ content, labelledBy: 'game-sheet-title', initialFocus: '#score-me' });

  content.addEventListener('click', async (e) => {
    const oppBtn = e.target.closest('[data-pick-opp]');
    if (oppBtn) {
      const chosen = await openOpponentPicker(opponent.id);
      if (!chosen || chosen.id === opponent.id) return;
      opponent = chosen;
      $('[data-opp-name]', oppBtn).textContent = chosen.display_name;
      oppBtn.setAttribute('aria-label', `Playing against ${chosen.display_name}. Change opponent`);
      form.oppScore.setAttribute('aria-label', `${chosen.display_name}’s score`);
      // Pre-fill the teams from your last game against this friend
      const prev = lastVs(chosen.id);
      if (prev) Object.assign(draft, { myTeam: prev.myTeam, oppTeam: prev.oppTeam });
      for (const side of ['myTeam', 'oppTeam']) $(`[data-slot="${side}"]`, content).innerHTML = teamTile(side, draft[side], chosen.display_name);
      const tile = $('[data-slot="oppTeam"] .team-tile', content);
      tile.classList.add('is-popping');
      tile.addEventListener('animationend', () => tile.classList.remove('is-popping'), { once: true });
      oppBtn.focus({ preventScroll: true });
      validate();
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const side = pick.dataset.pick;
      const chosen = await openTeamPicker(side, draft[side], opponent);
      if (!chosen) return;
      draft[side] = chosen;
      const slot = $(`[data-slot="${side}"]`, content);
      slot.innerHTML = teamTile(side, chosen, opponent.display_name);
      const tile = $('.team-tile', slot);
      tile.classList.add('is-popping');
      tile.addEventListener('animationend', () => tile.classList.remove('is-popping'), { once: true });
      tile.focus({ preventScroll: true });
      validate();
      return;
    }
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'cancel') sheet.close();
    if (act === 'delete') {
      sheet.close();
      removeGame(source.id);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate()) {
      haptic('warning');
      return;
    }
    const d = read();
    // Back from "me vs opponent" to the neutral player1/player2 shape.
    // Edits keep the game's original orientation; new games put the logger in player1.
    const mine = editing && source.player2_id === meId() ? 2 : 1;
    const theirs = mine === 1 ? 2 : 1;
    const neutral = {
      date: d.date,
      overtime: d.overtime,
      note: d.note,
      [`player${mine}_id`]: meId(),
      [`player${theirs}_id`]: opponent.id,
      [`player${mine}_score`]: Number(d.myScore),
      [`player${theirs}_score`]: Number(d.oppScore),
      [`player${mine}_team`]: d.myTeam,
      [`player${theirs}_team`]: d.oppTeam,
    };
    if (editing) store.updateGame({ ...neutral, id: source.id });
    else {
      store.addGame(neutral);
      if (opponent.id !== state.rivalId) store.setRival(opponent.id); // show the rivalry you just logged
    }
    haptic('success');
    sheet.close();
  });

  validate();
}

// ---------- profiles ----------

/**
 * Read-only game row. With `opponents` (a Map of users) it also says who the game was against.
 * `withMonth` shows the month under the day instead of the weekday (for lists that span months).
 */
function staticGameRow(g, opponents = null, { withMonth = false } = {}) {
  const opp = opponents?.get(g.oppId);
  const oppLabel = opponents ? (g.oppId === meId() ? 'You' : opp?.display_name || 'Unknown') : null;
  const meta = [oppLabel && `vs ${oppLabel}`, g.note].filter(Boolean).join(' · ');
  const under = withMonth ? fmt(g.date, { month: 'short' }) : fmt(g.date, { weekday: 'short' });
  return `<li class="row-wrap"><div class="row-clip"><div class="row row--static" aria-label="${esc(longDate(g.date))}: ${g.myScore} to ${g.oppScore}, ${g.win ? 'win' : 'loss'}${g.overtime ? ' in overtime' : ''}">
    <span class="row__date"><span class="row__day">${asDate(g.date).getDate()}</span><span class="row__dow">${under}</span></span>
    <span class="row__main">
      <span class="row__match">
        ${logo(g.myTeam, { size: 'sm', alt: getTeam(g.myTeam)?.name })}
        <span class="row__score"><span class="num num--end ${g.win ? 'is-winner' : ''}">${g.myScore}</span><span class="row__dash">–</span><span class="num ${g.win ? '' : 'is-winner'}">${g.oppScore}</span></span>
        ${logo(g.oppTeam, { size: 'sm', alt: getTeam(g.oppTeam)?.name })}
      </span>
      ${meta ? `<span class="row__meta"><span class="row__note">${esc(meta)}</span></span>` : ''}
    </span>
    ${resultPills(g)}
  </div></div></li>`;
}

/**
 * Friend profile page, shown inside the Friends tab (#friends/<id>). Everything is from that
 * person's side. The chips at the top switch between their overall stats and each rivalry.
 */
const fp = { userId: null, sel: null, data: null, error: null, trend: { metric: 'winPct', range: 'All' }, listScroll: 0 };

function openProfile(userId) {
  if (userId !== meId() && !state.friends.some((f) => f.id === userId)) return;
  history.pushState({ profile: true }, '', `#friends/${userId}`);
  show('friends', userId);
  haptic('light');
}

function closeProfile() {
  if (history.state?.profile) history.back(); // hashchange brings back the list
  else show('friends', null);
}

/** Shows the profile page for `userId`, or the friends list when it's null. */
function showProfilePage(userId) {
  const screen = $('.screen[data-screen="friends"]');
  const scroller = $('.scroller', screen);
  const page = $('#friend-page');
  const isMe = userId === meId();
  const friend = !userId ? null : isMe ? state.me : state.friends.find((f) => f.id === userId);
  if (!friend) {
    if (!fp.userId) return;
    Object.assign(fp, { userId: null, data: null, error: null });
    screen.classList.remove('is-subpage');
    page.hidden = true;
    page.innerHTML = '';
    $('#friends-content').hidden = false;
    $('#friends-navtitle').textContent = 'Friends';
    scroller.scrollTop = fp.listScroll;
    return;
  }
  document.title = `${isMe ? 'My Profile' : friend.display_name} · Dubs`;
  if (fp.userId === userId) return; // already showing it (e.g. back from another tab)
  if (!fp.userId) fp.listScroll = scroller.scrollTop;
  Object.assign(fp, { userId, sel: null, data: store.cachedProfile(userId), error: null, trend: { metric: 'winPct', range: 'All' } });
  screen.classList.add('is-subpage');
  $('#friends-content').hidden = true;
  page.hidden = false;
  $('#friends-navtitle').textContent = isMe ? 'My Profile' : friend.display_name;
  scroller.scrollTop = 0;
  paintProfile();
  loadProfile();
}

async function loadProfile() {
  const id = fp.userId;
  try {
    const data = await store.getProfile(id);
    if (fp.userId !== id) return;
    Object.assign(fp, { data, error: null });
  } catch (err) {
    if (fp.userId !== id || fp.data) return;
    fp.error = err.code === 'network' ? 'You’re offline. Profiles need a connection.' : err.message;
  }
  paintProfile();
}

function paintProfile() {
  const page = $('#friend-page');
  const isMe = fp.userId === meId();
  const friend = isMe ? state.me : state.friends.find((f) => f.id === fp.userId);
  const head = `<div class="profile__head">${avatar(friend, 'xl')}<h2 class="profile__name">${esc(friend.display_name)}</h2><p class="profile__user">@${esc(friend.username)}</p></div>`;
  if (!fp.data) {
    page.innerHTML = `<div class="fpage">${head}${
      fp.error
        ? `<div class="empty empty--compact"><p class="empty__text">${esc(fp.error)}</p><button type="button" class="btn btn--tinted" data-fp-retry>Try Again</button></div>`
        : '<p class="search-note"><span class="spinner spinner--sm" aria-hidden="true"></span> Loading stats…</p>'
    }</div>`;
    return;
  }

  const { user, opponents: oppList, games: allGames } = fp.data;
  const opponents = new Map(oppList.map((u) => [u.id, u]));
  const opps = opponentRecords(views(allGames, user.id));
  if (fp.sel && !opps.some((o) => o.id === fp.sel)) fp.sel = null;
  const sel = fp.sel;
  const label = (id) => (id === meId() ? 'You' : opponents.get(id)?.display_name || 'Unknown');
  const involves = (g, id) => g.player1_id === id || g.player2_id === id;
  const games = sel ? allGames.filter((g) => involves(g, user.id) && involves(g, sel)) : allGames;
  const v = views(games, user.id);
  const st = computeStats(games, user.id);
  const name = isMe ? 'You' : user.display_name;

  const chipsScroll = $('.rchips', page)?.scrollLeft || 0;
  const chips = opps.length
    ? `<div class="rchips" role="toolbar" aria-label="Rivalries">
        <button type="button" class="rchip" data-fp-sel="" aria-pressed="${!sel}">Everyone</button>
        ${opps.map((o) => `<button type="button" class="rchip" data-fp-sel="${esc(o.id)}" aria-pressed="${sel === o.id}">${isMe ? 'vs ' : ''}${esc(label(o.id))}</button>`).join('')}
      </div>`
    : '';

  if (!st.total) {
    page.innerHTML = `<div class="fpage">${head}<p class="search-note">${isMe ? 'You haven’t' : `${esc(user.display_name)} hasn’t`} played any games yet.</p></div>`;
    return;
  }

  const pct = Math.round(st.pct * 100);
  const teams = teamRecords(v, 'myTeam');
  const pool = teams.some((r) => r.games >= 2) ? teams.filter((r) => r.games >= 2) : teams;
  const ranked = pool.slice().sort((a, b) => b.pct - a.pct || b.games - a.games);
  const best = ranked[0], worst = ranked.length > 1 ? ranked.at(-1) : null;
  const teamRow = (kind, r) =>
    r
      ? `<li class="teams__row"><span class="teams__kind teams__kind--${kind}">${kind === 'best' ? 'Best' : 'Worst'}</span>${logo(r.abbr, { size: 'md', alt: '' })}
          <span class="teams__name"><span>${esc(getTeam(r.abbr)?.nickname || r.abbr)}</span><span class="teams__meta">${r.games} ${r.games === 1 ? 'game' : 'games'} · ${Math.round(r.pct * 100)}% wins</span></span>
          <span class="teams__record" aria-label="${winsLosses(r.wins, r.losses)}">${r.wins}–${r.losses}</span></li>`
      : '';
  const vsMe = !isMe && (!sel || sel === meId()) && opps.find((o) => o.id === meId());
  const months = new Map();
  for (const g of v) {
    const k = g.date.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(g);
  }
  const vsText = sel ? `vs ${label(sel)}` : 'vs everyone';

  page.innerHTML = `<div class="fpage">
    ${head}
    ${chips}
    <section class="card hero" aria-label="${sel ? `Record ${esc(vsText)}` : 'Overall record'}">
      <div class="hero__top">
        <div class="ring" role="img" aria-label="Win rate ${pct} percent">
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring__track" cx="60" cy="60" r="52"/><circle class="ring__value" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - pct / 100)}"/></svg>
          <span class="ring__label" aria-hidden="true"><span class="ring__pct">${pct}<span class="ring__unit">%</span></span><span class="ring__caption">Win Rate</span></span>
        </div>
        <div class="hero__record">
          <p class="eyebrow">${sel ? `Record ${esc(vsText)}` : 'Overall Record'}</p>
          <p class="record" aria-label="${winsLosses(st.wins, st.losses)}">${st.wins}<span class="record__dash">–</span>${st.losses}</p>
          <p class="hero__sub">${st.total} ${st.total === 1 ? 'game' : 'games'}${sel ? ` · ${isMe ? 'your' : `${esc(name)}’s`} side` : ` · ${opps.length} ${opps.length === 1 ? 'opponent' : 'opponents'}`}</p>
        </div>
      </div>
      <dl class="hero__streaks">
        <div><dt>Current Streak</dt><dd class="${st.streak.win ? 'is-win' : 'is-loss'}">${st.streak.win ? 'W' : 'L'}${st.streak.count}</dd></div>
        <div><dt>Longest Win</dt><dd class="${st.longestWin ? 'is-win' : ''}">W${st.longestWin}</dd></div>
        <div><dt>Longest Loss</dt><dd class="${st.longestLoss ? 'is-loss' : ''}">L${st.longestLoss}</dd></div>
      </dl>
    </section>

    ${
      vsMe
        ? `<button type="button" class="card profile__vs" data-profile-rivalry>
            <span class="cell__stack"><span class="tile__title">Against you</span><span class="profile__vs-record">${esc(user.display_name)} is ${vsMe.wins}–${vsMe.losses} vs you</span></span>
            <span class="link">Open Rivalry</span></button>`
        : ''
    }

    <section class="card tile">
      <h3 class="tile__title">Scoring</h3>
      <dl class="trio">
        <div><dt>Avg Scored</dt><dd>${formatNumber(st.avgFor, { decimals: 1 })}</dd></div>
        <div><dt>Avg Allowed</dt><dd>${formatNumber(st.avgAgainst, { decimals: 1 })}</dd></div>
        <div><dt>Avg Margin</dt><dd class="${st.avgMargin >= 0 ? 'is-win' : 'is-loss'}">${formatNumber(st.avgMargin, { decimals: 1, signed: true })}</dd></div>
      </dl>
    </section>

    <section class="card trend" data-profile-trend aria-labelledby="profile-trend-title"></section>

    <section class="card teams" aria-labelledby="profile-teams-title">
      <h3 class="tile__title" id="profile-teams-title">Best &amp; Worst Teams</h3>
      <ul class="teams__list" role="list">${teamRow('best', best)}${teamRow('worst', worst)}</ul>
    </section>

    ${
      sel
        ? ''
        : `<section class="group" aria-labelledby="profile-opps-title">
      <div class="group__head"><h2 id="profile-opps-title">Played Against</h2><span class="group__record">${opps.length}</span></div>
      <ul class="list list--friends" role="list">
        ${opps
          .map((o) => {
            const u = o.id === meId() ? state.me : opponents.get(o.id);
            const cls = o.wins === o.losses ? '' : o.wins > o.losses ? 'is-win' : 'is-loss';
            return `<li><button type="button" class="cell cell--plain friend-row" data-fp-sel="${esc(o.id)}" aria-label="${esc(label(o.id))}: ${winsLosses(o.wins, o.losses)}. Show this rivalry">${avatar(u, 'md')}<span class="cell__stack"><span class="cell__title">${esc(label(o.id))}</span><span class="cell__sub">${u ? `@${esc(u.username)} · ` : ''}${o.games} ${o.games === 1 ? 'game' : 'games'}</span></span>
              <span class="friend-row__record ${cls}">${o.wins}–${o.losses}</span></button></li>`;
          })
          .join('')}
      </ul>
      <p class="group__foot">Records are from ${isMe ? 'your' : `${esc(user.display_name)}’s`} side.</p>
    </section>`
    }

    ${[...months.values()]
      .map((list, i) => {
        const r = record(list);
        return `<section class="group" aria-labelledby="pm-${i}">
          <div class="group__head"><h2 id="pm-${i}">${monthLabel(list[0].date)}</h2><span class="group__record">${r.wins}–${r.losses}</span></div>
          <ul class="list list--games" role="list">${list.map((g) => staticGameRow(g, sel ? null : opponents)).join('')}</ul>
        </section>`;
      })
      .join('')}
  </div>`;

  const chipRow = $('.rchips', page);
  if (chipRow) chipRow.scrollLeft = chipsScroll;
  const drawTrend = () =>
    renderTrendCard($('[data-profile-trend]', page), {
      points: timeline(games, user.id),
      metric: fp.trend.metric,
      range: fp.trend.range,
      opponent: vsText,
      titleId: 'profile-trend-title',
      onChange: (patch) => (Object.assign(fp.trend, patch), drawTrend()),
    });
  drawTrend();
}

function initProfilePage() {
  $('#friend-back').addEventListener('click', () => {
    haptic('light');
    closeProfile();
  });
  $('#friend-page').addEventListener('click', (e) => {
    const selBtn = e.target.closest('[data-fp-sel]');
    if (selBtn) {
      const id = selBtn.dataset.fpSel || null;
      if (id === fp.sel) return;
      haptic('light');
      fp.sel = id;
      paintProfile();
      const chip = $(`.rchip[data-fp-sel="${id || ''}"]`, e.currentTarget);
      chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Picked from the Played Against list: go back up to the stats
      if (!selBtn.classList.contains('rchip')) $('.screen[data-screen="friends"] .scroller').scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      return;
    }
    if (e.target.closest('[data-fp-retry]')) {
      fp.error = null;
      paintProfile();
      loadProfile();
      return;
    }
    if (e.target.closest('[data-profile-rivalry]')) {
      store.setRival(fp.userId);
      show('dashboard');
    }
  });
}

// ---------- opponent picker ----------

/** Pick which friend a new game is against. Resolves the friend, or null if cancelled. */
function openOpponentPicker(currentId) {
  return new Promise((resolve) => {
    const friends = state.friends.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
    const content = document.createElement('div');
    content.className = 'sheet__content';
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-sheet="cancel">Cancel</button>
        <h2 id="opp-title" class="sheet__title">Playing Against</h2>
        <span></span>
      </header>
      <div class="sheet__body">
        <ul class="list list--friends list--sheet" role="list">
          ${friends
            .map((f) => {
              const r = friendRecord(f.id);
              const on = f.id === currentId;
              return `<li><button type="button" class="cell cell--button friend-row" data-opp="${esc(f.id)}" aria-label="${esc(f.display_name)}, @${esc(f.username)}. Your record ${winsLosses(r.wins, r.losses)}"${on ? ' aria-current="true"' : ''}>
                ${avatar(f, 'md')}
                <span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span>
                <span class="friend-row__record ${r.wins + r.losses ? (r.wins >= r.losses ? 'is-win' : 'is-loss') : ''}">${r.wins + r.losses ? `${r.wins}–${r.losses}` : 'New'}</span>
                ${on ? icon('check', 'friend-row__check') : '<span class="friend-row__check" aria-hidden="true"></span>'}
              </button></li>`;
            })
            .join('')}
        </ul>
      </div>`;
    let chosen = null;
    const sheet = openSheet({ content, labelledBy: 'opp-title', onClose: () => resolve(chosen) });
    content.addEventListener('click', (e) => {
      const b = e.target.closest('[data-opp]');
      if (b) {
        chosen = state.friends.find((f) => f.id === b.dataset.opp) || null;
        haptic('light');
        sheet.close();
      } else if (e.target.closest('[data-sheet="cancel"]')) sheet.close();
    });
  });
}

// ---------- team picker ----------

function openTeamPicker(side, current, opponent = store.rival()) {
  return new Promise((resolve) => {
    const whose = side === 'myTeam' ? 'You' : opponent?.display_name || oppName();
    const recent = recentTeams(opponent ? views(store.pairGames(opponent.id), meId()) : ui.views, side, 5);
    const cell = (team, lazy) => {
      const selected = team.abbr === current;
      return `<button type="button" class="team-cell${selected ? ' is-selected' : ''}" data-abbr="${team.abbr}" aria-label="${esc(team.name)}"${selected ? ' aria-current="true"' : ''}>
        ${logo(team.abbr, { size: 'md', alt: '', lazy })}<span class="team-cell__abbr">${team.abbr}</span></button>`;
    };

    const content = document.createElement('div');
    content.className = 'sheet__content';
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-sheet="cancel">Cancel</button>
        <div class="sheet__title-group"><h2 id="picker-title" class="sheet__title">Choose Team</h2><p class="sheet__subtitle">${esc(whose)}</p></div>
        <span></span>
      </header>
      <div class="sheet__body picker">
        <div class="search">
          ${icon('search')}
          <input type="search" id="team-search" placeholder="Search teams" aria-label="Search teams by city, name, or abbreviation" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
          <button type="button" class="search__clear" aria-label="Clear search" hidden>${icon('clear')}</button>
        </div>
        ${recent.length ? `<section class="picker__section" data-recent aria-labelledby="recent-teams"><h3 class="picker__label" id="recent-teams">Recent</h3><div class="team-grid">${recent.map((a) => cell(getTeam(a), false)).join('')}</div></section>` : ''}
        <section class="picker__section" aria-labelledby="all-teams">
          <h3 class="picker__label" id="all-teams">All Teams</h3>
          <div class="team-grid" data-grid>${TEAMS.map((t) => cell(t, true)).join('')}</div>
          <p class="picker__empty" hidden></p>
        </section>
      </div>`;

    let chosen = null;
    const sheet = openSheet({ content, labelledBy: 'picker-title', large: true, initialFocus: '#team-search', onClose: () => resolve(chosen) });

    const search = $('#team-search', content);
    const clear = $('.search__clear', content);
    const grid = $('[data-grid]', content);
    const empty = $('.picker__empty', content);
    const recentSection = $('[data-recent]', content);

    const filter = () => {
      const q = search.value;
      const matches = searchTeams(q);
      const order = new Map(matches.map((t, i) => [t.abbr, i]));
      for (const btn of grid.children) {
        const i = order.get(btn.dataset.abbr);
        btn.hidden = i === undefined;
        btn.style.order = i ?? 0;
      }
      clear.hidden = !q;
      if (recentSection) recentSection.hidden = Boolean(q.trim());
      empty.hidden = matches.length > 0;
      empty.textContent = matches.length ? '' : `No teams match “${q.trim()}”`;
    };
    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = [...grid.children].filter((b) => !b.hidden).sort((a, b) => a.style.order - b.style.order)[0];
      first?.click();
    });
    clear.addEventListener('click', () => {
      search.value = '';
      filter();
      search.focus();
    });

    content.addEventListener('click', (e) => {
      const btn = e.target.closest('.team-cell');
      if (btn) {
        chosen = btn.dataset.abbr;
        haptic('light');
        sheet.close();
      } else if (e.target.closest('[data-sheet="cancel"]')) sheet.close();
    });
  });
}

// ---------- sidebar profile ----------

function renderSidebarProfile() {
  const me = state.me;
  $('#sidebar-profile').innerHTML = me
    ? `${avatar(me, 'sm')}<span class="sidebar__who"><span class="sidebar__name">${esc(me.display_name)}</span><span class="sidebar__vs">@${esc(me.username)}</span></span>`
    : '';
}

// ---------- friends ----------

function friendRecord(friendId) {
  return record(views(store.pairGames(friendId), meId()));
}

function friendRow(f, { chevron = true, more = false, action = 'open-rival' } = {}) {
  const r = friendRecord(f.id);
  const current = f.id === state.rivalId;
  const verb = action === 'open-profile' ? 'Open profile' : 'Open rivalry';
  return `<li class="friend-item"><button type="button" class="cell cell--button friend-row" data-action="${action}" data-id="${esc(f.id)}" aria-label="${esc(f.display_name)}, @${esc(f.username)}. Your record ${winsLosses(r.wins, r.losses)}.${current ? ' Current rivalry.' : ''} ${verb}">
    ${avatar(f, 'md')}
    <span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span>
    <span class="friend-row__record ${r.wins + r.losses ? (r.wins >= r.losses ? 'is-win' : 'is-loss') : ''}">${r.wins + r.losses ? `${r.wins}–${r.losses}` : 'New'}</span>
    ${current && action === 'open-rival' ? icon('check', 'friend-row__check') : chevron && !more ? '<svg class="icon cell__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.75 6.25 6.25-6.25 6.25"/></svg>' : ''}
  </button>${more ? `<button type="button" class="friend-more" data-action="friend-options" data-id="${esc(f.id)}" aria-label="More options for ${esc(f.display_name)}">${icon('more')}</button>` : ''}</li>`;
}

function renderFriends() {
  const el = $('#friends-list');
  if (!el || ui.searching) return;
  const invite = `<section class="group" aria-labelledby="invite-title">
    <div class="group__head"><h2 id="invite-title">Invite</h2></div>
    <ul class="list" role="list"><li><button type="button" class="cell cell--button" data-action="invite">${icon('export')}<span>Share Dubs</span></button></li></ul>
    <p class="group__foot">Send friends the link. Once they sign up, search for them here and tap Add.</p>
  </section>`;
  if (!state.friends.length) {
    el.innerHTML = `<div class="empty empty--compact">
      <span class="empty__icon">${icon('people')}</span>
      <p class="empty__text">Search by name or username to add your first friend.</p>
    </div>${invite}`;
    return;
  }
  const sorted = state.friends.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
  const meRow = state.me
    ? `<section class="group"><ul class="list list--friends" role="list"><li><button type="button" class="cell cell--button friend-row" data-action="open-profile" data-id="${esc(state.me.id)}" aria-label="My profile: your stats against everyone">
        ${avatar(state.me, 'md')}<span class="cell__stack"><span class="cell__title">My Profile</span><span class="cell__sub">Your stats against everyone</span></span>
        <svg class="icon cell__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.75 6.25 6.25-6.25 6.25"/></svg></button></li></ul></section>`
    : '';
  el.innerHTML = `${meRow}<section class="group" aria-labelledby="friends-title">
    <div class="group__head"><h2 id="friends-title">Your Friends</h2><span class="group__record">${sorted.length}</span></div>
    <ul class="list list--friends" role="list">${sorted.map((f) => friendRow(f, { more: true, action: 'open-profile' })).join('')}</ul>
    <p class="group__foot">Tap a friend to see their profile and stats. Tap ⋯ to remove or block.</p>
  </section>${invite}`;
}

function searchRow(u) {
  return `<li class="cell friend-result">
    ${avatar(u, 'md')}
    <span class="cell__stack"><span class="cell__title">${esc(u.display_name)}</span><span class="cell__sub">@${esc(u.username)}</span></span>
    ${
      u.isFriend
        ? `<button type="button" class="chip chip--done" data-action="open-rival" data-id="${esc(u.id)}" aria-label="Already friends with ${esc(u.display_name)}. Open rivalry">${icon('check')}Friends</button>`
        : `<button type="button" class="chip" data-action="add-friend" data-id="${esc(u.id)}" aria-label="Add ${esc(u.display_name)} as a friend">Add</button>`
    }
  </li>`;
}

function initFriends() {
  const input = $('#friend-search');
  const clear = $('#friend-search-clear');
  const results = $('#friend-results');
  let timer, seq = 0;

  const run = async () => {
    const q = input.value.trim();
    clear.hidden = !q;
    ui.searching = q.length > 0;
    $('#friends-list').hidden = ui.searching;
    if (!ui.searching) {
      results.innerHTML = '';
      renderFriends();
      return;
    }
    if (q.replace(/^@/, '').length < 2) {
      results.innerHTML = '<p class="search-note">Keep typing…</p>';
      return;
    }
    const mine = ++seq;
    results.innerHTML = '<p class="search-note"><span class="spinner spinner--sm" aria-hidden="true"></span> Searching…</p>';
    try {
      const users = await store.searchUsers(q);
      if (mine !== seq) return;
      results.innerHTML = users.length
        ? `<section class="group" aria-label="Search results"><div class="group__head"><h2>People</h2></div><ul class="list list--friends" role="list">${users.map(searchRow).join('')}</ul></section>`
        : `<p class="search-note">No one found for “${esc(q)}”.</p>`;
    } catch (err) {
      if (mine !== seq) return;
      results.innerHTML = `<p class="search-note">${err.code === 'network' ? 'You’re offline. Search needs a connection.' : esc(err.message)}</p>`;
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 280);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), clearTimeout(timer), run()));
  clear.addEventListener('click', () => {
    input.value = '';
    run();
    input.focus();
  });
  ui.resetSearch = () => {
    input.value = '';
    run();
  };
}

async function addFriend(userId, button) {
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner spinner--sm" aria-hidden="true"></span>';
  }
  try {
    const friend = await store.addFriend(userId);
    haptic('success');
    toast(`You and ${friend.display_name} are now friends`);
    ui.resetSearch?.();
    show('dashboard');
  } catch (err) {
    haptic('warning');
    toast(err.code === 'network' ? 'You’re offline. Adding friends needs a connection.' : err.message);
    if (button) {
      button.disabled = false;
      button.textContent = 'Add';
    }
  }
}

async function openFriendOptions(friendId) {
  const f = state.friends.find((x) => x.id === friendId);
  if (!f) return;
  haptic('light');
  const choice = await alertDialog({
    title: f.display_name,
    message: `@${f.username}`,
    actions: [
      { label: 'Remove Friend', value: 'remove', style: 'destructive' },
      { label: `Block @${f.username}`, value: 'block', style: 'destructive' },
      { label: 'Cancel', value: null, style: 'cancel' },
    ],
  });
  if (!choice) return;
  const block = choice === 'block';
  const sure = await alertDialog({
    title: block ? `Block ${f.display_name}?` : `Remove ${f.display_name}?`,
    message: block
      ? `You’ll stop being friends, and ${f.display_name} won’t be able to find or add you. You can unblock them in Settings.`
      : `You’ll stop being friends on both sides. Your games are kept and come back if you add each other again.`,
    actions: [
      { label: 'Cancel', value: false, style: 'cancel' },
      { label: block ? 'Block' : 'Remove', value: true, style: 'destructive' },
    ],
  });
  if (!sure) return;
  try {
    if (block) await store.blockUser(f.id);
    else await store.removeFriend(f.id);
    haptic('success');
    toast(block ? `Blocked ${f.display_name}` : `Removed ${f.display_name}`);
  } catch (err) {
    haptic('warning');
    toast(err.code === 'network' ? 'You’re offline. Try again when you’re connected.' : err.message);
  }
}

async function shareInvite() {
  const url = new URL('./', location.href).href;
  const me = state.me;
  const text = `Let’s track our NBA 2K games on Dubs.${me ? ` Add me: @${me.username}` : ''}`;
  haptic('light');
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Dubs', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
}

async function openBlockedSheet() {
  if (document.documentElement.classList.contains('has-modal')) return;
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <span></span>
      <h2 id="blocked-title" class="sheet__title">Blocked Users</h2>
      <button type="button" class="btn-text btn-text--strong" data-sheet="done">Done</button>
    </header>
    <div class="sheet__body"><p class="search-note"><span class="spinner spinner--sm" aria-hidden="true"></span> Loading…</p></div>`;
  const body = $('.sheet__body', content);
  const sheet = openSheet({ content, labelledBy: 'blocked-title' });
  const paint = (users) => {
    body.innerHTML = users.length
      ? `<ul class="list list--friends list--sheet" role="list">${users
          .map(
            (u) => `<li class="cell friend-result">${avatar(u, 'md')}<span class="cell__stack"><span class="cell__title">${esc(u.display_name)}</span><span class="cell__sub">@${esc(u.username)}</span></span>
              <button type="button" class="chip chip--done" data-unblock="${esc(u.id)}" aria-label="Unblock ${esc(u.display_name)}">Unblock</button></li>`,
          )
          .join('')}</ul><p class="group__foot">Unblocking doesn’t re-add them as a friend.</p>`
      : '<p class="search-note">You haven’t blocked anyone.</p>';
  };
  try {
    paint(await store.getBlocked());
  } catch (err) {
    body.innerHTML = `<p class="search-note">${err.code === 'network' ? 'You’re offline. This needs a connection.' : esc(err.message)}</p>`;
  }
  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-sheet="done"]')) return sheet.close();
    const btn = e.target.closest('[data-unblock]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await store.unblockUser(btn.dataset.unblock);
      haptic('light');
      paint(await store.getBlocked());
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });
}

function openRivalSwitcher() {
  if (document.documentElement.classList.contains('has-modal')) return;
  const content = document.createElement('div');
  content.className = 'sheet__content';
  const sorted = state.friends.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
  content.innerHTML = `
    <header class="sheet__header">
      <span></span>
      <h2 id="rival-title" class="sheet__title">Rivalries</h2>
      <button type="button" class="btn-text btn-text--strong" data-sheet="done">Done</button>
    </header>
    <div class="sheet__body">
      <ul class="list list--friends list--sheet" role="list">${sorted.map((f) => friendRow(f, { chevron: false })).join('')}</ul>
      <ul class="list list--sheet" role="list" style="margin-top:16px">
        <li><button type="button" class="cell cell--button" data-sheet="find">${icon('people')}<span>Find Friends</span></button></li>
      </ul>
    </div>`;
  const sheet = openSheet({ content, labelledBy: 'rival-title' });
  content.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-action="open-rival"]');
    if (pick) {
      e.stopPropagation();
      store.setRival(pick.dataset.id);
      haptic('light');
      sheet.close();
      return;
    }
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'done') sheet.close();
    if (act === 'find') {
      sheet.close();
      show('friends');
      setTimeout(() => $('#friend-search').focus(), 350);
    }
  });
}

// ---------- data flow ----------

function render(detail = {}) {
  if (!state.session) return;
  const pair = store.pairGames();
  ui.views = views(pair, meId());
  ui.stats = computeStats(pair, meId());
  renderSync();
  const sig = JSON.stringify([state.loaded || state.status, state.games, state.friends, state.me, state.rivalId, meId()]);
  if (sig !== ui.signature) {
    ui.signature = sig;
    renderDashboard();
    renderHistory();
    renderFriends();
    renderSidebarProfile();
  }
  // Don't rebuild Settings under the user's finger unless sync state changed
  if (!$('#settings-content').contains(document.activeElement) || detail.status || detail.synced) renderSettings();
  if (detail.added) {
    for (const row of $$(`.row-wrap[data-id="${detail.added}"]`)) {
      row.classList.add('is-entering');
      row.getBoundingClientRect();
      requestAnimationFrame(() => row.classList.remove('is-entering'));
    }
  }
  $$('.content').forEach((c) => c.classList.add('is-ready'));
}

let savedTimer;
function onStoreChange(detail) {
  if (detail.session) {
    ui.shown = {};
    ui.signature = '';
    if (!state.session) {
      closeModals();
      showProfilePage(null);
      ui.resetSearch?.();
      lockAndStart(detail.expired ? 'Your session ended. Sign in again.' : '');
    }
    return;
  }
  if (detail.rival) (ui.shown = {}), (ui.calMonth = null); // new rivalry: fresh count-up, current month
  if (detail.saved) {
    ui.justSaved = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ((ui.justSaved = false), renderSync()), 1600);
  }
  if (detail.rejected) toast(`Couldn’t save: ${detail.rejected}`);
  render(detail);
}

function closeModals() {
  $$('#layer > *').forEach((el) => el.remove());
  document.documentElement.classList.remove('has-modal');
  $('#app').inert = false;
}

async function lockAndStart(message = '') {
  await showLock({ message });
  afterUnlock();
}

function afterUnlock() {
  show(ui.screen);
  render();
  store.startAutoSync();
}

// Re-lock after 5+ minutes in the background when "Require PIN on open" is on
let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && state.session && store.getPrefs().requirePin && !isLocked() && Date.now() - hiddenAt > 5 * 60 * 1000) {
    closeModals();
    await showLock({ local: true });
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

async function init() {
  registerServiceWorker(); // before any await: the lock screen can wait indefinitely
  initNavBars();
  initSwipe();
  initSettings();
  initFriends();
  initProfilePage();
  route();
  store.subscribe(onStoreChange);
  window.addEventListener('hashchange', route);
  setInterval(() => ui.screen === 'settings' && state.session && !$('#settings-content').contains(document.activeElement) && renderSettings(), 30000); // keeps "Updated x min ago" fresh

  if (!state.session) {
    await lockAndStart();
  } else {
    render(); // instant from cache, before the network answers
    if (store.getPrefs().requirePin) await showLock({ local: true });
    afterUnlock();
  }

}

init();
