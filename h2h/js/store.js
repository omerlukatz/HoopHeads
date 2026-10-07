// App state + sync. The UI reads `state` and calls the functions below; only this module
// talks to api.js.
//
// - Cache: your last known profile, friends and games are kept per account in localStorage,
//   so the app opens instantly.
// - Optimistic writes: every change is applied locally at once and put in an outbox
//   (one entry per game id, always holding the latest version of that game).
// - The outbox is flushed in order; adds are idempotent on the server, so retries are safe.
//   When offline, entries simply wait and are sent when the connection returns.
// - Fetches re-apply anything still in the outbox, so a poll never "undoes" a pending change.
import { uuid, sha256 } from './crypto.js';
import * as api from './api.js';
import { sportOf } from './stats.js';
import { CONFIG } from '../config.js';

// Keys are namespaced by backend, so demo data never mixes with the real Sheet.
const NS = api.isFirebase ? 'firebase' : api.isDemo ? 'demo' : CONFIG.APPS_SCRIPT_URL.split('/s/')[1]?.slice(0, 16) || 'remote';
const K = {
  session: `h2h.session.v3.${NS}`,
  accounts: `h2h.accounts.v3.${NS}`,
  prefs: `h2h.prefs.v3.${NS}`,
  cache: (userId) => `h2h.cache.v3.${NS}.${userId}`,
  outbox: (userId) => `h2h.outbox.v3.${NS}.${userId}`,
};
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// Moving from the Sheet to Firebase (same user ids): bring this phone's saved accounts, app lock,
// cached games and unsent new games across once. The old session isn't copied: everyone signs in
// once with their PIN. Edits/deletes still queued for the Sheet are dropped (they now need approval).
(function carryOverFromSheet() {
  if (!api.isFirebase || !CONFIG.APPS_SCRIPT_URL) return;
  const done = `h2h.carried.v3.${NS}`;
  if (localStorage.getItem(done)) return;
  const OLD = CONFIG.APPS_SCRIPT_URL.split('/s/')[1]?.slice(0, 16) || 'remote';
  try {
    for (const name of ['accounts', 'prefs']) {
      const from = `h2h.${name}.v3.${OLD}`;
      if (localStorage.getItem(from) != null && localStorage.getItem(K[name]) == null) localStorage.setItem(K[name], localStorage.getItem(from));
    }
    for (const key of Object.keys(localStorage)) {
      const kind = ['cache', 'outbox'].find((k) => key.startsWith(`h2h.${k}.v3.${OLD}.`));
      if (!kind) continue;
      const to = K[kind](key.slice(`h2h.${kind}.v3.${OLD}.`.length));
      if (localStorage.getItem(to) != null) continue;
      if (kind === 'cache') localStorage.setItem(to, localStorage.getItem(key));
      else write(to, read(key, []).filter((op) => op.isNew));
    }
  } catch {
    /* storage full or blocked: the app still works, just without the carried-over data */
  }
  localStorage.setItem(done, '1');
})();

export const state = {
  session: read(K.session, null), // { token, userId }
  me: null,
  friends: [],
  rivalId: null,
  serverGames: [],
  games: [], // server games with the outbox applied (non-deleted only)
  loaded: false,
  lastSynced: null,
  status: 'idle', // 'idle' | 'syncing' | 'offline' | 'error'
  error: null,
  mode: '2k', // '2k' | 'fifa': which game's stats the app shows (see decideMode)
  requests: [], // edit/delete requests to or from you (see requestEdit / respondRequest)
};
let outbox = [];

// ---------- names ----------

/** "omer" → "Omer": first letter of each word capitalised, so names look tidy even if typed in lowercase. */
export const niceName = (name) => String(name || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)(\S)/g, (m, space, ch) => space + ch.toUpperCase());
const tidy = (u) => (u ? { ...u, display_name: niceName(u.display_name), initial: String(u.initial || niceName(u.display_name)[0] || '?').toUpperCase() } : u);

// ---------- events ----------

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (detail = {}) => listeners.forEach((fn) => fn(detail));

// ---------- per-account cache ----------

function loadAccount(userId) {
  const c = read(K.cache(userId), {});
  state.me = tidy(c.me || null);
  state.friends = (c.friends || []).map(tidy);
  state.rivalId = c.rivalId || null;
  state.serverGames = c.games || [];
  state.requests = c.requests || [];
  state.loaded = Array.isArray(c.games);
  state.lastSynced = c.lastSynced || null;
  outbox = read(K.outbox(userId), []);
  rebuild();
  modeDecided = false;
  decideMode();
  pickRival();
}

function persistCache() {
  if (!state.session) return;
  write(K.cache(state.session.userId), {
    me: state.me,
    friends: state.friends,
    rivalId: state.rivalId,
    games: state.serverGames,
    requests: state.requests,
    lastSynced: state.lastSynced,
  });
}
const persistOutbox = () => state.session && write(K.outbox(state.session.userId), outbox);

function rebuild() {
  const byId = new Map(state.serverGames.map((g) => [g.id, g]));
  for (const op of outbox) byId.set(op.id, { ...op.game, _pending: true });
  state.games = [...byId.values()].filter((g) => !g.deleted);
}


// ---------- game mode ----------

// The app opens on the sport of your most recent game, so if you last played FIFA it opens on
// FIFA. With no games yet it uses the last mode picked in Settings. Decided once per launch;
// switching in Settings takes over for the rest of the session.
let modeDecided = false;
function decideMode() {
  if (modeDecided) return;
  const me = state.session?.userId;
  const mine = state.games.filter((g) => g.player1_id === me || g.player2_id === me);
  const latest = mine.sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)))[0];
  state.mode = latest ? sportOf(latest) : getPrefs().mode === 'fifa' ? 'fifa' : '2k';
  modeDecided = Boolean(latest) || state.loaded;
}

export function setMode(mode) {
  const next = mode === 'fifa' ? 'fifa' : '2k';
  modeDecided = true;
  setPrefs({ mode: next });
  if (state.mode === next) return;
  state.mode = next;
  emit({ mode: true });
}

// ---------- selectors ----------

export const pendingCount = () => outbox.length;
/** The Dashboard's "rival" can be "Everyone": your stats against all your friends together. */
export const EVERYONE = '*';
const EVERYONE_RIVAL = { id: EVERYONE, display_name: 'Everyone', everyone: true };
export const isEveryone = () => state.rivalId === EVERYONE && state.friends.length > 0;
export const rival = () => (isEveryone() ? EVERYONE_RIVAL : state.friends.find((f) => f.id === state.rivalId) || null);
const opponentOf = (g, me) => (g.player1_id === me ? g.player2_id : g.player1_id);

/** Games between you and one friend (defaults to the current rival; EVERYONE = all of them) in the current game mode. */
export function pairGames(friendId = state.rivalId) {
  const me = state.session?.userId;
  return state.games.filter(
    (g) => sportOf(g) === state.mode && (g.player1_id === me || g.player2_id === me) && (friendId === EVERYONE || opponentOf(g, me) === friendId),
  );
}

/** The friend you played most recently in the current game mode (the default opponent from "Everyone"). */
export function lastOpponent() {
  const me = state.session?.userId;
  const ids = state.friends.map((f) => f.id);
  const latest = state.games
    .filter((g) => sportOf(g) === state.mode && ids.includes(opponentOf(g, me)))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)))[0];
  return latest ? opponentOf(latest, me) : ids[0] || null;
}

/** Keeps the rival valid: last choice → most recently played friend → first friend. */
function pickRival() {
  const ids = state.friends.map((f) => f.id);
  if (ids.includes(state.rivalId) || (state.rivalId === EVERYONE && ids.length)) return;
  const me = state.session?.userId;
  const latest = state.games
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)))
    .find((g) => ids.includes(opponentOf(g, me)));
  state.rivalId = latest ? opponentOf(latest, me) : ids[0] || null;
}

export function setRival(friendId) {
  if (state.rivalId === friendId) return;
  state.rivalId = friendId;
  persistCache();
  emit({ rival: true });
}

function setStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  emit({ status: true });
}


// ---------- prefs (per device) ----------

export const getPrefs = () => ({ requirePin: false, pinHash: null, ...read(K.prefs, {}) });
export function setPrefs(patch) {
  write(K.prefs, { ...getPrefs(), ...patch });
  emit({ prefs: true });
}

// ---------- accounts & auth ----------

/** Accounts that have signed in on this device, most recent first (for "Continue as …"). */
export const deviceAccounts = () => read(K.accounts, []).map(tidy);
function rememberAccount(user) {
  const list = deviceAccounts().filter((a) => a.id !== user.id);
  write(K.accounts, [user, ...list].slice(0, 4));
}
export function forgetAccount(userId) {
  write(K.accounts, deviceAccounts().filter((a) => a.id !== userId));
}

async function startSession({ token, user, friends, games, requests = [] }, pin) {
  state.session = { token, userId: user.id };
  write(K.session, state.session);
  loadAccount(user.id);
  state.me = tidy(user);
  rememberAccount(state.me);
  // Sign-in already brought your friends and games, so the dashboard shows at once with no second
  // round trip. (Older servers don't send them; then the sync below fetches them.)
  const haveData = Array.isArray(friends) && Array.isArray(games);
  if (haveData) {
    Object.assign(state, { friends: friends.map(tidy), serverGames: games, requests, lastSynced: now(), loaded: true });
    rebuild();
    decideMode();
    pickRival();
  }
  // Local hash so "Require PIN on open" works offline. It's tied to this session's token.
  setPrefs({ pinHash: await sha256(`${token}:${pin}`) });
  persistCache();
  emit({ session: true });
  if (!haveData || outbox.length) sync();
}

export async function signIn(username, pin) {
  await startSession(await api.signIn(username, pin), pin);
}

export async function signUp(username, displayName, pin) {
  let result;
  try {
    result = await api.signUp(username, displayName, pin);
  } catch (err) {
    if (err.code !== 'timeout') throw err;
    // Google didn't answer, but the account may have been created anyway. Signing in tells us;
    // if it wasn't, try creating it once more.
    try {
      result = await api.signIn(username, pin);
    } catch (e) {
      if (e.code !== 'auth') throw e;
      result = await api.signUp(username, displayName, pin);
    }
  }
  await startSession(result, pin);
}

export async function verifyLocalPin(pin) {
  const { pinHash } = getPrefs();
  return Boolean(state.session && pinHash && pinHash === (await sha256(`${state.session.token}:${pin}`)));
}

/** `local`: the server already ended the session (e.g. the account was deleted), so don't call it. */
export function signOut({ expired = false, local = false, deleted = false } = {}) {
  if (state.session && !expired && !local) api.signOut(state.session.token).catch(() => {});
  state.session = null;
  Object.assign(state, { me: null, friends: [], rivalId: null, serverGames: [], games: [], requests: [], loaded: false, lastSynced: null, status: 'idle', error: null });
  outbox = [];
  localStorage.removeItem(K.session);
  setPrefs({ pinHash: null });
  emit({ session: true, expired, deleted });
}

/** Change name, username and/or avatar. Needs a connection. */
export async function updateProfile(patch) {
  const user = tidy(await api.updateProfile(state.session.token, patch));
  const oldId = state.me?.id;
  state.me = user;
  if (oldId) forgetAccount(oldId);
  rememberAccount(user);
  persistCache();
  emit({ profile: true });
  return user;
}

/** Change PIN. Other devices are signed out; this one gets a fresh session token. */
export async function changePin(currentPin, newPin) {
  const { token } = await api.changePin(state.session.token, currentPin, newPin);
  state.session = { ...state.session, token };
  write(K.session, state.session);
  setPrefs({ pinHash: await sha256(`${token}:${newPin}`) });
}

// ---------- friends ----------

export const searchUsers = async (query) => (await api.searchUsers(state.session.token, query)).map(tidy);

/** Instant add. Needs a connection. Makes the new friend the current rival. */
export async function addFriend(userId) {
  const friend = tidy(await api.addFriend(state.session.token, userId));
  if (!state.friends.some((f) => f.id === friend.id)) state.friends = [...state.friends, friend];
  state.rivalId = friend.id;
  persistCache();
  emit({ friends: true, rival: true });
  return friend;
}

function dropFriend(userId) {
  state.friends = state.friends.filter((f) => f.id !== userId);
  if (state.rivalId === userId) state.rivalId = null;
  pickRival();
  persistCache();
  emit({ friends: true, rival: true });
}

/** Ends the friendship on both sides. Games are kept (they come back if you re-add each other). */
export async function removeFriend(userId) {
  await api.removeFriend(state.session.token, userId);
  dropFriend(userId);
}

/** Removes the friendship and stops them from finding or adding you. */
export async function blockUser(userId) {
  await api.blockUser(state.session.token, userId);
  dropFriend(userId);
}

export const unblockUser = (userId) => api.unblockUser(state.session.token, userId);
export const getBlocked = async () => (await api.getBlocked(state.session.token)).map(tidy);

/** A friend's (or your own) profile. Needs a connection; the last result per user is kept in memory. */
const profiles = new Map();
export const cachedProfile = (userId) => profiles.get(userId) || null;
export async function getProfile(userId) {
  const raw = await api.getProfile(state.session.token, userId);
  const p = { ...raw, user: tidy(raw.user), opponents: raw.opponents.map(tidy) };
  profiles.set(userId, p);
  return p;
}

// ---------- change requests ----------
// A saved game can only be edited or deleted with the other player's OK. These need a connection.

/** True for a game you logged that hasn't reached the Sheet yet: you can still change it freely. */
export const isLocalOnly = (id) => outbox.some((op) => op.id === id && op.isNew);

/** The open request for a game, if any. */
export const pendingRequestFor = (gameId) => state.requests.find((r) => r.game_id === gameId && r.status === 'pending') || null;

async function afterRequest(promise) {
  const result = await promise;
  await sync(); // pull the new request list (and the changed game, when approved)
  return result;
}
export const requestEdit = (game) => afterRequest(api.requestChange(state.session.token, { kind: 'edit', game }));
export const requestDelete = (id) => afterRequest(api.requestChange(state.session.token, { kind: 'delete', id }));
export const respondRequest = (requestId, approve) => afterRequest(api.respondRequest(state.session.token, requestId, approve));
export const cancelRequest = (requestId) => afterRequest(api.cancelRequest(state.session.token, requestId));

/** Notifications: requests waiting on you, plus answers to your requests you haven't seen yet. */
export function notifications() {
  const me = state.session?.userId;
  const seen = (getPrefs().notificationsSeen || {})[me] || ''; // per account: several can share a phone
  const incoming = state.requests.filter((r) => r.to_id === me && r.status === 'pending');
  const outgoing = state.requests.filter((r) => r.from_id === me && r.status === 'pending');
  const answered = state.requests
    .filter((r) => r.from_id === me && (r.status === 'approved' || r.status === 'declined'))
    .sort((a, b) => b.resolved_at.localeCompare(a.resolved_at));
  const unseenAnswers = answered.filter((r) => r.resolved_at > seen).length;
  return { incoming, outgoing, answered, badge: incoming.length + unseenAnswers };
}
export function markNotificationsSeen() {
  const seen = getPrefs().notificationsSeen;
  setPrefs({ notificationsSeen: { ...(seen && typeof seen === 'object' ? seen : {}), [state.session.userId]: now() } });
}

// ---------- delete account ----------

export const verifyPin = (pin) => api.verifyPin(state.session.token, pin);

export async function deleteAccount(pin) {
  try {
    await api.deleteAccount(state.session.token, pin);
  } catch (err) {
    // A retry after the delete already went through finds the session gone: that's success
    if (err.code !== 'auth') throw err;
  }
  const id = state.session.userId;
  forgetAccount(id);
  localStorage.removeItem(K.cache(id));
  localStorage.removeItem(K.outbox(id));
  signOut({ local: true, deleted: true }); // the server already ended every session
}

// ---------- writes (optimistic) ----------

function queue(game, { isNew = false } = {}) {
  const existing = outbox.find((op) => op.id === game.id);
  if (existing) existing.game = game;
  else outbox.push({ id: game.id, game, isNew });
  persistOutbox();
  rebuild();
}

const now = () => new Date().toISOString();

/** `game` is neutral (player1/player2). Returns the stored game. */
export function addGame(game) {
  const stamp = now();
  const full = { sport: state.mode, ...game, id: uuid(), created_by: state.session.userId, created_at: stamp, updated_at: stamp, deleted: false };
  queue(full, { isNew: true });
  emit({ added: full.id });
  sync();
  return full;
}

export function updateGame(game) {
  const current = state.games.find((g) => g.id === game.id);
  const { _pending, ...clean } = { ...current, ...game, updated_at: now() };
  queue(clean);
  emit({ updated: game.id });
  sync();
}

/** Soft delete. Returns the game so the caller can offer Undo. */
export function deleteGame(id) {
  const current = state.games.find((g) => g.id === id);
  if (!current) return null;
  const { _pending, ...clean } = current;
  queue({ ...clean, deleted: true, updated_at: now() });
  emit({ deleted: id });
  sync();
  return clean;
}

export function restoreGame(game) {
  queue({ ...game, deleted: false, updated_at: now() });
  emit({ added: game.id });
  sync();
}

// ---------- sync ----------

async function flush() {
  while (outbox.length) {
    const op = outbox[0];
    const { game } = op;
    const { token } = state.session;
    try {
      if (op.isNew && game.deleted) {
        /* created and deleted before it ever reached the server: nothing to send */
      } else if (op.isNew) await api.addGame(token, game);
      else if (game.deleted) await api.deleteGame(token, game.id);
      else await api.updateGame(token, game);
    } catch (err) {
      if (err.code !== 'invalid') throw err;
      // The server rejected it (e.g. changed on the other phone). Drop the change and let the
      // next fetch restore the server's version.
      emit({ rejected: err.message });
    }
    if (op.game === game) outbox.shift();
    else op.isNew = false; // edited while sending: it exists now, resend as an update
    persistOutbox();
  }
}

let running = null;
let again = false;

/** Sends queued changes, then fetches the latest profile, friends and games. Safe to call often. */
export function sync() {
  if (!state.session) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again && state.session);
  })().finally(() => (running = null));
  return running;
}

/** Profile, friends and games in one request. Falls back to three if the server predates bootstrap. */
let oldServer = false;
async function fetchAll(token) {
  if (!oldServer) {
    try {
      return await api.bootstrap(token);
    } catch (err) {
      if (!(err.code === 'invalid' && /Unknown action/.test(err.message))) throw err;
      oldServer = true;
    }
  }
  const [me, friends, games] = await Promise.all([api.getMe(token), api.getFriends(token), api.getGames(token)]);
  return { me, friends, games, requests: [] };
}

async function syncOnce() {
  const session = state.session;
  setStatus('syncing');
  try {
    const hadPending = outbox.length > 0;
    await flush();
    const { me, friends, games, requests = [] } = await fetchAll(session.token);
    if (state.session !== session) return; // signed out while this was in flight
    Object.assign(state, { me: tidy(me), friends: friends.map(tidy), serverGames: games, requests, lastSynced: now(), loaded: true });
    rememberAccount(me);
    rebuild();
    decideMode();
    pickRival();
    persistCache();
    setStatus('idle');
    emit({ synced: true, saved: hadPending });
  } catch (err) {
    if (state.session !== session) return;
    if (err.code === 'auth') {
      signOut({ expired: true });
      setStatus('idle');
    } else if (err.code === 'network') setStatus('offline', err.message);
    // Google was slow on a routine refresh: keep showing what we have; the next poll tries again.
    // Only flag it when there are changes waiting to be saved.
    else if (err.code === 'timeout' && !outbox.length) setStatus('idle');
    else setStatus('error', err.message);
  }
}

let timer = null;
/** Refresh on open, on focus, when the connection returns, and every POLL_SECONDS while visible. */
export function startAutoSync() {
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === 'visible' && sync(), CONFIG.POLL_SECONDS * 1000);
  syncIfStale();
}

/** Sync unless we got fresh data in the last 10 seconds (e.g. from signing in) and nothing is waiting to save. */
function syncIfStale() {
  if (!state.lastSynced || Date.now() - Date.parse(state.lastSynced) > 10000 || outbox.length) sync();
}
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncIfStale());

// Last, so everything above (prefs, game mode) is defined before the cached account loads
if (state.session) loadAccount(state.session.userId);
