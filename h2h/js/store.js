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
import { CONFIG } from '../config.js';

// Keys are namespaced by backend, so demo data never mixes with the real Sheet.
const NS = api.isDemo ? 'demo' : CONFIG.APPS_SCRIPT_URL.split('/s/')[1]?.slice(0, 16) || 'remote';
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
  state.loaded = Array.isArray(c.games);
  state.lastSynced = c.lastSynced || null;
  outbox = read(K.outbox(userId), []);
  rebuild();
  pickRival();
}

function persistCache() {
  if (!state.session) return;
  write(K.cache(state.session.userId), {
    me: state.me,
    friends: state.friends,
    rivalId: state.rivalId,
    games: state.serverGames,
    lastSynced: state.lastSynced,
  });
}
const persistOutbox = () => state.session && write(K.outbox(state.session.userId), outbox);

function rebuild() {
  const byId = new Map(state.serverGames.map((g) => [g.id, g]));
  for (const op of outbox) byId.set(op.id, { ...op.game, _pending: true });
  state.games = [...byId.values()].filter((g) => !g.deleted);
}

if (state.session) loadAccount(state.session.userId);

// ---------- selectors ----------

export const pendingCount = () => outbox.length;
export const rival = () => state.friends.find((f) => f.id === state.rivalId) || null;
const opponentOf = (g, me) => (g.player1_id === me ? g.player2_id : g.player1_id);

/** Games between you and one friend (defaults to the current rival). */
export function pairGames(friendId = state.rivalId) {
  const me = state.session?.userId;
  return state.games.filter((g) => (g.player1_id === me || g.player2_id === me) && opponentOf(g, me) === friendId);
}

/** Keeps the rival valid: last choice → most recently played friend → first friend. */
function pickRival() {
  const ids = state.friends.map((f) => f.id);
  if (ids.includes(state.rivalId)) return;
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

async function startSession({ token, user }, pin) {
  state.session = { token, userId: user.id };
  write(K.session, state.session);
  loadAccount(user.id);
  state.me = tidy(user);
  rememberAccount(state.me);
  // Local hash so "Require PIN on open" works offline. It's tied to this session's token.
  setPrefs({ pinHash: await sha256(`${token}:${pin}`) });
  persistCache();
  emit({ session: true });
  sync();
}

export async function signIn(username, pin) {
  await startSession(await api.signIn(username, pin), pin);
}

export async function signUp(username, displayName, pin) {
  await startSession(await api.signUp(username, displayName, pin), pin);
}

export async function verifyLocalPin(pin) {
  const { pinHash } = getPrefs();
  return Boolean(state.session && pinHash && pinHash === (await sha256(`${state.session.token}:${pin}`)));
}

export function signOut({ expired = false } = {}) {
  if (state.session && !expired) api.signOut(state.session.token).catch(() => {});
  state.session = null;
  Object.assign(state, { me: null, friends: [], rivalId: null, serverGames: [], games: [], loaded: false, lastSynced: null, status: 'idle', error: null });
  outbox = [];
  localStorage.removeItem(K.session);
  setPrefs({ pinHash: null });
  emit({ session: true, expired });
}

/** Change name and/or username. Needs a connection. */
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
  const full = { ...game, id: uuid(), created_by: state.session.userId, created_at: stamp, updated_at: stamp, deleted: false };
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

async function syncOnce() {
  const session = state.session;
  setStatus('syncing');
  try {
    const hadPending = outbox.length > 0;
    await flush();
    const [me, friends, games] = await Promise.all([api.getMe(session.token), api.getFriends(session.token), api.getGames(session.token)]);
    if (state.session !== session) return; // signed out while this was in flight
    Object.assign(state, { me: tidy(me), friends: friends.map(tidy), serverGames: games, lastSynced: now(), loaded: true });
    rememberAccount(me);
    rebuild();
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
    else setStatus('error', err.message);
  }
}

let timer = null;
/** Refresh on open, on focus, when the connection returns, and every POLL_SECONDS while visible. */
export function startAutoSync() {
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === 'visible' && sync(), CONFIG.POLL_SECONDS * 1000);
  sync();
}
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
