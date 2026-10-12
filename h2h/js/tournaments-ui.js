// Tournament screens.
//   Tournaments  → a page in the Friends tab (#friends/tournaments, the 🏆 button): Create, and your
//                  live, waiting and finished tournaments (ones you left or declined don't show)
//   Create       → three steps: name & game, friends, rules (format, presets, games per series,
//                  bracket draw, deadline, auto-start). The same rules screen edits one before it starts.
//   Tournament   → a page inside the Friends tab (#friends/t-<id>): the waiting room (with a seed
//                  preview), your games, group tables, the bracket round by round (or all of it), the
//                  games and the players; host tools; the champion moment, sharing and Run It Back
//   Notifications→ tournament updates (see updates)
// Invites only appear on the Notifications page (see app.js). The maths is in tournament.js; the game
// form's "Counts for …" line is in app.js.
import * as store from './store.js';
import { state } from './store.js';
import {
  buildBracket, currentMatch, groupTodo, knockedOutIn, eventsFor, highlights, roundName, groupName, accepted, hostOf,
  drawFor, checkLayout, groupCount, winnerOf,
  MAX_BEST_OF, MAX_GROUP_GAMES, MAX_DEADLINE_DAYS, PRESETS, MIN_PLAYERS, MAX_PLAYERS,
} from './tournament.js';
import { icon, logo, esc, haptic, openSheet, alertDialog, openPopup, toast, reducedMotion } from './ui.js';
import { avatar } from './lock.js';

const MODE = { '2k': 'NBA 2K', fifa: 'FIFA' };
const CANCEL = { label: 'Cancel', style: 'cancel', value: null };
let deps = {}; // { openPage(id), openList(), logGame(opponent, tournament), repaint() } from app.js

export function initTournaments(d) {
  deps = d;
}

// ---------- helpers ----------

const meId = () => state.session?.userId;
/** A player as the tournament shows them (they may not be your friend). */
export function person(t, id) {
  const p = t.people?.[id] || state.friends.find((f) => f.id === id) || (id === meId() ? state.me : null);
  return { id, display_name: p?.display_name || 'Player', username: p?.username || '', color: p?.color || '#8E8E93', initial: p?.initial || '?', avatar: p?.avatar || '' };
}
const nameOf = (t, id) => (id === meId() ? 'You' : person(t, id).display_name);
const bracketOf = (t) => buildBracket(t, store.gamesOf(t.id));
const firstTo = (n) => `first to ${Math.ceil(n / 2)}`;
/** One match of a round: "semifinal", "quarterfinal", "final", "round of 16". */
const oneRound = (r, total) => roundName(r, total).replace(/finals$/, 'final').toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const placedIn = (t) => (t.seeds || (t.groups || []).flatMap((g) => (Array.isArray(g) ? g : g.ids))).filter(Boolean);
const nextPow2 = (n) => {
  let size = 2;
  while (size < n) size *= 2;
  return size;
};
/** Knockout size for this many players and format (groups send their top two through). */
function knockoutSize(n, format) {
  if (format !== 'groups') return nextPow2(n);
  const g = groupCount(n);
  return nextPow2(g === 1 ? 2 : g * 2);
}

/** "You lead 1–0", "Tied 1–1", "Sam won 2–1", from your side when you're in it. */
function seriesLine(t, m) {
  const me = meId();
  if (m.winner !== undefined && !m.bye) {
    const [w, l] = m.winner === m.a ? [m.winsA, m.winsB] : [m.winsB, m.winsA];
    if (m.decidedBy === 'forfeit') return `${nameOf(t, m.winner)} went through: ${nameOf(t, m.winner === m.a ? m.b : m.a)} quit`;
    const how = m.decidedBy === 'host' ? ' (host’s call)' : m.decidedBy === 'deadline' ? ' (at the deadline)' : '';
    return `${nameOf(t, m.winner)} won ${w}–${l}${how}`;
  }
  const flip = m.b === me;
  const [x, y] = flip ? [m.winsB, m.winsA] : [m.winsA, m.winsB];
  const lead = flip ? m.b : m.a, trail = flip ? m.a : m.b;
  if (x === y) return `Tied ${x}–${y}`;
  return x > y ? `${nameOf(t, lead)} ${lead === me ? 'lead' : 'leads'} ${x}–${y}` : `${nameOf(t, trail)} ${trail === me ? 'lead' : 'leads'} ${y}–${x}`;
}

/** A series game by game, for `id`: [{ won, score }] (W L W …). */
function historyOf(m, id) {
  return m.games.map((g) => {
    const mine = g.player1_id === id ? [g.player1_score, g.player2_score] : [g.player2_score, g.player1_score];
    return { won: winnerOf(g) === id, score: `${mine[0]}–${mine[1]}` };
  });
}
/** The games of a series as little chips: W / L from your side, or each game's winner otherwise. */
function historyChips(t, m) {
  const me = meId();
  if (m.a === me || m.b === me) {
    return `<span class="series-history" aria-label="Your games: ${historyOf(m, me).map((x) => (x.won ? 'won' : 'lost')).join(', ')}">${historyOf(m, me)
      .map((x) => `<span class="series-history__g ${x.won ? 'is-w' : 'is-l'}" title="${esc(x.score)}">${x.won ? 'W' : 'L'}</span>`)
      .join('')}</span>`;
  }
  const winners = m.games.map((g) => winnerOf(g));
  return `<span class="series-history" aria-label="Games won by: ${winners.map((w) => esc(person(t, w).display_name)).join(', ')}">${winners
    .map((w) => `<span class="series-history__g" style="background:${esc(person(t, w).color)}">${esc(person(t, w).initial)}</span>`)
    .join('')}</span>`;
}

/** Your tournaments as the Friends tab lists them (no pending invites: those are in Notifications). */
function mine() {
  const me = meId();
  const list = state.tournaments.filter((t) => t.status !== 'cancelled' && t.answers?.[me] === 'accepted');
  const newest = (a, b) => String(b.started_at || b.created_at).localeCompare(String(a.started_at || a.created_at));
  const rows = list.map((t) => ({ t, b: t.status === 'live' ? bracketOf(t) : null }));
  return {
    live: rows.filter((x) => x.b && !x.b.champion).map((x) => x.t).sort(newest),
    waiting: rows.filter((x) => x.t.status === 'inviting').map((x) => x.t).sort(newest),
    finished: rows.filter((x) => x.b?.champion).map((x) => x.t).sort(newest),
  };
}

/** One line on where you stand in a live tournament. */
function standing(t, b) {
  const me = meId();
  const total = b.rounds.length;
  const todo = groupTodo(b, me);
  if (todo) return todo.todo.length ? `${todo.group.name} · ${plural(todo.todo.length, 'game')} to play` : `${todo.group.name} · waiting for the others`;
  const m = currentMatch(b, me);
  if (m) return `${roundName(m.round, total)} vs ${nameOf(t, m.a === me ? m.b : m.a)} · ${seriesLine(t, m)}`;
  if (knockedOutIn(b, me)) return 'You’re out · follow along';
  return 'Waiting for your next opponent';
}

/**
 * What you can count a game against this opponent for (the game form's "Counts for" line):
 * [{ t, stage ('group' | null), label }].
 */
export function openSeries(opponentId, sport) {
  const me = meId();
  return state.tournaments
    .filter((t) => t.status === 'live' && t.sport === sport)
    .map((t) => {
      const b = bracketOf(t);
      const todo = groupTodo(b, me);
      if (todo) {
        const pair = todo.todo.find((x) => x.opp === opponentId);
        return pair ? { t, stage: 'group', label: `${t.name} · ${todo.group.name} · game ${pair.played + 1} of ${pair.need}` } : null;
      }
      const m = currentMatch(b, me);
      if (!m || (m.a !== opponentId && m.b !== opponentId)) return null;
      return { t, stage: null, label: `${t.name} · ${roundName(m.round, b.rounds.length)} · Game ${m.winsA + m.winsB + 1}` };
    })
    .filter(Boolean);
}

// ---------- the Tournaments page (the 🏆 button on the Friends tab) ----------

/** Draws the list of your tournaments into `el`. */
export function renderList(el) {
  const me = meId();
  const g = mine();
  const row = (t, sub, live) => `<li><button type="button" class="cell cell--button tour-row" data-action="tournament" data-id="${esc(t.id)}">
      <span class="tour-row__icon" aria-hidden="true">🏆</span>
      <span class="cell__stack"><span class="cell__title">${esc(t.name)}</span><span class="cell__sub${live ? ' tour-row__live' : ''}">${esc(sub)}</span></span>
      ${icon('chevron', 'cell__chevron')}</button></li>`;
  const section = (title, rows) => (rows.length ? `<section class="group"><div class="group__head"><h2>${title}</h2><span class="group__record">${rows.length}</span></div><ul class="list" role="list">${rows.join('')}</ul></section>` : '');
  const live = g.live.map((t) => {
    const b = bracketOf(t);
    return row(t, `${MODE[t.sport]} · ${standing(t, b)}`, Boolean(currentMatch(b, me) || groupTodo(b, me)?.todo.length));
  });
  const waiting = g.waiting.map((t) => row(t, `${MODE[t.sport]} · waiting for players · ${accepted(t).length} of ${t.players.length} in`));
  const finished = g.finished.map((t) => {
    const champ = bracketOf(t).champion;
    return row(t, `${MODE[t.sport]} · ${champ === me ? 'you won 🏆' : `${nameOf(t, champ)} won`}`);
  });
  const any = live.length || waiting.length || finished.length;
  el.innerHTML = `<div class="tour-list">
    <h1 class="tour-list__title">Tournaments</h1>
    <p class="tour-list__sub">Knockout brackets and group stages with your friends.</p>
    <button type="button" class="btn btn--primary btn--block tour-create" data-action="new-tournament">${icon('log')}<span>Create a Tournament</span></button>
    ${section('Live', live)}${section('Waiting to Start', waiting)}${section('Finished', finished)}
    ${
      any
        ? ''
        : `<div class="card tour-empty tour-empty--page">
            <span class="tour-empty__icon" aria-hidden="true">🏆</span>
            <span class="tour-empty__title">No tournaments yet</span>
            <span class="tour-empty__steps"><span>1. Invite friends</span><span>2. Set the rules</span><span>3. Play it out</span></span>
          </div>`
    }
  </div>`;
}

// ---------- rules (create, edit, Run It Back) ----------

/** Options one under the other, with a bubble on the left; one can be picked. */
const choices = (attr, label, options, value) => `<div class="list choices" role="radiogroup" aria-label="${label}">
    ${options
      .map(
        ([v, title, sub]) => `<button type="button" class="choice" role="radio" aria-checked="${v === value}" ${attr}="${v}">
          <span class="choice__bubble" aria-hidden="true"></span>
          <span class="choice__text"><span class="choice__title">${title}</span>${sub ? `<span class="choice__sub">${sub}</span>` : ''}</span>
        </button>`,
      )
      .join('')}
  </div>`;

/** − n + */
const stepper = (key, value, { min, max, step = 1, label }) => `<span class="stepper" role="group" aria-label="${esc(label)}">
    <button type="button" class="stepper__btn" data-step="${key}" data-d="${-step}" aria-label="Less"${value <= min ? ' disabled' : ''}>−</button>
    <span class="stepper__value" aria-live="polite">${value}</span>
    <button type="button" class="stepper__btn" data-step="${key}" data-d="${step}" aria-label="More"${value >= max ? ' disabled' : ''}>+</button>
  </span>`;

/** The rules part of the form. `d` holds the draft; `n` is how many players there are (or will be). */
function rulesHtml(d, n) {
  const size = knockoutSize(n, d.format);
  const rounds = Math.log2(size);
  const series = (key, label) => `<li class="cell tour-bo-row">
      <span class="tour-bo-row__label">${label}<small>${d.bo[key] === 1 ? 'One game decides it' : `Best of ${d.bo[key]} · ${firstTo(d.bo[key])} wins`}</small></span>
      ${stepper(`bo-${key}`, d.bo[key], { min: 1, max: MAX_BEST_OF, step: 2, label: `${label}: games in the series` })}</li>`;
  const preset = PRESETS.find((p) => ['early', 'semi', 'final'].every((k) => p.best_of[k] === d.bo[k]));
  const groups = d.format === 'groups' ? groupCount(n) : 0;
  return `
    <section class="group">
      <div class="group__head"><h2>Format</h2></div>
      ${choices('data-format', 'Format', [
        ['knockout', 'Knockout', 'Lose a series and you’re out.'],
        ['groups', 'Groups, then Knockout', `Everyone plays everyone in their group${n >= MIN_PLAYERS ? ` (${plural(groups, 'group')})` : ''}; the top two go through.`],
      ], d.format)}
    </section>
    ${
      d.format === 'groups'
        ? `<section class="group"><ul class="list" role="list"><li class="cell tour-bo-row">
            <span class="tour-bo-row__label">Games vs Each Group Opponent<small>${d.groupGames === 1 ? 'Play each one once' : `Play each one ${d.groupGames} times`}</small></span>
            ${stepper('group', d.groupGames, { min: 1, max: MAX_GROUP_GAMES, label: 'Games against each group opponent' })}</li></ul>
            <p class="group__foot">A win is 3 points${d.sport === 'fifa' ? ', a draw 1' : ''}.</p></section>`
        : ''
    }
    <section class="group">
      <div class="group__head"><h2>${d.format === 'groups' ? 'Knockout Series' : 'Games per Series'}</h2></div>
      <div class="tour-presets" role="group" aria-label="Presets">${PRESETS.map(
        (p) => `<button type="button" class="tour-preset${preset?.id === p.id ? ' is-on' : ''}" data-preset="${p.id}"><b>${p.name}</b><small>${p.sub}</small></button>`,
      ).join('')}</div>
      <ul class="list" role="list">
        ${rounds > 2 ? series('early', rounds > 3 ? 'Early Rounds' : 'Quarterfinals') : ''}
        ${rounds > 1 ? series('semi', 'Semifinals') : ''}
        ${series('final', 'Final')}
      </ul>
      ${d.sport === 'fifa' ? '<p class="group__foot">In a knockout series, a drawn game only counts if it went to penalties.</p>' : ''}
    </section>
    <section class="group">
      <div class="group__head"><h2>${d.format === 'groups' ? 'Groups' : 'Bracket'}</h2></div>
      ${choices('data-draw', 'Draw', [
        ['random', 'Random Draw', d.format === 'groups' ? 'Groups are drawn at random when it starts.' : 'Everyone’s place is drawn at random when it starts.'],
        ['seeded', 'Seeded by Record', `Ranked by ${MODE[d.sport]} win rate, so the strongest are spread out and meet as late as possible.`],
        ['custom', 'Custom', d.format === 'groups' ? 'You put everyone in their group when you start it.' : 'You decide who plays who in the first round when you start it.'],
      ], d.draw)}
    </section>
    <section class="group">
      <ul class="list" role="list"><li class="cell tour-bo-row">
        <span class="tour-bo-row__label">Deadline<small>${d.deadline ? `${plural(d.deadline, 'day')} per ${d.format === 'groups' ? 'stage and ' : ''}round` : 'No deadline'}</small></span>
        ${stepper('deadline', d.deadline, { min: 0, max: MAX_DEADLINE_DAYS, label: 'Days per round' })}</li></ul>
      <p class="group__foot">${d.deadline ? 'When time’s up, whoever’s ahead in a series goes through. If it’s level, the host decides.' : 'Rounds take as long as they take.'}</p>
    </section>
    <section class="group">
      ${
        d.draw === 'custom'
          ? '<p class="group__foot">With Custom, you start it yourself: once everyone’s in, you place the players and press Start.</p>'
          : `<ul class="list" role="list"><li class="cell"><label for="tour-auto">Start When Everyone Answers</label><input type="checkbox" role="switch" class="switch" id="tour-auto"${d.auto ? ' checked' : ''}></li></ul>
      <p class="group__foot">${d.auto ? 'It starts by itself once everyone has answered, which could be before your friends invite theirs. Turn this off to start it yourself.' : 'You start it yourself, so friends have time to invite their friends too.'}</p>`
      }
    </section>`;
}

/** Applies a tap on the rules part to the draft. Returns true if it changed something. */
function rulesClick(e, d) {
  const step = e.target.closest('[data-step]');
  if (step) {
    haptic('light');
    const delta = Number(step.dataset.d);
    const key = step.dataset.step;
    if (key.startsWith('bo-')) {
      const k = key.slice(3);
      d.bo[k] = Math.min(MAX_BEST_OF, Math.max(1, d.bo[k] + delta));
    } else if (key === 'group') d.groupGames = Math.min(MAX_GROUP_GAMES, Math.max(1, d.groupGames + delta));
    else if (key === 'deadline') d.deadline = Math.min(MAX_DEADLINE_DAYS, Math.max(0, d.deadline + delta));
    return true;
  }
  const pre = e.target.closest('[data-preset]');
  if (pre) {
    haptic('light');
    d.bo = { ...PRESETS.find((p) => p.id === pre.dataset.preset).best_of };
    return true;
  }
  for (const attr of ['format', 'draw', 'sport']) {
    const b = e.target.closest(`[data-${attr}]`);
    if (b) {
      d[attr] = b.dataset[attr];
      return true;
    }
  }
  return false;
}
const settingsOf = (d) => ({ sport: d.sport, format: d.format, group_games: d.groupGames, best_of: d.bo, draw: d.draw, auto_start: d.draw !== 'custom' && d.auto, deadline_days: d.deadline });
const draftOf = (t, extra = {}) => ({
  name: t?.name || '',
  sport: t?.sport || '2k',
  format: t?.format || 'knockout',
  groupGames: t?.group_games || 1,
  bo: { ...(t?.best_of || { early: 1, semi: 1, final: 1 }) },
  draw: t?.draw || 'random',
  auto: t ? t.auto_start !== false || t.draw === 'custom' : true,
  deadline: t?.deadline_days || 0,
  ...extra,
});

// ---------- create: three steps (also Run It Back) ----------

/** `from`: a finished tournament to run back (same rules, same friends, a new name). */
export function openCreateTournament({ from = null } = {}) {
  const friends = state.friends.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
  if (friends.length < MIN_PLAYERS - 1) return toast(`Add at least ${MIN_PLAYERS - 1} friends first, then start a tournament with them.`);
  const previous = from ? placedIn(from).filter((id) => id !== meId()) : [];
  const d = draftOf(from, { name: from ? nextName(from.name) : '', step: from ? 2 : 1, picked: new Set(previous.filter((id) => friends.some((f) => f.id === id))), query: '' });
  const missing = previous.filter((id) => !friends.some((f) => f.id === id));
  const content = document.createElement('div');
  content.className = 'sheet__content';

  function friendRows() {
    const q = d.query.trim().toLowerCase().replace(/^@/, '');
    const list = friends.filter((f) => !q || f.username.includes(q) || f.display_name.toLowerCase().includes(q));
    return list.length
      ? list
          .map(
            (f) => `<li><button type="button" class="cell cell--button friend-row" data-pick="${esc(f.id)}" aria-pressed="${d.picked.has(f.id)}">
              ${avatar(f, 'sm')}<span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span>
              <span class="tour-check${d.picked.has(f.id) ? ' is-on' : ''}" aria-hidden="true">${d.picked.has(f.id) ? icon('check') : ''}</span></button></li>`,
          )
          .join('')
      : '<li class="cell admin-empty">No friends match.</li>';
  }
  const steps = {
    1: () => `
      <p class="tour-step__intro">Give it a name and pick the game.</p>
      <ul class="list list--form" role="list">
        <li class="cell"><input id="tour-name" class="cell__input cell__input--full" maxlength="40" placeholder="Name (e.g. Summer Cup)" aria-label="Tournament name" value="${esc(d.name)}" enterkeyhint="next"></li>
      </ul>
      <section class="group tour-step__field"><div class="group__head"><h2>Game</h2></div>${choices('data-sport', 'Game', [['2k', 'NBA 2K'], ['fifa', 'FIFA']], d.sport)}</section>`,
    2: () => `
      <p class="tour-step__intro">${from ? `Same players as ${esc(from.name)}, ready to go. ` : ''}Pick who to invite. They get an invite on their Notifications page.</p>
      ${missing.length ? `<p class="tour-note">${esc(missing.map((id) => person(from, id).display_name).join(', '))} ${missing.length === 1 ? 'isn’t' : 'aren’t'} your friend${missing.length === 1 ? '' : 's'}: once your friends join, they can invite them.</p>` : ''}
      <div class="search">${icon('search')}<input type="search" id="tour-search" value="${esc(d.query)}" placeholder="Search friends" aria-label="Search friends" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
      <div class="tour-picked"><span><strong>${d.picked.size + 1}</strong> players (you + ${d.picked.size})</span><button type="button" class="btn-text" data-t="all">${d.picked.size === friends.length ? 'Clear' : 'Select All'}</button></div>
      <ul class="list" role="list" data-friends>${friendRows()}</ul>`,
    3: () => {
      const n = d.picked.size + 1;
      const size = knockoutSize(n, d.format);
      const free = d.format === 'groups' ? 0 : size - n;
      return `${rulesHtml(d, n)}
        <div class="card tour-summary">
          <span class="tour-summary__title">${esc(d.name)} · ${MODE[d.sport]}</span>
          <span>${n} players · ${d.format === 'groups' ? `${plural(groupCount(n), 'group')}, then ` : ''}${plural(Math.log2(size), 'knockout round')}${free ? ` · ${free} free ${free === 1 ? 'pass' : 'passes'}` : ''}</span>
        </div>`;
    },
  };
  const canNext = () => (d.step === 1 ? d.name.trim().length > 0 : d.step === 2 ? d.picked.size + 1 >= MIN_PLAYERS && d.picked.size + 1 <= MAX_PLAYERS : true);
  const titles = { 1: from ? 'Run It Back' : 'New Tournament', 2: 'Invite Friends', 3: 'Rules' };
  const paint = () => {
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-t="${d.step === 1 ? 'cancel' : 'back'}">${d.step === 1 ? 'Cancel' : 'Back'}</button>
        <div class="sheet__title-group"><h2 id="new-title" class="sheet__title">${titles[d.step]}</h2><p class="sheet__subtitle">Step ${d.step} of 3</p></div>
        <span></span>
      </header>
      <div class="tour-steps" aria-hidden="true">${[1, 2, 3].map((n) => `<span class="${n <= d.step ? 'is-on' : ''}"></span>`).join('')}</div>
      <div class="sheet__body tour-step">${steps[d.step]()}
        <button type="button" class="btn btn--primary btn--block tour-step__next" data-t="next"${canNext() ? '' : ' disabled'}>${d.step === 3 ? 'Create &amp; Send Invites' : 'Next'}</button>
        ${d.step === 2 && d.picked.size + 1 < MIN_PLAYERS ? `<p class="group__foot group__foot--center">Pick at least ${MIN_PLAYERS - 1} friends.</p>` : ''}
      </div>`;
  };
  const refresh = () => {
    const keep = content.querySelector('.sheet__body')?.scrollTop || 0;
    paint();
    content.querySelector('.sheet__body').scrollTop = keep;
  };
  paint();
  const sheet = openSheet({ content, labelledBy: 'new-title', large: true, initialFocus: '#tour-name' });

  content.addEventListener('input', (e) => {
    if (e.target.id === 'tour-name') {
      d.name = e.target.value;
      content.querySelector('[data-t="next"]').disabled = !canNext();
    }
    if (e.target.id === 'tour-search') {
      d.query = e.target.value;
      content.querySelector('[data-friends]').innerHTML = friendRows(); // keep the keyboard up
    }
  });
  content.addEventListener('change', (e) => {
    if (e.target.id === 'tour-auto') {
      d.auto = e.target.checked;
      refresh();
    }
  });
  content.addEventListener('keydown', (e) => {
    if (e.target.id === 'tour-name' && e.key === 'Enter' && canNext()) {
      e.preventDefault();
      d.step = 2;
      paint();
    }
  });
  content.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      haptic('light');
      const id = pick.dataset.pick;
      if (d.picked.has(id)) d.picked.delete(id);
      else if (d.picked.size + 1 < MAX_PLAYERS) d.picked.add(id);
      else return toast(`A tournament can have up to ${MAX_PLAYERS} players.`);
      return refresh();
    }
    if (rulesClick(e, d)) return refresh();
    const t = e.target.closest('[data-t]')?.dataset.t;
    if (t === 'cancel') return sheet.close();
    if (t === 'back') return (d.step -= 1), paint();
    if (t === 'all') {
      if (d.picked.size === friends.length) d.picked.clear();
      else friends.slice(0, MAX_PLAYERS - 1).forEach((f) => d.picked.add(f.id));
      return refresh();
    }
    if (t !== 'next' || !canNext()) return;
    if (d.step < 3) {
      d.step += 1;
      return paint();
    }
    const btn = e.target.closest('[data-t]');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const created = await store.createTournament({ name: d.name.trim(), players: [...d.picked], ...settingsOf(d) });
      haptic('success');
      await sheet.close();
      toast(`Invites sent for ${created.name}`);
      deps.openPage?.(created.id);
    } catch (err) {
      haptic('warning');
      toast(err.message || 'Couldn’t create it. Try again.');
      btn.disabled = false;
      btn.textContent = 'Create & Send Invites';
    }
  });
}

/** "Summer Cup" → "Summer Cup #2", "Summer Cup #2" → "Summer Cup #3". */
function nextName(name) {
  const m = String(name).match(/^(.*?)(?:\s*#(\d+))?$/);
  return `${m[1]} #${Number(m[2] || 1) + 1}`.slice(0, 40);
}

/** The host renames it or changes the rules before it starts. */
function openEditTournament(t) {
  const d = draftOf(t);
  const n = t.players.length;
  const content = document.createElement('div');
  content.className = 'sheet__content';
  const paint = () => {
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-e="cancel">Cancel</button>
        <h2 id="edit-title" class="sheet__title">Edit Tournament</h2>
        <button type="button" class="btn-text btn-text--strong" data-e="save"${d.name.trim() ? '' : ' disabled'}>Save</button>
      </header>
      <div class="sheet__body tour-step">
        <ul class="list list--form" role="list">
          <li class="cell"><input id="tour-name" class="cell__input cell__input--full" maxlength="40" placeholder="Name" aria-label="Tournament name" value="${esc(d.name)}"></li>
        </ul>
        <section class="group tour-step__field"><div class="group__head"><h2>Game</h2></div>${choices('data-sport', 'Game', [['2k', 'NBA 2K'], ['fifa', 'FIFA']], d.sport)}</section>
        ${rulesHtml(d, n)}
        <button type="button" class="btn btn--primary btn--block tour-step__next" data-e="save"${d.name.trim() ? '' : ' disabled'}>Save Changes</button>
      </div>`;
  };
  const refresh = () => {
    const keep = content.querySelector('.sheet__body')?.scrollTop || 0;
    paint();
    content.querySelector('.sheet__body').scrollTop = keep;
  };
  paint();
  const sheet = openSheet({ content, labelledBy: 'edit-title', large: true });
  content.addEventListener('input', (e) => {
    if (e.target.id === 'tour-name') {
      d.name = e.target.value;
      content.querySelectorAll('[data-e="save"]').forEach((b) => (b.disabled = !d.name.trim()));
    }
  });
  content.addEventListener('change', (e) => e.target.id === 'tour-auto' && ((d.auto = e.target.checked), refresh()));
  content.addEventListener('click', async (e) => {
    if (rulesClick(e, d)) return refresh();
    const act = e.target.closest('[data-e]')?.dataset.e;
    if (act === 'cancel') return sheet.close();
    if (act !== 'save' || !d.name.trim()) return;
    try {
      await store.updateTournament(t.id, { name: d.name.trim(), ...settingsOf(d) });
      haptic('success');
      sheet.close();
      toast('Saved');
    } catch (err) {
      haptic('warning');
      toast(err.message || 'Couldn’t save. Try again.');
    }
  });
}

// ---------- the tournament page ----------

// `round`: the round tab you picked; until you pick one it follows your current round
const view = { id: null, tab: null, round: null, full: false };
const records = new Map(); // seed preview, per tournament + game + players

/** Draws the page for tournament `id` into `el` (the Friends tab's tournament page). Returns it. */
export function renderPage(el, id) {
  if (view.id !== id) Object.assign(view, { id, tab: null, round: null, full: false });
  const t = state.tournaments.find((x) => x.id === id);
  if (!t) {
    el.innerHTML = '<p class="notif-empty">This tournament isn’t available.</p>';
    return null;
  }
  if (t.status === 'cancelled') {
    el.innerHTML = `${head(t, 'Cancelled', '')}<p class="notif-empty">${esc(nameOf(t, t.creator))} cancelled this tournament.</p>`;
    return t;
  }
  el.innerHTML = t.status === 'inviting' ? waitingRoom(t) : livePage(t);
  if (t.status === 'live') celebrate(t);
  return t;
}

function rulesText(t) {
  const b = t.best_of || {};
  const series = b.early === b.semi && b.semi === b.final ? (b.final === 1 ? 'one game per series' : `best of ${b.final}`) : `best of ${b.early}, semis ${b.semi}, final ${b.final}`;
  return [
    MODE[t.sport],
    t.format === 'groups' ? `groups (${(t.group_games || 1) === 1 ? 'play each once' : `play each ${t.group_games} times`}), then knockout` : 'knockout',
    series,
    { seeded: 'seeded by record', custom: 'custom draw' }[t.draw] || 'random draw',
    t.deadline_days ? `${plural(t.deadline_days, 'day')} per round` : 'no deadline',
  ].join(' · ');
}

function waitingRoom(t) {
  const me = meId();
  const n = accepted(t).length;
  const answer = (pid) => t.answers?.[pid] || 'pending';
  const label = { accepted: 'Joined', pending: 'Invited', declined: 'Declined' };
  const host = t.creator === me;
  let preview = '';
  if (t.draw === 'seeded' && n >= 2) {
    const key = `${t.id}:${t.sport}:${accepted(t).join(',')}`;
    const recs = records.get(key);
    if (recs === undefined) {
      records.set(key, null);
      store.playerRecords(accepted(t), t.sport).then((r) => {
        records.set(key, r);
        deps.repaint?.();
      });
    } else if (recs) {
      const ranked = accepted(t).slice().sort((a, b) => (recs[b]?.rate || 0) - (recs[a]?.rate || 0));
      preview = `<section class="group tour-section">
        <div class="group__head"><h2>Seeds If It Started Now</h2></div>
        <ol class="list tour-seeds" role="list">${ranked
          .map((pid, i) => `<li class="cell admin-friend"><span class="tour-seed">${i + 1}</span>${avatar(person(t, pid), 'sm')}<span class="cell__stack"><span class="cell__title">${esc(nameOf(t, pid))}</span><span class="cell__sub">${recs[pid]?.played ? `${recs[pid].pct}% won · ${plural(recs[pid].played, 'game')}` : 'No games yet'}</span></span></li>`)
          .join('')}</ol>
        <p class="group__foot">By ${MODE[t.sport]} win rate (players with few games count as average).</p>
      </section>`;
    }
  }
  return `${head(t, 'Waiting for players', 'is-waiting')}
    <div class="tour-progress" role="img" aria-label="${n} of ${t.players.length} joined"><span style="width:${(100 * n) / t.players.length}%"></span></div>
    <p class="tour-lead">${n} of ${t.players.length} joined. ${t.auto_start ? 'It starts by itself once everyone has answered.' : host ? (t.draw === 'custom' ? 'When you’re ready, set it up and start it.' : 'Start it when you’re ready.') : `${esc(nameOf(t, t.creator))} starts it when everyone’s in.`}</p>
    ${host && n >= MIN_PLAYERS ? `<button type="button" class="btn btn--primary btn--block" data-tp="start">${t.draw === 'custom' ? `Set Up &amp; Start (${n} Players)` : `Start Now with ${n} Players`}</button>` : ''}
    ${!host && answer(me) === 'pending' ? '<div class="notif-card__actions tour-answer"><button type="button" class="btn btn--tinted" data-tp="no">Decline</button><button type="button" class="btn btn--primary" data-tp="yes">Join</button></div>' : ''}
    ${answer(me) === 'accepted' && t.players.length < MAX_PLAYERS ? `<button type="button" class="btn btn--tinted btn--block" data-tp="invite">${icon('people')}<span>Invite Friends</span></button>` : ''}
    <section class="group tour-section">
      <div class="group__head"><h2>Players</h2></div>
      <ul class="list" role="list">${t.players
        .map(
          (pid) => `<li class="cell admin-friend">${avatar(person(t, pid), 'sm')}<span class="cell__stack"><span class="cell__title">${esc(nameOf(t, pid))}</span>${pid === t.creator ? '<span class="cell__sub">Host</span>' : t.invited_by?.[pid] && t.invited_by[pid] !== t.creator ? `<span class="cell__sub">Invited by ${esc(nameOf(t, t.invited_by[pid]))}</span>` : ''}</span>
          <span class="admin-tag${answer(pid) === 'accepted' ? ' tour-tag--in' : answer(pid) === 'declined' ? ' admin-tag--warn' : ''}">${label[answer(pid)]}</span></li>`,
        )
        .join('')}</ul>
    </section>
    ${preview}
    <section class="group">
      <div class="group__head"><h2>Rules</h2>${host ? '<button type="button" class="btn-text admin-head-action" data-tp="edit">Edit</button>' : ''}</div>
      <div class="card tour-rules">${esc(rulesText(t))}${t.auto_start ? ' · starts when everyone answers' : ''}</div>
    </section>
    ${host ? '<button type="button" class="btn btn--plain-destructive btn--block" data-tp="cancel">Cancel Tournament</button>' : answer(me) === 'accepted' ? '<button type="button" class="btn btn--plain-destructive btn--block" data-tp="leave">Leave Tournament</button>' : ''}`;
}

function livePage(t) {
  const me = meId();
  const host = hostOf(t) === me;
  const inIt = t.answers?.[me] === 'accepted';
  const b = bracketOf(t);
  const total = b.rounds.length;
  const done = Boolean(b.champion);
  const roundNow = b.rounds.findIndex((r) => r.some((x) => x.winner === undefined));
  const status = done ? 'Finished' : b.stage === 'groups' ? 'Group stage' : `Round ${roundNow + 1} of ${total} · ${roundName(roundNow, total)}`;
  const tabs = [...(b.groups ? [['groups', 'Groups']] : []), ['bracket', 'Bracket'], ['games', 'Games'], ['players', 'Players']];
  if (!view.tab || !tabs.some(([k]) => k === view.tab)) view.tab = b.stage === 'groups' ? 'groups' : 'bracket';
  const body = { groups: groupsTab, bracket: bracketTab, games: gamesTab, players: playersTab }[view.tab](t, b);

  return `${head(t, status, done ? 'is-done' : 'is-live')}
    ${done ? championBanner(t, b) : yourCard(t, b)}
    <div class="seg seg--large tour-tabs" role="tablist" style="--count:${tabs.length};--index:${tabs.findIndex(([k]) => k === view.tab)}"><span class="seg__thumb" aria-hidden="true"></span>
      ${tabs.map(([k, label]) => `<button type="button" class="seg__item" role="tab" aria-selected="${k === view.tab}" data-tab="${k}">${label}</button>`).join('')}</div>
    <div class="tour-body">${body}</div>
    ${store.demoSimulate && !done ? '<button type="button" class="btn btn--tinted btn--block tour-demo" data-tp="simulate">Simulate Other Games (Demo)</button>' : ''}
    ${done ? `<button type="button" class="btn btn--tinted btn--block tour-demo" data-tp="runback">${icon('refresh')}<span>Run It Back</span></button>` : ''}
    ${host && !done ? `<p class="group__foot group__foot--center tour-hostnote">${t.creator === me ? 'You’re the host' : 'You’re the host now (the host quit)'}: tap a series to decide it, or replace a player from the Players tab.</p><button type="button" class="btn btn--plain-destructive btn--block" data-tp="cancel">Cancel Tournament</button>` : ''}
    ${inIt && !done ? '<button type="button" class="btn btn--plain-destructive btn--block" data-tp="quit">Quit Tournament</button>' : ''}`;
}

function head(t, status, cls) {
  return `<header class="tour-head">
    <span class="tour-head__icon" aria-hidden="true">🏆</span>
    <h1 class="tour-head__name">${esc(t.name)}</h1>
    <div class="tour-chips"><span class="tour-chip">${MODE[t.sport]}</span><span class="tour-chip">${plural(t.status === 'inviting' ? t.players.length : placedIn(t).length, 'player')}</span><span class="tour-chip tour-chip--status ${cls}">${esc(status)}</span></div>
  </header>`;
}

/** Your games still to play (group stage), your series (knockout), or where you went out. */
function yourCard(t, b) {
  const me = meId();
  const total = b.rounds.length;
  const todo = groupTodo(b, me);
  if (todo) {
    return `<section class="card tour-mine">
      <p class="tour-mine__label">Your ${esc(todo.group.name)} games${b.groupsDeadline ? ` · until ${esc(when(b.groupsDeadline))}` : ''}</p>
      ${
        todo.todo.length
          ? `<ul class="tour-todo" role="list">${todo.todo
              .map((x) => `<li>${avatar(person(t, x.opp), 'sm')}<span class="tour-todo__name">${esc(nameOf(t, x.opp))}${x.need > 1 ? `<small>${x.played} of ${x.need} played</small>` : ''}</span><button type="button" class="btn btn--primary tour-todo__log" data-tp="log" data-opp="${esc(x.opp)}">Log Game</button></li>`)
              .join('')}</ul>`
          : '<p class="tour-mine__sub">You’ve played all your group games. Waiting for the rest of the group.</p>'
      }
    </section>`;
  }
  const m = currentMatch(b, me);
  if (!m) {
    const out = knockedOutIn(b, me);
    if (out?.stage === 'group') return `<p class="tour-lead">You didn’t make it out of ${esc(out.group.name)}. Follow the knockout below.</p>`;
    if (out) return `<p class="tour-lead">You went out in the ${esc(oneRound(out.round, total))} to ${esc(nameOf(t, out.winner))}.</p>`;
    return b.stage === 'groups' ? '' : '<p class="tour-lead">You’re through. Waiting for your next opponent.</p>';
  }
  const opp = m.a === me ? m.b : m.a;
  const [mw, ow] = m.a === me ? [m.winsA, m.winsB] : [m.winsB, m.winsA];
  const dots = (wins) => Array.from({ length: m.need }, (_, i) => `<i class="${i < wins ? 'is-on' : ''}"></i>`).join('');
  return `<section class="card tour-mine">
    <p class="tour-mine__label">Your ${esc(oneRound(m.round, total))} · ${m.bestOf === 1 ? 'one game' : `best of ${m.bestOf}`}</p>
    <div class="tour-mine__vs">
      <span class="tour-mine__side">${avatar(person(t, me), 'md')}<span>You</span><span class="tour-dots">${dots(mw)}</span></span>
      <span class="tour-mine__score">${mw}<small>–</small>${ow}</span>
      <span class="tour-mine__side">${avatar(person(t, opp), 'md')}<span>${esc(person(t, opp).display_name)}</span><span class="tour-dots">${dots(ow)}</span></span>
    </div>
    ${m.games.length ? `<div class="tour-mine__history">${historyChips(t, m)}</div>` : ''}
    <p class="tour-mine__sub">${esc(seriesLine(t, m))} · ${firstTo(m.bestOf)}${m.deadline ? ` · ends ${esc(when(m.deadline))}` : ''}</p>
    ${m.overdue ? '<p class="tour-warn">Past the deadline and level: the host decides who goes through.</p>' : ''}
    <button type="button" class="btn btn--primary btn--block" data-tp="log" data-opp="${esc(opp)}">${icon('log')}<span>Log Game vs ${esc(person(t, opp).display_name)}</span></button>
    <button type="button" class="btn-text tour-nudge" data-tp="nudge" data-opp="${esc(opp)}">👋 Ready to play? Nudge ${esc(person(t, opp).display_name)}</button>
  </section>`;
}

function championBanner(t, b) {
  const me = meId();
  const final = b.rounds.at(-1)[0];
  const [w, l] = final.winner === final.a ? [final.winsA, final.winsB] : [final.winsB, final.winsA];
  return `<div class="tour-champion">${avatar(person(t, b.champion), 'lg')}<span class="tour-champion__label">🏆 Champion</span>
    <span class="tour-champion__name">${esc(b.champion === me ? 'You!' : person(t, b.champion).display_name)}</span>
    ${b.runnerUp ? `<span class="tour-champion__sub">Beat ${esc(nameOf(t, b.runnerUp))} ${w}–${l} in the final</span>` : ''}
    <button type="button" class="btn btn--primary tour-share" data-tp="share">${icon('export')}<span>Share Result</span></button>
  </div>`;
}

function groupsTab(t, b) {
  const me = meId();
  const fifa = t.sport === 'fifa';
  const done = b.stage !== 'groups';
  const score = (gm, a) => (gm.player1_id === a ? `${gm.player1_score}–${gm.player2_score}` : `${gm.player2_score}–${gm.player1_score}`);
  return `${b.groupsDeadline && !done ? `<p class="tour-round-note">Group stage ends ${esc(when(b.groupsDeadline))}</p>` : ''}
    ${b.groups
      .map(
        (g) => `<section class="card tour-group">
          <h3 class="tour-group__name">${esc(g.name)}${g.done ? '<small>Done</small>' : ''}</h3>
          <table class="tour-table">
            <thead><tr><th scope="col" class="tour-table__who">Player</th><th scope="col">P</th><th scope="col">W</th>${fifa ? '<th scope="col">D</th>' : ''}<th scope="col">L</th><th scope="col">Pts</th></tr></thead>
            <tbody>${g.table
              .map(
                (r, i) => `<tr class="${i < 2 && (done || g.done) ? 'is-through' : ''}${r.id === me ? ' is-me' : ''}">
                  <td class="tour-table__who"><span class="tour-table__pos">${i + 1}</span>${avatar(person(t, r.id), 'xs')}<span class="tour-table__name">${esc(nameOf(t, r.id))}</span></td>
                  <td>${r.played}</td><td>${r.w}</td>${fifa ? `<td>${r.d}</td>` : ''}<td>${r.l}</td><td><b>${r.pts}</b></td></tr>`,
              )
              .join('')}</tbody>
          </table>
          <ul class="tour-pairs" role="list">${g.pairs
            .map(
              (p) => `<li class="${p.a === me || p.b === me ? 'is-mine' : ''}"><span>${esc(nameOf(t, p.a))} vs ${esc(nameOf(t, p.b))}</span><span class="tour-pairs__state">${
                p.games.length ? p.games.map((gm) => score(gm, p.a)).join(', ') + (p.done ? '' : ` · ${p.need - p.games.length} to play`) : 'To play'
              }</span></li>`,
            )
            .join('')}</ul>
        </section>`,
      )
      .join('')}
    <p class="group__foot">The top two of each group go through${done ? '' : ' (shaded once a group is done)'}. Ties are split by wins, then score difference.</p>`;
}

function bracketTab(t, b) {
  const total = b.rounds.length;
  const me = meId();
  if (!total) return '<p class="notif-empty">The bracket appears here.</p>';
  const m = currentMatch(b, me);
  const roundNow = b.rounds.findIndex((r) => r.some((x) => x.winner === undefined));
  const shown = view.round !== null && view.round < total ? view.round : m ? m.round : b.champion ? total - 1 : Math.max(0, roundNow);
  let html;
  if (view.full) {
    html = `<div class="bracket bracket--lines" role="region" aria-label="Full bracket" tabindex="0">${b.rounds
      .map(
        (round, r) => `<section class="bracket__round"><h3 class="bracket__title">${roundName(r, total)}<small>${round[0].bestOf === 1 ? '1 game' : `Bo${round[0].bestOf}`}</small></h3>
          <div class="bracket__matches">${chunkPairs(round)
            .map((pair) => `<div class="bracket__pair${pair.length === 1 ? ' is-single' : ''}">${pair.map((x) => `<div class="bracket__slot">${matchCard(t, b, x, true)}</div>`).join('')}</div>`)
            .join('')}</div></section>`,
      )
      .join('')}</div>`;
  } else {
    const round = b.rounds[shown];
    html = `${total > 1 ? `<div class="seg tour-rounds" role="tablist" style="--count:${total};--index:${shown}"><span class="seg__thumb" aria-hidden="true"></span>${b.rounds
      .map((x, r) => `<button type="button" class="seg__item" role="tab" aria-selected="${r === shown}" data-round="${r}">${roundName(r, total).replace('Round of ', 'R')}</button>`)
      .join('')}</div>` : ''}
      <p class="tour-round-note">${roundName(shown, total)} · ${round[0].bestOf === 1 ? 'one game decides it' : `best of ${round[0].bestOf} (${firstTo(round[0].bestOf)})`}${round[0].deadline ? ` · ends ${esc(when(round[0].deadline))}` : ''}</p>
      <div class="tour-matches">${round.map((x) => matchCard(t, b, x, false)).join('')}</div>`;
  }
  return `${html}<button type="button" class="btn-text tour-toggle" data-tp="full">${view.full ? 'Show One Round at a Time' : 'Show Full Bracket'}</button>`;
}
const chunkPairs = (list) => Array.from({ length: Math.ceil(list.length / 2) }, (_, i) => list.slice(2 * i, 2 * i + 2));

/** One match: both players with their series wins, the games so far, and where it stands. */
function matchCard(t, b, m, compact) {
  const me = meId();
  const total = b.rounds.length;
  const labelFor = (pos) => {
    if (m.round === 0 && b.labels?.length) return b.labels[pos] || '—';
    return m.round === 0 ? '—' : `Winner of the ${roundName(m.round - 1, total).replace(/s$/, '').toLowerCase()}`;
  };
  const row = (pid, wins, pos) => {
    if (pid === null) return `<span class="mcard__row is-empty">${compact ? 'Free pass' : 'Advances automatically'}</span>`;
    if (pid === undefined) return `<span class="mcard__row is-empty">${esc(labelFor(pos))}</span>`;
    const won = m.winner === pid && !m.bye;
    const lost = m.winner !== undefined && m.winner !== pid;
    return `<span class="mcard__row${won ? ' is-winner' : ''}${lost ? ' is-loser' : ''}${pid === me ? ' is-me' : ''}">${avatar(person(t, pid), compact ? 'xs' : 'sm')}<span class="mcard__name">${esc(nameOf(t, pid))}</span>${m.bye ? '' : `<b class="mcard__wins">${wins}</b>`}${won ? `<span class="mcard__check">${icon('check')}</span>` : ''}</span>`;
  };
  const ready = m.a && m.b;
  const foot = m.bye ? 'Straight through to the next round' : !ready ? 'Waiting for the earlier round' : m.overdue ? 'Past the deadline · the host decides' : seriesLine(t, m);
  return `<button type="button" class="mcard${m.a === me || m.b === me ? ' is-mine' : ''}${compact ? ' mcard--compact' : ''}${m.overdue ? ' is-overdue' : ''}" data-match="${m.key}"${!ready ? ' disabled' : ''}>
    ${row(m.a, m.winsA, 2 * m.index)}${row(m.b, m.winsB, 2 * m.index + 1)}
    ${compact ? '' : `<span class="mcard__foot"><span>${esc(foot)}</span>${m.games.length && m.a ? historyChips(t, m) : ''}</span>`}
  </button>`;
}

function gamesTab(t, b) {
  const games = store.gamesOf(t.id).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  const where = new Map();
  for (const g of b.groups || []) for (const p of g.pairs) for (const gm of p.games) where.set(gm.id, g.name);
  for (const round of b.rounds) for (const m of round) for (const gm of m.games) where.set(gm.id, roundName(m.round, b.rounds.length));
  const h = highlights(t, b);
  const hl = (label, g) => (g ? `<div class="tour-hl"><span class="tour-hl__label">${label}</span><span>${esc(nameOf(t, g.player1_id))} ${g.player1_score}–${g.player2_score} ${esc(nameOf(t, g.player2_id))}</span></div>` : '');
  return `${h.games ? `<div class="card tour-hls">${hl('Biggest win', h.biggest)}${h.closest && h.closest !== h.biggest ? hl('Closest game', h.closest) : ''}<div class="tour-hl"><span class="tour-hl__label">Games played</span><span>${h.games}</span></div></div>` : ''}
    ${
      games.length
        ? `<ul class="list" role="list">${games
            .map((g) => {
              const r = where.get(g.id);
              return `<li class="cell tour-game">
                <span class="tour-game__when">${esc(shortDate(g.date))}<small>${r ? esc(r) : 'Didn’t count'}</small></span>
                <span class="tour-game__line">${logo(g.player1_team, { size: 'sm', alt: '' })}<span>${esc(nameOf(t, g.player1_id))}</span></span>
                <span class="tour-game__score">${g.player1_score}–${g.player2_score}${g.player1_pens !== '' && g.player1_pens != null ? `<small>pens ${g.player1_pens}–${g.player2_pens}</small>` : ''}</span>
                <span class="tour-game__line tour-game__line--end"><span>${esc(nameOf(t, g.player2_id))}</span>${logo(g.player2_team, { size: 'sm', alt: '' })}</span>
              </li>`;
            })
            .join('')}</ul>`
        : '<p class="notif-empty">No games yet. Games logged with “Counts for” switched on show up here.</p>'
    }`;
}

function playersTab(t, b) {
  const me = meId();
  const host = hostOf(t) === me && !b.champion;
  const total = b.rounds.length;
  const fate = (pid) => {
    if (t.left?.[pid]) return ['Quit', 'admin-tag--warn'];
    if (b.champion === pid) return ['🏆 Champion', 'tour-tag--gold'];
    if (b.runnerUp === pid) return ['🥈 Runner-up', ''];
    if (b.semifinalists?.includes(pid)) return ['🥉 Semifinals', ''];
    const out = knockedOutIn(b, pid);
    if (out?.stage === 'group') return [`Out in ${out.group.name}`, ''];
    if (out) return [`Out in the ${oneRound(out.round, total)}`, ''];
    return ['Still in', 'tour-tag--in'];
  };
  const players = placedIn(t);
  const order = b.champion ? [b.champion, b.runnerUp, ...(b.semifinalists || []), ...players].filter((x, i, a) => x && a.indexOf(x) === i) : players;
  const replaced = Object.entries(t.replaced || {}).map(([o, n]) => `${nameOf(t, n)} replaced ${nameOf(t, o)}`);
  return `${b.champion ? podium(t, b) : ''}<ul class="list" role="list">${order
    .map((pid) => {
      const [text, cls] = fate(pid);
      return `<li class="cell admin-friend">${avatar(person(t, pid), 'sm')}<span class="cell__stack"><span class="cell__title">${esc(nameOf(t, pid))}</span>${pid === t.creator ? '<span class="cell__sub">Host</span>' : ''}</span>
        <span class="admin-tag ${cls}">${esc(text)}</span>
        ${host && text === 'Still in' && pid !== me ? `<button type="button" class="chip tour-replace" data-tp="replace" data-who="${esc(pid)}">Replace</button>` : ''}</li>`;
    })
    .join('')}</ul>
    <p class="group__foot">${esc(rulesText(t))}${replaced.length ? `. ${esc(replaced.join('; '))}.` : ''}</p>`;
}

function podium(t, b) {
  const step = (pid, place, cls) => (pid ? `<div class="podium__step ${cls}">${avatar(person(t, pid), place === 1 ? 'lg' : 'md')}<span class="podium__name">${esc(nameOf(t, pid))}</span><span class="podium__block">${place}</span></div>` : '');
  return `<div class="podium" aria-label="Podium">${step(b.runnerUp, 2, 'is-second')}${step(b.champion, 1, 'is-first')}${step(b.semifinalists?.[0], 3, 'is-third')}</div>`;
}

// ---------- clicks on the page ----------

/** Clicks on the tournament page (bound once by app.js). */
export async function onPageClick(e, el) {
  const id = view.id;
  const t = state.tournaments.find((x) => x.id === id);
  if (!t) return;
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    haptic('light');
    view.tab = tab.dataset.tab;
    return renderPage(el, id);
  }
  const round = e.target.closest('[data-round]');
  if (round) {
    haptic('light');
    view.round = Number(round.dataset.round);
    return renderPage(el, id);
  }
  const match = e.target.closest('[data-match]');
  if (match) return showMatch(t, match.dataset.match);
  const btn = e.target.closest('[data-tp]');
  const act = btn?.dataset.tp;
  if (!act) return;
  if (act === 'full') {
    view.full = !view.full;
    return renderPage(el, id);
  }
  if (act === 'yes' || act === 'no') return respond(id, act === 'yes');
  if (act === 'invite') return openInviteFriends(t);
  if (act === 'edit') return openEditTournament(t);
  if (act === 'runback') return openCreateTournament({ from: t });
  if (act === 'share') return shareResult(t);
  if (act === 'replace') return openReplace(t, btn.dataset.who);
  if (act === 'log') return deps.logGame?.(person(t, btn.dataset.opp), t);
  if (act === 'nudge') return run(() => store.nudge(id, btn.dataset.opp), `${person(t, btn.dataset.opp).display_name} got a nudge 👋`);
  if (act === 'leave' || act === 'quit') {
    const started = act === 'quit';
    const b = started ? bracketOf(t) : null;
    const m = started ? currentMatch(b, meId()) : null;
    const opp = m ? (m.a === meId() ? m.b : m.a) : null;
    const ok = await alertDialog({
      title: `${started ? 'Quit' : 'Leave'} ${t.name}?`,
      message: started
        ? `${opp ? `${person(t, opp).display_name} wins your series automatically. ` : groupTodo(b, meId()) ? 'Your remaining group games count as losses. ' : ''}You can’t rejoin, and it’s removed from your tournaments.`
        : 'It’s removed from your tournaments. You can be invited again before it starts.',
      actions: [CANCEL, { label: started ? 'Quit' : 'Leave', style: 'destructive', value: true }],
    });
    if (!ok) return;
    if (await run(() => store.quitTournament(id), started ? 'You quit the tournament' : 'You left the tournament')) deps.openList?.();
    return;
  }
  if (act === 'start' && t.draw === 'custom') return openSetup(t);
  if (act === 'start') {
    const n = accepted(t).length;
    const ok = await alertDialog({
      title: `Start ${t.name} now?`,
      message: `${t.format === 'groups' ? 'The groups are' : 'The bracket is'} drawn with the ${n} players who joined.${t.players.length > n ? ' Anyone who hasn’t answered yet misses out.' : ''}`,
      actions: [CANCEL, { label: 'Start', value: true }],
    });
    if (ok) await run(() => store.startTournament(id), t.format === 'groups' ? 'The groups are drawn. Good luck!' : 'The bracket is drawn. Good luck!');
    return;
  }
  if (act === 'cancel') {
    const ok = await alertDialog({
      title: `Cancel ${t.name}?`,
      message: 'It ends for everyone. Games already played stay in everyone’s stats.',
      actions: [{ label: 'Keep It', style: 'cancel', value: null }, { label: 'Cancel Tournament', style: 'destructive', value: true }],
    });
    if (ok) await run(() => store.cancelTournament(id), 'Tournament cancelled');
    return;
  }
  if (act === 'simulate') await run(() => store.demoSimulate(id), 'Played out the other games');
}

async function run(fn, done) {
  try {
    await fn();
    haptic('success');
    toast(done);
    return true;
  } catch (err) {
    haptic('warning');
    toast(err.message || 'That didn’t work. Try again.');
    return false;
  }
}

/** Accept or decline an invite (from the Notifications page or the tournament page). */
export async function respond(id, yes) {
  try {
    await store.respondTournament(id, yes);
    haptic('success');
    const t = state.tournaments.find((x) => x.id === id);
    if (yes) toast(t?.status === 'live' ? 'You’re in, and it’s started!' : 'You’re in!', { action: { label: 'View', onClick: () => deps.openPage?.(id) } });
    else toast('Invite declined');
    return true;
  } catch (err) {
    haptic('warning');
    toast(err.message || 'That didn’t work. Try again.');
    return false;
  }
}

/** A series' games in a pop-up; the host can also decide it here. */
function showMatch(t, key) {
  const b = bracketOf(t);
  const m = b.rounds.flat().find((x) => x.key === key);
  if (!m || !m.a || !m.b) return;
  const host = hostOf(t) === meId() && !b.champion;
  const rows = m.games
    .map((g, n) => {
      const aFirst = g.player1_id === m.a;
      const [sa, sb] = aFirst ? [g.player1_score, g.player2_score] : [g.player2_score, g.player1_score];
      const [pa, pb] = aFirst ? [g.player1_pens, g.player2_pens] : [g.player2_pens, g.player1_pens];
      const extra = pa !== '' && pa != null ? ` (pens ${pa}–${pb})` : g.overtime ? (g.sport === 'fifa' ? ' ET' : ' OT') : '';
      return `<li><span class="admin-log__when">Game ${n + 1} · ${esc(shortDate(g.date))}</span><span>${esc(nameOf(t, m.a))} ${sa}–${sb}${extra} ${esc(nameOf(t, m.b))}</span></li>`;
    })
    .join('');
  const decided = t.decisions?.[key];
  const hostTools = host
    ? `<div class="tour-decide">
        <p class="tour-decide__label">Host: decide this series${m.overdue ? ' (it’s past the deadline)' : ''}</p>
        <div class="notif-card__actions"><button type="button" class="btn btn--tinted" data-decide="${esc(m.a)}">${esc(nameOf(t, m.a))} Wins</button><button type="button" class="btn btn--tinted" data-decide="${esc(m.b)}">${esc(nameOf(t, m.b))} Wins</button></div>
        ${decided ? '<button type="button" class="btn-text tour-toggle" data-decide="">Undo Your Decision</button>' : ''}
      </div>`
    : '';
  const popup = openPopup({
    title: `${nameOf(t, m.a)} vs ${nameOf(t, m.b)}`,
    subtitle: `${roundName(m.round, b.rounds.length)} · ${m.bestOf === 1 ? 'one game' : `best of ${m.bestOf}`} · ${seriesLine(t, m)}`,
    body: `${rows ? `<ul class="admin-log" role="list">${rows}</ul>` : '<p class="popup__empty">No games yet in this series.</p>'}${hostTools}`,
  });
  popup.root.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-decide]');
    if (!d) return;
    const winner = d.dataset.decide || null;
    if (winner) {
      const ok = await alertDialog({ title: `${nameOf(t, winner)} goes through?`, message: 'Any more games in this series won’t count. You can undo it.', actions: [CANCEL, { label: 'Decide', value: true }] });
      if (!ok) return;
    }
    popup.close();
    run(() => store.decideSeries(t.id, key, winner), winner ? `${nameOf(t, winner)} goes through` : 'Decision undone');
  });
}

/** The host puts one of their friends in a player's place. */
function openReplace(t, oldId) {
  const placed = placedIn(t);
  const options = state.friends.filter((f) => !placed.includes(f.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));
  if (!options.length) return toast('All your friends are already in it.');
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-r="cancel">Cancel</button>
      <div class="sheet__title-group"><h2 id="rep-title" class="sheet__title">Replace ${esc(nameOf(t, oldId))}</h2><p class="sheet__subtitle">${esc(t.name)}</p></div>
      <span></span>
    </header>
    <div class="sheet__body tour-step">
      <p class="tour-step__intro">Pick who takes ${esc(nameOf(t, oldId))}’s place. Games already played stay as they are; the new player starts their series from scratch.</p>
      <ul class="list" role="list">${options
        .map((f) => `<li><button type="button" class="cell cell--button friend-row" data-new="${esc(f.id)}">${avatar(f, 'sm')}<span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span></button></li>`)
        .join('')}</ul>
    </div>`;
  const sheet = openSheet({ content, labelledBy: 'rep-title', large: true });
  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-r="cancel"]')) return sheet.close();
    const pick = e.target.closest('[data-new]');
    if (!pick) return;
    const who = state.friends.find((f) => f.id === pick.dataset.new);
    const ok = await alertDialog({ title: `${who.display_name} replaces ${nameOf(t, oldId)}?`, actions: [CANCEL, { label: 'Replace', value: true }] });
    if (!ok) return;
    sheet.close();
    run(() => store.replacePlayer(t.id, oldId, pick.dataset.new), 'Player replaced');
  });
}

// ---------- custom set-up: drag (or tap two) to swap ----------

/** The host places everyone (bracket slots, or groups), then starts it. */
function openSetup(t) {
  const players = accepted(t);
  const groupsMode = t.format === 'groups';
  let slots, boxes; // player ids (null = a free pass), and how they're split up on screen
  const fresh = () => {
    const layout = drawFor({ ...t, draw: 'random' }, players);
    if (groupsMode) {
      slots = layout.groups.flat();
      let at = 0;
      boxes = layout.groups.map((g, i) => ({ name: groupName(i), from: (at += g.length) - g.length, size: g.length }));
    } else {
      slots = layout.seeds;
      boxes = Array.from({ length: slots.length / 2 }, (_, i) => ({ name: `Match ${i + 1}`, from: 2 * i, size: 2 }));
    }
  };
  fresh();
  let picked = null; // the slot tapped first
  const layoutOf = () => (groupsMode ? { groups: boxes.map((b) => slots.slice(b.from, b.from + b.size)) } : { seeds: slots });
  const content = document.createElement('div');
  content.className = 'sheet__content';
  const chip = (i) => {
    const pid = slots[i];
    return `<button type="button" class="setup-chip${pid ? '' : ' is-pass'}${picked === i ? ' is-picked' : ''}" data-slot="${i}" aria-pressed="${picked === i}">
      ${pid ? avatar(person(t, pid), 'sm') : '<span class="setup-chip__pass" aria-hidden="true">→</span>'}<span class="setup-chip__name">${pid ? esc(nameOf(t, pid)) : 'Free pass'}</span>
      <span class="setup-chip__grip" aria-hidden="true">⋮⋮</span></button>`;
  };
  const paint = () => {
    const problem = checkLayout(t, layoutOf(), players);
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-s="cancel">Cancel</button>
        <div class="sheet__title-group"><h2 id="setup-title" class="sheet__title">${groupsMode ? 'Set Up the Groups' : 'Set Up the Bracket'}</h2><p class="sheet__subtitle">${esc(t.name)}</p></div>
        <span></span>
      </header>
      <div class="sheet__body tour-step">
        <p class="tour-step__intro">Drag a player onto another to swap them, or tap two players.${!groupsMode && slots.length > players.length ? ' A player next to a free pass goes straight to the next round.' : ''}</p>
        <div class="setup-matches">${boxes
          .map((b) => `<div class="card setup-box"><span class="setup-match__label">${b.name}</span>${Array.from({ length: b.size }, (_, k) => chip(b.from + k)).join(groupsMode ? '' : '<span class="setup-match__vs">vs</span>')}</div>`)
          .join('')}</div>
        <button type="button" class="btn-text tour-toggle" data-s="shuffle">${icon('refresh')} Shuffle</button>
        ${problem ? `<p class="form-hint">${esc(problem)}</p>` : ''}
        <button type="button" class="btn btn--primary btn--block tour-step__next" data-s="start"${problem ? ' disabled' : ''}>Start Tournament</button>
      </div>`;
  };
  const repaint = () => {
    const keep = content.querySelector('.sheet__body')?.scrollTop || 0;
    paint();
    content.querySelector('.sheet__body').scrollTop = keep;
  };
  const swap = (i, j) => {
    picked = null;
    if (i !== j) {
      [slots[i], slots[j]] = [slots[j], slots[i]];
      haptic('light');
    }
    repaint();
  };
  paint();
  const sheet = openSheet({ content, labelledBy: 'setup-title', large: true });

  // Drag: a floating copy follows your finger; let go over another player to swap
  let drag = null;
  content.addEventListener('pointerdown', (e) => {
    const from = e.target.closest('[data-slot]');
    if (!from || e.button > 0) return;
    drag = { i: Number(from.dataset.slot), x: e.clientX, y: e.clientY, ghost: null, el: from, moved: false };
  });
  content.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.setPointerCapture?.(e.pointerId);
      drag.ghost = drag.el.cloneNode(true);
      drag.ghost.classList.add('setup-ghost');
      drag.ghost.style.width = `${drag.el.offsetWidth}px`;
      document.body.append(drag.ghost);
      drag.el.classList.add('is-dragging');
    }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX - drag.el.offsetWidth / 2}px, ${e.clientY - 24}px)`;
    content.querySelectorAll('.setup-chip.is-target').forEach((c) => c.classList.remove('is-target'));
    drag.ghost.hidden = true;
    document.elementFromPoint(e.clientX, e.clientY)?.closest('.setup-chip')?.classList.add('is-target');
    drag.ghost.hidden = false;
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return; // a tap: the click below handles it
    d.ghost.remove();
    d.el.classList.remove('is-dragging');
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-slot]');
    // A drag can end in a click on the chip; swallow that one, but only just after the drag
    const block = (ev) => ev.stopPropagation();
    content.addEventListener('click', block, { capture: true, once: true });
    setTimeout(() => content.removeEventListener('click', block, { capture: true }), 80);
    if (over) swap(d.i, Number(over.dataset.slot));
    else repaint();
  };
  content.addEventListener('pointerup', endDrag);
  content.addEventListener('pointercancel', endDrag);

  content.addEventListener('click', async (e) => {
    const slot = e.target.closest('[data-slot]');
    if (slot) {
      const i = Number(slot.dataset.slot);
      if (picked === null) {
        haptic('light');
        picked = i;
        return repaint();
      }
      return swap(picked, i);
    }
    const act = e.target.closest('[data-s]')?.dataset.s;
    if (act === 'cancel') return sheet.close();
    if (act === 'shuffle') {
      haptic('light');
      fresh();
      picked = null;
      return repaint();
    }
    if (act !== 'start' || checkLayout(t, layoutOf(), players)) return;
    const btn = e.target.closest('[data-s]');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      await store.startTournament(t.id, layoutOf());
      haptic('success');
      sheet.close();
      toast('It’s on. Good luck!');
    } catch (err) {
      haptic('warning');
      toast(err.message || 'Couldn’t start it. Try again.');
      repaint();
    }
  });
}

/** Invite more of your friends to a tournament that hasn't started (anyone who joined can). */
function openInviteFriends(t) {
  const options = state.friends.filter((f) => !t.players.includes(f.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));
  if (!options.length) return toast('All your friends are already invited.');
  const picked = new Set();
  const room = MAX_PLAYERS - t.players.length;
  const content = document.createElement('div');
  content.className = 'sheet__content';
  const paint = () => {
    content.innerHTML = `
      <header class="sheet__header">
        <button type="button" class="btn-text" data-i="cancel">Cancel</button>
        <div class="sheet__title-group"><h2 id="inv-title" class="sheet__title">Invite Friends</h2><p class="sheet__subtitle">${esc(t.name)}</p></div>
        <span></span>
      </header>
      <div class="sheet__body tour-step">
        <p class="tour-step__intro">They get an invite on their Notifications page${t.creator === meId() ? '' : ', from you'}. Room for ${room} more.</p>
        <ul class="list" role="list">${options
          .map(
            (f) => `<li><button type="button" class="cell cell--button friend-row" data-pick="${esc(f.id)}" aria-pressed="${picked.has(f.id)}">
              ${avatar(f, 'sm')}<span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span>
              <span class="tour-check${picked.has(f.id) ? ' is-on' : ''}" aria-hidden="true">${picked.has(f.id) ? icon('check') : ''}</span></button></li>`,
          )
          .join('')}</ul>
        <button type="button" class="btn btn--primary btn--block tour-step__next" data-i="send"${picked.size ? '' : ' disabled'}>${picked.size ? `Invite ${plural(picked.size, 'Friend')}` : 'Pick Friends to Invite'}</button>
      </div>`;
  };
  paint();
  const sheet = openSheet({ content, labelledBy: 'inv-title', large: true });
  content.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      haptic('light');
      const fid = pick.dataset.pick;
      if (picked.has(fid)) picked.delete(fid);
      else if (picked.size < room) picked.add(fid);
      else return toast(`A tournament can have up to ${MAX_PLAYERS} players.`);
      const keep = content.querySelector('.sheet__body').scrollTop;
      paint();
      content.querySelector('.sheet__body').scrollTop = keep;
      return;
    }
    const act = e.target.closest('[data-i]')?.dataset.i;
    if (act === 'cancel') return sheet.close();
    if (act !== 'send' || !picked.size) return;
    const btn = e.target.closest('[data-i]');
    btn.disabled = true;
    btn.textContent = 'Inviting…';
    try {
      await store.inviteToTournament(t.id, [...picked]);
      haptic('success');
      sheet.close();
      toast(`Invited ${plural(picked.size, 'friend')}`);
    } catch (err) {
      haptic('warning');
      toast(err.message || 'Couldn’t invite them. Try again.');
      paint();
    }
  });
}

// ---------- Notifications page: tournament updates ----------

/** Your tournament updates from the last two weeks, newest first: [{ at, t, text, icon }]. */
export function updates() {
  const me = meId();
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const out = [];
  for (const t of state.tournaments) {
    if (t.status !== 'live') continue;
    const b = bracketOf(t);
    for (const ev of eventsFor(t, b, me)) {
      if (ev.at < since) continue;
      const rn = ev.round != null ? oneRound(ev.round, ev.total) : '';
      const opp = ev.opp ? nameOf(t, ev.opp) : '';
      const how = ev.by === 'host' ? ' (host’s call)' : ev.by === 'deadline' ? ' (at the deadline)' : ev.by === 'forfeit' ? ' (they quit)' : '';
      const final = ev.round === ev.total - 1;
      const line = {
        started: [`${t.name} has started`, '🏁'],
        ready: [`Your ${rn} vs ${opp} is ready to play`, '🎮'],
        won: [final ? `You won ${t.name}!` : `You beat ${opp}${how}: through to the ${oneRound(ev.round + 1, ev.total)}`, final ? '🏆' : '✅'],
        lost: [`You’re out of ${t.name}: ${opp} won your ${rn}${how}`, '👋'],
        champion: [`${nameOf(t, ev.who)} won ${t.name}`, '🏆'],
        nudge: [`${nameOf(t, ev.from)} is ready to play you in ${t.name}`, '👋'],
        deadline: [`Your ${rn} vs ${opp} ends ${when(ev.deadline)}`, '⏰'],
        groups: [ev.through ? `You’re through the group stage of ${t.name}` : `The group stage of ${t.name} is over: you didn’t make it through`, ev.through ? '✅' : '👋'],
      }[ev.kind];
      if (line) out.push({ at: ev.at, t, text: line[0], icon: line[1] });
    }
  }
  return out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

// ---------- the champion moment ----------

/** Confetti, once per phone, the first time you open a finished tournament. */
function celebrate(t) {
  const b = bracketOf(t);
  if (!b.champion || reducedMotion.matches) return;
  const key = `h2h.celebrated.${t.id}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#FFC233', '#34C759', '#0A84FF', '#FF375F', '#BF5AF2', '#FF9F0A'];
  const bits = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (now) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of bits) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - start < 3200) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
  haptic('success');
}

/** A picture of the result to send to friends (WhatsApp etc.), or a download where sharing isn't there. */
async function shareResult(t) {
  const b = bracketOf(t);
  if (!b.champion) return;
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1C1C2E');
  bg.addColorStop(1, '#3A2A08');
  x.fillStyle = bg;
  x.fillRect(0, 0, W, H);
  x.textAlign = 'center';
  x.fillStyle = '#FFC233';
  x.font = '700 44px -apple-system, system-ui, sans-serif';
  x.fillText('CHAMPION', W / 2, 250);
  x.font = '160px serif';
  x.fillText('🏆', W / 2, 470);
  const champ = person(t, b.champion);
  x.beginPath();
  x.arc(W / 2, 640, 110, 0, Math.PI * 2);
  x.fillStyle = champ.color;
  x.fill();
  x.fillStyle = '#fff';
  x.font = '700 110px -apple-system, system-ui, sans-serif';
  x.fillText(champ.initial, W / 2, 678);
  x.font = '800 92px -apple-system, system-ui, sans-serif';
  x.fillText(champ.display_name, W / 2, 870);
  const final = b.rounds.at(-1)[0];
  const [w, l] = final.winner === final.a ? [final.winsA, final.winsB] : [final.winsB, final.winsA];
  x.fillStyle = 'rgba(255,255,255,0.75)';
  x.font = '500 46px -apple-system, system-ui, sans-serif';
  if (b.runnerUp) x.fillText(`beat ${person(t, b.runnerUp).display_name} ${w}–${l} in the final`, W / 2, 950);
  x.fillStyle = '#fff';
  x.font = '700 60px -apple-system, system-ui, sans-serif';
  x.fillText(t.name, W / 2, 1110);
  x.fillStyle = 'rgba(255,255,255,0.6)';
  x.font = '500 40px -apple-system, system-ui, sans-serif';
  x.fillText(`${MODE[t.sport]} · ${placedIn(t).length} players · Dubs`, W / 2, 1180);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], `${t.name.replace(/[^\w ]+/g, '').trim() || 'tournament'}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: t.name, text: `${champ.display_name} won ${t.name} 🏆` });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Saved the picture');
}
