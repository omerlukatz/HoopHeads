// Admin console: what the admin account sees instead of the normal app.
//   Players  → every player, with their status (not moved yet / suspended)
//   Player   → reset PIN, suspend, friendships, and all their games (edit, delete, log new ones)
//   Menu     → announcements (push + Notifications page), the private history, change PIN, sign out
// Changes are anonymous: no notifications, no labels, and a logged game is credited to player 1.
// Every change is written to the admin's private history (adminLog).
import * as store from './store.js';
import { getTeam } from './teams.js';
import { icon, logo, esc, haptic, openSheet, alertDialog, openPopup, toast } from './ui.js';
import { avatar, changePinFlow } from './lock.js';

const MODE = { '2k': 'NBA 2K', fifa: 'FIFA' };
const CANCEL = { label: 'Cancel', style: 'cancel', value: null };

let deps = {}; // { openTeamPicker } from app.js
let data = null; // store.admin.load(): { users, friendships, blocks, games, phones }
let page = { userId: null, query: '', opp: '', sport: 'all' };
let root = null;

const $ = (sel, el = root) => el.querySelector(sel);
const userById = (id) => data?.users.find((u) => u.id === id) || null;
const nameOf = (id) => userById(id)?.display_name || 'Deleted player';
const friendsOf = (id) => (data?.friendships || []).filter((f) => f.a === id || f.b === id).map((f) => (f.a === id ? f.b : f.a));
const gamesOf = (id) => (data?.games || []).filter((g) => g.player1_id === id || g.player2_id === id).sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
const blockedBetween = (a, b) => (data?.blocks || []).some((x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Alex 52–48 Omer · NBA 2K · Oct 7" (with OT/ET and penalties). */
function gameText(g) {
  const pens = g.player1_pens !== '' && g.player2_pens !== '' && g.player1_pens != null ? ` (pens ${g.player1_pens}–${g.player2_pens})` : '';
  const extra = !pens && g.overtime ? (g.sport === 'fifa' ? ' (ET)' : ' (OT)') : '';
  return `${nameOf(g.player1_id)} ${g.player1_score}–${g.player2_score} ${nameOf(g.player2_id)}${extra}${pens} · ${MODE[g.sport] || 'NBA 2K'} · ${shortDate(g.date)}`;
}

// ---------- start / stop ----------

export async function startAdmin(d) {
  deps = d;
  document.documentElement.classList.add('is-admin');
  root = document.getElementById('admin');
  if (!root) {
    root = document.createElement('div');
    root.id = 'admin';
    root.className = 'admin';
    document.getElementById('layer').before(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
  }
  page = { userId: null, query: '', opp: '', sport: 'all' };
  root.innerHTML = `<div class="scroller"><div class="content is-ready"><p class="admin-empty">Loading players…</p></div></div>`;
  await ensureAdminPin();
  await reload();
}

export function stopAdmin() {
  document.documentElement.classList.remove('is-admin');
  if (root) root.innerHTML = '';
  data = null;
}

/** The admin account signs in with 8 digits. The first time (still on its old 4-digit PIN), set one. */
async function ensureAdminPin() {
  if ((await store.pinLength('admin')) === 8) return;
  await changePinFlow({
    newLength: 8,
    intro: 'The admin account needs an 8-digit PIN. First, enter your current PIN.',
    leave: { label: 'Sign Out', fn: () => store.signOut() },
  });
  toast('Admin PIN set. Use your 8 digits from now on.');
}

async function reload() {
  try {
    data = await store.admin.load();
  } catch (err) {
    root.innerHTML = `<div class="scroller"><div class="content is-ready"><p class="admin-empty">Couldn’t load the players. ${esc(err.message || '')}</p><button type="button" class="btn btn--primary" data-a="retry">Try Again</button></div></div>`;
    return;
  }
  render();
}

function render() {
  if (!data) return;
  const keep = $('.scroller')?.scrollTop || 0;
  const samePage = root.dataset.page === (page.userId || 'players');
  root.dataset.page = page.userId || 'players';
  root.innerHTML = `<div class="scroller">${page.userId && userById(page.userId) ? playerPage(userById(page.userId)) : playersPage()}</div>`;
  if (samePage) $('.scroller').scrollTop = keep;
}

// ---------- players ----------

function playersPage() {
  const q = page.query.trim().toLowerCase().replace(/^@/, '');
  const list = data.users
    .filter((u) => !q || u.username.includes(q) || u.display_name.toLowerCase().includes(q))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const rows = list
    .map((u) => {
      const tags = [!u.moved && '<span class="admin-tag">Not moved yet</span>', u.suspended && '<span class="admin-tag admin-tag--warn">Suspended</span>'].filter(Boolean).join('');
      return `<li><button type="button" class="cell cell--button friend-row" data-a="open" data-id="${esc(u.id)}" aria-label="${esc(u.display_name)}, @${esc(u.username)}">
        ${avatar(u, 'md')}
        <span class="cell__stack"><span class="cell__title">${esc(u.display_name)}</span><span class="cell__sub">@${esc(u.username)} · ${plural(gamesOf(u.id).length, 'game')}</span></span>
        ${tags ? `<span class="admin-tags">${tags}</span>` : ''}
        ${icon('chevron', 'cell__chevron')}
      </button></li>`;
    })
    .join('');
  return `
    <div class="admin-top">
      <h1 class="large-title">Admin</h1>
      <button type="button" class="admin-menu" data-a="menu" aria-label="Admin menu">${icon('more')}</button>
    </div>
    <div class="content is-ready">
      <button type="button" class="btn btn--primary btn--block admin-announce" data-a="announce">📣 Send Announcement</button>
      <div class="search admin-search" role="search">
        ${icon('search')}
        <input type="search" id="admin-search" value="${esc(page.query)}" placeholder="Search players" aria-label="Search players" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
      </div>
      <section class="group">
        <div class="group__head"><h2>Players · ${data.users.length}</h2><span class="group__record">${plural(data.phones, 'phone')} with notifications</span></div>
        ${rows ? `<ul class="list" role="list">${rows}</ul>` : '<p class="admin-empty">No players match.</p>'}
      </section>
    </div>`;
}

// ---------- one player ----------

function playerPage(u) {
  const friendIds = friendsOf(u.id).filter((id) => userById(id));
  const all = gamesOf(u.id);
  const games = all.filter((g) => (!page.opp || g.player1_id === page.opp || g.player2_id === page.opp) && (page.sport === 'all' || g.sport === page.sport));
  const opponents = [...new Set(all.map((g) => (g.player1_id === u.id ? g.player2_id : g.player1_id)))];
  const tags = [!u.moved && '<span class="admin-tag">Not moved yet</span>', u.suspended && '<span class="admin-tag admin-tag--warn">Suspended</span>', u.phones && `<span class="admin-tag">🔔 ${plural(u.phones, 'phone')}</span>`].filter(Boolean).join('');
  const sports = [['all', 'All'], ['2k', '2K'], ['fifa', 'FIFA']];
  const sportIndex = sports.findIndex(([id]) => id === page.sport);

  const friendRows = friendIds
    .map((id) => userById(id))
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map(
      (f) => `<li class="cell admin-friend">${avatar(f, 'sm')}<span class="cell__stack"><span class="cell__title">${esc(f.display_name)}</span><span class="cell__sub">@${esc(f.username)}</span></span>
        <button type="button" class="chip chip--danger" data-a="unfriend" data-id="${esc(f.id)}" aria-label="Remove ${esc(f.display_name)} as a friend">Remove</button></li>`,
    )
    .join('');

  const gameRows = games
    .map((g) => {
      const pens = g.player1_pens !== '' && g.player2_pens !== '' && g.player1_pens != null;
      const tag = pens ? `pens ${g.player1_pens}–${g.player2_pens}` : g.overtime ? (g.sport === 'fifa' ? 'ET' : 'OT') : '';
      return `<li><button type="button" class="admin-game" data-a="game" data-id="${esc(g.id)}" aria-label="Edit game: ${esc(gameText(g))}">
        <span class="admin-game__date">${esc(shortDate(g.date))}<small>${g.sport === 'fifa' ? 'FIFA' : '2K'}</small></span>
        <span class="admin-game__side">${logo(g.player1_team, { size: 'sm', alt: '' })}<span>${esc(nameOf(g.player1_id))}</span></span>
        <span class="admin-game__score">${g.player1_score}–${g.player2_score}${tag ? `<small>${esc(tag)}</small>` : ''}</span>
        <span class="admin-game__side admin-game__side--end"><span>${esc(nameOf(g.player2_id))}</span>${logo(g.player2_team, { size: 'sm', alt: '' })}</span>
      </button></li>`;
    })
    .join('');

  return `
    <div class="content is-ready">
      <button type="button" class="btn-text admin-back" data-a="back"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.75-6.25 6.25 6.25 6.25"/></svg>Players</button>
      <div class="admin-head">
        ${avatar(u, 'xl')}
        <h1 class="admin-head__name">${esc(u.display_name)}</h1>
        <p class="admin-head__sub">@${esc(u.username)}${u.created_at ? ` · Joined ${esc(longDate(String(u.created_at).slice(0, 10)))}` : ''}</p>
        <p class="admin-head__sub">${plural(friendIds.length, 'friend')} · ${plural(all.length, 'game')}</p>
        ${tags ? `<div class="admin-tags admin-tags--center">${tags}</div>` : ''}
      </div>

      <section class="group">
        <div class="group__head"><h2>Account</h2></div>
        <ul class="list" role="list">
          <li><button type="button" class="cell cell--button" data-a="reset-pin">${icon('key')}<span>Reset PIN</span></button></li>
          <li><button type="button" class="cell cell--button ${u.suspended ? '' : 'cell--destructive'}" data-a="suspend">${u.suspended ? 'Unsuspend Account' : 'Suspend Account'}</button></li>
        </ul>
        <p class="group__foot">${u.suspended ? 'This player can’t sign in. Their games still count for their friends.' : 'Reset PIN sets a new 4-digit PIN for you to pass on. Suspending stops them signing in; their games stay.'}</p>
      </section>

      <section class="group">
        <div class="group__head"><h2>Friends · ${friendIds.length}</h2><button type="button" class="btn-text admin-head-action" data-a="add-friend">${icon('people')}Add Friend</button></div>
        ${friendRows ? `<ul class="list" role="list">${friendRows}</ul>` : '<p class="admin-empty">No friends yet.</p>'}
      </section>

      <section class="group">
        <div class="group__head"><h2>Games · ${all.length}</h2><button type="button" class="btn-text admin-head-action" data-a="log" ${friendIds.length ? '' : 'disabled'}>${icon('log')}Log Game</button></div>
        ${
          all.length
            ? `<div class="admin-filters">
          <select id="admin-opp" aria-label="Filter by opponent"><option value="">All opponents</option>${opponents
            .map((id) => `<option value="${esc(id)}"${id === page.opp ? ' selected' : ''}>vs ${esc(nameOf(id))}</option>`)
            .join('')}</select>
          <div class="seg" role="radiogroup" aria-label="Game" style="--count:3;--index:${sportIndex}">
            <span class="seg__thumb" aria-hidden="true"></span>
            ${sports.map(([id, label], i) => `<button type="button" class="seg__item" role="radio" aria-checked="${i === sportIndex}" data-a="sport" data-sport="${id}">${label}</button>`).join('')}
          </div>
        </div>`
            : ''
        }
        ${gameRows ? `<ul class="list admin-games" role="list">${gameRows}</ul>` : `<p class="admin-empty">${all.length ? 'No games match.' : 'No games yet.'}</p>`}
      </section>
    </div>`;
}

// ---------- events ----------

function onInput(e) {
  if (e.target.id === 'admin-search') {
    page.query = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = $('#admin-search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }
  if (e.target.id === 'admin-opp' && e.type === 'change') {
    page.opp = e.target.value;
    render();
  }
}

async function onClick(e) {
  const btn = e.target.closest('[data-a]');
  if (!btn || btn.disabled) return;
  const a = btn.dataset.a;
  const u = page.userId ? userById(page.userId) : null;
  if (a === 'retry') return reload();
  if (a === 'open') {
    haptic('light');
    page = { ...page, userId: btn.dataset.id, opp: '', sport: 'all' };
    render();
    $('.scroller').scrollTop = 0;
    return;
  }
  if (a === 'back') {
    page.userId = null;
    render();
    return;
  }
  if (a === 'menu') return openMenu();
  if (a === 'announce') return openAnnouncement();
  if (a === 'sport') {
    page.sport = btn.dataset.sport;
    return render();
  }
  if (!u) return;
  if (a === 'reset-pin') return resetPin(u);
  if (a === 'suspend') return suspend(u);
  if (a === 'add-friend') return addFriend(u);
  if (a === 'unfriend') return unfriend(u, userById(btn.dataset.id));
  if (a === 'log') return openGame({ player1: u.id });
  if (a === 'game') return openGame({ id: btn.dataset.id });
}

/** Runs an admin change, then reloads. Returns true if it worked. */
async function act(fn, done) {
  try {
    await fn();
  } catch (err) {
    haptic('warning');
    toast(err.message || 'That didn’t work. Try again.');
    return false;
  }
  haptic('success');
  if (done) toast(done);
  await reload();
  return true;
}

// ---------- account: PIN, suspend ----------

function resetPin(u) {
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-s="cancel">Cancel</button>
      <h2 id="pin-title" class="sheet__title">Reset PIN</h2>
      <button type="button" class="btn-text btn-text--strong" data-s="save" disabled>Set</button>
    </header>
    <div class="sheet__body">
      <p class="admin-sheet-intro">Choose a new 4-digit PIN for <strong>${esc(u.display_name)}</strong> (@${esc(u.username)}). Pass it on to them; they can change it in Settings.</p>
      <ul class="list list--form" role="list">
        <li class="cell"><label for="new-pin">New PIN</label><input id="new-pin" class="cell__input admin-pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="4 digits"></li>
      </ul>
      <button type="button" class="btn btn--tinted btn--block" data-s="random">Make One Up</button>
      <button type="button" class="btn btn--primary btn--block" data-s="save" disabled>Set PIN</button>
    </div>`;
  const input = $('#new-pin', content);
  const saves = [...content.querySelectorAll('[data-s="save"]')];
  const check = () => saves.forEach((b) => (b.disabled = !/^\d{4}$/.test(input.value)));
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    check();
  });
  const sheet = openSheet({ content, labelledBy: 'pin-title', initialFocus: '#new-pin' });
  content.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (s === 'cancel') return sheet.close();
    if (s === 'random') {
      input.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
      return check();
    }
    if (s !== 'save' || !/^\d{4}$/.test(input.value)) return;
    const pin = input.value;
    saves.forEach((b) => (b.disabled = true));
    try {
      await store.admin.resetPin(u.id, pin, `Reset @${u.username}’s PIN`);
    } catch (err) {
      haptic('warning');
      toast(err.message || 'Couldn’t reset the PIN.');
      return check();
    }
    haptic('success');
    await sheet.close();
    openPopup({
      title: 'PIN Reset',
      subtitle: `${u.display_name} (@${u.username})`,
      body: `<p class="admin-pin-show" aria-label="New PIN ${pin.split('').join(' ')}">${pin}</p><p class="admin-sheet-intro">Tell ${esc(u.display_name)} their new PIN. It won’t be shown again.</p>`,
    });
    reload();
  });
}

async function suspend(u) {
  const on = !u.suspended;
  const ok = await alertDialog({
    title: on ? `Suspend ${u.display_name}?` : `Unsuspend ${u.display_name}?`,
    message: on ? 'They won’t be able to sign in, and any open app signs them out within the hour. Their games stay.' : 'They’ll be able to sign in again.',
    actions: [CANCEL, { label: on ? 'Suspend' : 'Unsuspend', style: on ? 'destructive' : 'default', value: true }],
  });
  if (!ok) return;
  act(() => store.admin.suspend(u.id, on, `${on ? 'Suspended' : 'Unsuspended'} @${u.username}`), on ? `${u.display_name} is suspended` : `${u.display_name} can sign in again`);
}

// ---------- friendships ----------

function addFriend(u) {
  const current = new Set(friendsOf(u.id));
  const options = data.users.filter((x) => x.id !== u.id && !current.has(x.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-s="cancel">Cancel</button>
      <div class="sheet__title-group"><h2 id="af-title" class="sheet__title">Add Friend</h2><p class="sheet__subtitle">for ${esc(u.display_name)}</p></div>
      <span></span>
    </header>
    <div class="sheet__body">
      ${
        options.length
          ? `<ul class="list" role="list">${options
              .map(
                (x) => `<li><button type="button" class="cell cell--button friend-row" data-pick="${esc(x.id)}">${avatar(x, 'sm')}<span class="cell__stack"><span class="cell__title">${esc(x.display_name)}</span><span class="cell__sub">@${esc(x.username)}${blockedBetween(u.id, x.id) ? ' · blocked' : ''}</span></span></button></li>`,
              )
              .join('')}</ul>`
          : '<p class="admin-empty">They’re already friends with everyone.</p>'
      }
    </div>`;
  const sheet = openSheet({ content, labelledBy: 'af-title', large: true });
  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-s="cancel"]')) return sheet.close();
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    const other = userById(pick.dataset.pick);
    if (blockedBetween(u.id, other.id)) return toast(`One of them blocked the other. ${other.display_name} can’t be added.`);
    await sheet.close();
    act(() => store.admin.setFriends(u.id, other.id, true, `Made @${u.username} and @${other.username} friends`), `${u.display_name} and ${other.display_name} are friends`);
  });
}

async function unfriend(u, other) {
  if (!other) return;
  const ok = await alertDialog({
    title: `Remove ${other.display_name}?`,
    message: `${u.display_name} and ${other.display_name} won’t be friends any more. Their games together stay.`,
    actions: [CANCEL, { label: 'Remove', style: 'destructive', value: true }],
  });
  if (!ok) return;
  act(() => store.admin.setFriends(u.id, other.id, false, `Removed the friendship between @${u.username} and @${other.username}`), 'Friendship removed');
}

// ---------- games ----------

function teamTile(slot, abbr, whose) {
  const team = getTeam(abbr);
  return `<button type="button" class="team-tile${team ? '' : ' is-empty'}" data-pick-team="${slot}" aria-label="${esc(whose)}’s team: ${team ? esc(team.name) : 'none chosen'}. Change team">
    ${team ? logo(abbr, { size: 'xl', alt: '' }) : `<span class="team-tile__placeholder">${icon('log')}</span>`}
    <span class="team-tile__name">${team ? esc(team.nickname) : 'Choose Team'}</span>
  </button>`;
}

/** Edit a saved game (`id`), or log a new one for `player1` against one of their friends. */
function openGame({ id = null, player1 = null }) {
  const source = id ? data.games.find((g) => g.id === id) : null;
  if (id && !source) return;
  const editing = Boolean(source);
  const p1 = editing ? source.player1_id : player1;
  const choices = editing ? [source.player2_id] : friendsOf(p1).filter((x) => userById(x));
  if (!choices.length) return toast(`${nameOf(p1)} has no friends to play against yet.`);
  const d = editing
    ? { ...source, player1_pens: source.player1_pens ?? '', player2_pens: source.player2_pens ?? '' }
    : { sport: '2k', date: todayISO(), player1_id: p1, player2_id: choices[0], player1_team: null, player2_team: null, player1_score: '', player2_score: '', overtime: false, note: '', player1_pens: '', player2_pens: '' };

  const content = document.createElement('div');
  content.className = 'sheet__content';
  const paint = () => {
    const fifa = d.sport === 'fifa';
    content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-s="cancel">Cancel</button>
      <h2 id="ag-title" class="sheet__title">${editing ? 'Edit Game' : 'Log Game'}</h2>
      <button type="button" class="btn-text btn-text--strong" data-s="save" disabled>Save</button>
    </header>
    <form class="sheet__body game-form" novalidate autocomplete="off">
      <div class="seg seg--large" role="radiogroup" aria-label="Game" style="--count:2;--index:${fifa ? 1 : 0}">
        <span class="seg__thumb" aria-hidden="true"></span>
        <button type="button" class="seg__item" role="radio" aria-checked="${!fifa}" data-sport="2k">NBA 2K</button>
        <button type="button" class="seg__item" role="radio" aria-checked="${fifa}" data-sport="fifa">FIFA</button>
      </div>
      <div class="matchup">
        <div class="side">
          <span class="side__name">${esc(nameOf(d.player1_id))}</span>
          <div class="side__tile">${teamTile(1, d.player1_team, nameOf(d.player1_id))}</div>
          <input class="score-input" name="s1" inputmode="numeric" pattern="[0-9]*" maxlength="${fifa ? 2 : 3}" placeholder="0" aria-label="${esc(nameOf(d.player1_id))}’s score" value="${d.player1_score}">
        </div>
        <span class="matchup__vs" aria-hidden="true">VS</span>
        <div class="side">
          ${
            editing || choices.length === 1
              ? `<span class="side__name">${esc(nameOf(d.player2_id))}</span>`
              : `<select class="admin-opp-select" name="p2" aria-label="Opponent">${choices.map((x) => `<option value="${esc(x)}"${x === d.player2_id ? ' selected' : ''}>${esc(nameOf(x))}</option>`).join('')}</select>`
          }
          <div class="side__tile">${teamTile(2, d.player2_team, nameOf(d.player2_id))}</div>
          <input class="score-input" name="s2" inputmode="numeric" pattern="[0-9]*" maxlength="${fifa ? 2 : 3}" placeholder="0" aria-label="${esc(nameOf(d.player2_id))}’s score" value="${d.player2_score}">
        </div>
      </div>
      <p class="form-hint" role="status" aria-live="polite"></p>
      <ul class="list list--form" role="list">
        <li class="cell"><label for="ag-date">Date</label><input type="date" id="ag-date" name="date" class="date-input" value="${esc(d.date)}" max="${todayISO()}"></li>
        <li class="cell"><label for="ag-ot">${fifa ? 'Extra Time' : 'Overtime'}</label><input type="checkbox" role="switch" class="switch" id="ag-ot" name="overtime"${d.overtime ? ' checked' : ''}></li>
        ${
          fifa
            ? `<li class="cell pens-row" data-pens hidden><span class="pens-row__label">Penalties</span>
            <span class="pens-row__inputs"><input class="pens-input" name="pp1" inputmode="numeric" maxlength="2" placeholder="${esc(nameOf(d.player1_id))}" value="${d.player1_pens}"><span aria-hidden="true">–</span><input class="pens-input" name="pp2" inputmode="numeric" maxlength="2" placeholder="${esc(nameOf(d.player2_id))}" value="${d.player2_pens}"></span></li>`
            : ''
        }
        <li class="cell"><input name="note" class="cell__input cell__input--full" placeholder="Note (optional)" maxlength="80" value="${esc(d.note || '')}" aria-label="Note"></li>
      </ul>
      <button type="button" class="btn btn--primary btn--block" data-s="save" disabled>${editing ? 'Save Changes' : 'Save Game'}</button>
      ${editing ? '<button type="button" class="btn btn--plain-destructive btn--block" data-s="delete">Delete Game</button>' : ''}
    </form>`;
    validate();
  };

  const form = () => content.querySelector('form');
  const read = () => {
    const f = form();
    d.player1_score = f.s1.value;
    d.player2_score = f.s2.value;
    d.date = f.date.value;
    d.overtime = f.overtime.checked;
    d.note = f.note.value.trim();
    if (f.p2) d.player2_id = f.p2.value;
    d.player1_pens = f.pp1 ? f.pp1.value : '';
    d.player2_pens = f.pp2 ? f.pp2.value : '';
  };
  /** Same rules as a player's game form. Returns the game to save, or null. */
  const validate = () => {
    read();
    const fifa = d.sport === 'fifa';
    const filled = d.player1_score !== '' && d.player2_score !== '';
    const tie = filled && +d.player1_score === +d.player2_score;
    const shootoutOpen = fifa && tie && d.overtime;
    const pensRow = content.querySelector('[data-pens]');
    if (pensRow) pensRow.hidden = !shootoutOpen;
    const pens = shootoutOpen && (d.player1_pens !== '' || d.player2_pens !== '');
    const pensBad = pens && (d.player1_pens === '' || d.player2_pens === '' || +d.player1_pens === +d.player2_pens);
    const ok = filled && (fifa || !tie) && !pensBad && d.player1_team && d.player2_team && d.date;
    content.querySelector('.form-hint').textContent = !fifa && tie ? 'Basketball has no ties. Someone has to win.' : pensBad ? 'Enter both penalty scores. A shootout needs a winner.' : '';
    content.querySelectorAll('[data-s="save"]').forEach((b) => (b.disabled = !ok));
    if (!ok) return null;
    const shootout = pens && !pensBad;
    return {
      id: editing ? source.id : crypto.randomUUID(),
      sport: d.sport,
      date: d.date,
      overtime: d.overtime,
      note: d.note,
      player1_id: d.player1_id,
      player2_id: d.player2_id,
      player1_score: Number(d.player1_score),
      player2_score: Number(d.player2_score),
      player1_team: d.player1_team,
      player2_team: d.player2_team,
      player1_pens: shootout ? Number(d.player1_pens) : '',
      player2_pens: shootout ? Number(d.player2_pens) : '',
    };
  };

  paint();
  const sheet = openSheet({ content, labelledBy: 'ag-title' });
  content.addEventListener('input', (e) => {
    if (e.target.matches('.score-input, .pens-input')) e.target.value = e.target.value.replace(/\D/g, '').slice(0, d.sport === 'fifa' ? 2 : 3);
    validate();
  });
  content.addEventListener('change', (e) => {
    if (e.target.name === 'p2') {
      read();
      paint(); // names on the form follow the chosen opponent
      return;
    }
    validate();
  });
  content.addEventListener('click', async (e) => {
    const sport = e.target.closest('[data-sport]');
    if (sport) {
      read();
      if (sport.dataset.sport !== d.sport) {
        d.sport = sport.dataset.sport;
        d.player1_team = d.player2_team = null; // NBA teams and football clubs don't mix
        d.player1_pens = d.player2_pens = '';
        paint();
      }
      return;
    }
    const pick = e.target.closest('[data-pick-team]');
    if (pick) {
      read();
      const slot = pick.dataset.pickTeam;
      const who = slot === '1' ? d.player1_id : d.player2_id;
      const chosen = await deps.openTeamPicker('oppTeam', d[`player${slot}_team`], { id: who, display_name: nameOf(who) }, d.sport);
      if (chosen) {
        d[`player${slot}_team`] = chosen;
        paint();
      }
      return;
    }
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (s === 'cancel') return sheet.close();
    if (s === 'delete') {
      const ok = await alertDialog({
        title: 'Delete this game?',
        message: gameText(source),
        actions: [CANCEL, { label: 'Delete', style: 'destructive', value: true }],
      });
      if (!ok) return;
      await sheet.close();
      act(() => store.admin.deleteGame(source.id, `Deleted a game: ${gameText(source)}`), 'Game deleted');
      return;
    }
    if (s === 'save') {
      const game = validate();
      if (!game) return haptic('warning');
      const summary = editing ? `Edited a game: ${gameText(source)} → ${gameText(game)}` : `Logged a game: ${gameText(game)}`;
      content.querySelectorAll('[data-s="save"]').forEach((b) => (b.disabled = true));
      if (await act(() => store.admin.saveGame(game, summary), editing ? 'Game updated' : 'Game logged')) sheet.close();
      else validate();
    }
  });
}

// ---------- menu, history, announcements ----------

async function openMenu() {
  const choice = await alertDialog({
    title: 'Admin',
    actions: [
      { label: 'History', value: 'history' },
      { label: 'Announcements', value: 'announcements' },
      { label: 'Change Admin PIN', value: 'pin' },
      { label: 'Sign Out', style: 'destructive', value: 'signout' },
      CANCEL,
    ],
  });
  if (choice === 'history') openHistory();
  if (choice === 'announcements') openAnnouncements();
  if (choice === 'pin' && (await changePinFlow({ newLength: 8 }))) toast('Admin PIN changed');
  if (choice === 'signout') {
    const ok = await alertDialog({ title: 'Sign out of the admin account?', actions: [CANCEL, { label: 'Sign Out', style: 'destructive', value: true }] });
    if (ok) store.signOut();
  }
}

async function openHistory() {
  const popup = openPopup({ title: 'History', subtitle: 'Only you can see this.', body: '<p class="admin-empty">Loading…</p>' });
  let entries;
  try {
    entries = await store.admin.history();
  } catch (err) {
    popup.root.querySelector('.popup__body').innerHTML = `<p class="admin-empty">${esc(err.message || 'Couldn’t load the history.')}</p>`;
    return;
  }
  popup.root.querySelector('.popup__body').innerHTML = entries.length
    ? `<ul class="admin-log" role="list">${entries.map((x) => `<li><span class="admin-log__when">${esc(when(x.at))}</span><span>${esc(x.summary)}</span></li>`).join('')}</ul>`
    : '<p class="admin-empty">Nothing yet. Changes you make show up here.</p>';
}

async function openAnnouncements() {
  const popup = openPopup({ title: 'Announcements', subtitle: 'Shown on everyone’s Notifications page for 30 days.', body: '<p class="admin-empty">Loading…</p>' });
  const body = popup.root.querySelector('.popup__body');
  let list = [];
  const paint = () => {
    body.innerHTML = list.length
      ? `<ul class="admin-log" role="list">${list
          .map(
            (x) => `<li><span class="admin-log__when">${esc(when(x.created_at))}</span><strong>${esc(x.title)}</strong>${x.body ? `<span>${esc(x.body)}</span>` : ''}
            <button type="button" class="chip chip--danger" data-remove="${esc(x.id)}">Remove</button></li>`,
          )
          .join('')}</ul>`
      : '<p class="admin-empty">No announcements yet.</p>';
  };
  try {
    list = await store.admin.announcements();
  } catch (err) {
    body.innerHTML = `<p class="admin-empty">${esc(err.message || 'Couldn’t load them.')}</p>`;
    return;
  }
  paint();
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const item = list.find((x) => x.id === btn.dataset.remove);
    btn.disabled = true;
    try {
      await store.admin.removeAnnouncement(item.id, item.title);
    } catch (err) {
      btn.disabled = false;
      return toast(err.message || 'Couldn’t remove it.');
    }
    list = list.filter((x) => x !== item);
    paint();
    toast('Removed from the Notifications page');
  });
}

function openAnnouncement() {
  const content = document.createElement('div');
  content.className = 'sheet__content';
  content.innerHTML = `
    <header class="sheet__header">
      <button type="button" class="btn-text" data-s="cancel">Cancel</button>
      <h2 id="an-title" class="sheet__title">Announcement</h2>
      <span></span>
    </header>
    <div class="sheet__body">
      <ul class="list list--form" role="list">
        <li class="cell"><input id="an-head" class="cell__input cell__input--full" maxlength="60" placeholder="Title" aria-label="Title" enterkeyhint="next"></li>
        <li class="cell"><textarea id="an-body" class="admin-textarea" maxlength="300" rows="4" placeholder="Message (optional)" aria-label="Message"></textarea></li>
      </ul>
      <p class="group__foot">Preview</p>
      <div class="admin-preview"><img src="assets/icons/icon-192.png" alt="" width="36" height="36"><span><strong data-p-title>Title</strong><span data-p-body></span></span></div>
      <p class="group__foot">Goes to all ${plural(data.users.length, 'player')}: a notification on the ${plural(data.phones, 'phone')} with notifications on, and a card on everyone’s Notifications page.</p>
      <button type="button" class="btn btn--primary btn--block" data-s="send" disabled>Send to Everyone</button>
    </div>`;
  const head = $('#an-head', content);
  const text = $('#an-body', content);
  const send = $('[data-s="send"]', content);
  const id = crypto.randomUUID().replace(/-/g, '');
  const preview = () => {
    $('[data-p-title]', content).textContent = head.value.trim() || 'Title';
    $('[data-p-body]', content).textContent = text.value.trim();
    send.disabled = !head.value.trim();
  };
  content.addEventListener('input', preview);
  const sheet = openSheet({ content, labelledBy: 'an-title', initialFocus: '#an-head' });
  content.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (s === 'cancel') return sheet.close();
    if (s !== 'send' || send.disabled) return;
    const ok = await alertDialog({
      title: `Send to all ${plural(data.users.length, 'player')}?`,
      message: head.value.trim(),
      actions: [CANCEL, { label: 'Send', value: true }],
    });
    if (!ok) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const result = await store.admin.announce(id, head.value.trim(), text.value.trim());
      haptic('success');
      sheet.close();
      toast(`Sent. ${plural(result.sent || 0, 'notification')} delivered.`);
    } catch (err) {
      haptic('warning');
      send.disabled = false;
      send.textContent = 'Send to Everyone';
      toast(err.message || 'Couldn’t send it. Try again.');
    }
  });
}
