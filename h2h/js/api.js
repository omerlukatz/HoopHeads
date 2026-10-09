// The only module that talks to the backend. Both backends expose the same interface:
//   signUp(username, displayName, pin)  -> { token, user, friends, games }
//   signIn(username, pin)               -> { token, user, friends, games }
//   signOut(token)                      -> {}
//   bootstrap(token)                    -> { me, friends, games } (one request; what sync uses)
//   getMe(token)                        -> user
//   getFriends(token)                   -> [user]
//   searchUsers(token, query)           -> [user & { isFriend }]
//   updateProfile(token, patch)         -> user    (patch: { username?, displayName?, avatar? })
//   changePin(token, currentPin, newPin) -> { token } (other devices are signed out)
//   addFriend(token, userId)            -> user (instant, safe to repeat)
//   removeFriend(token, userId)         -> {}      (games are kept)
//   blockUser(token, userId)            -> {}      (also removes the friendship)
//   unblockUser(token, userId)          -> {}
//   getBlocked(token)                   -> [user]
//   getProfile(token, userId)           -> { user, opponents: [user], games } (friends or yourself only)
//   getGames(token)                     -> [game]  (every non-deleted game you played in)
//   addGame(token, game)                -> game    (idempotent by id, safe to retry)
//   updateGame(token, game)             -> game    (also used to un-delete)
//   deleteGame(token, id)               -> { id }  (soft delete; saved games now go through requestChange)
//   requestChange(token, { kind, game?, id? }) -> request (edit/delete a saved game; the other player approves)
//   respondRequest(token, requestId, approve)  -> {}  (approving applies the change)
//   cancelRequest(token, requestId)     -> {}
//   verifyPin(token, pin)               -> {}      (wrong_pin / locked on failure)
//   deleteAccount(token, pin)           -> {}
// bootstrap and sign-in also return `requests`: open requests to or from you, plus recently answered ones.
// A user is { id, username, display_name, color, initial }.
// Failures throw ApiError with code: 'network' | 'timeout' | 'auth' | 'locked' | 'taken' | 'wrong_pin' | 'invalid' | 'server'.
// 'network' means this device is offline; 'timeout' means Google didn't answer in time (the Sheet
// is online but slow), which call() retries automatically first.
import { CONFIG } from '../config.js';
import * as demo from './demo.js';
import { createFirebaseBackend } from './firebase-backend.js';

export const isFirebase = CONFIG.BACKEND === 'firebase';
export const isDemo = !isFirebase && !CONFIG.APPS_SCRIPT_URL;

export class ApiError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const TIMEOUT_MS = 25000;
const RETRY_DELAYS = [700, 2000]; // ms before each retry

// Apps Script answers every request with a redirect to a googleusercontent.com page holding the
// result. When Google is slow, that page sometimes comes back as a 404 (an HTML page without CORS
// headers, so fetch just fails) or never arrives. Those are worth retrying; real answers aren't.
const isTransient = (err) => err.code === 'timeout';

async function attempt(method, params) {
  if (!navigator.onLine) throw new ApiError('You’re offline.', 'network');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    if (method === 'GET') {
      const url = new URL(CONFIG.APPS_SCRIPT_URL);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    } else {
      // text/plain keeps this a "simple" CORS request, so the browser skips the preflight
      // that Apps Script can't answer. Apps Script replies with a 302 to a googleusercontent.com
      // URL; fetch follows it (as a GET) and that response carries the JSON.
      res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(params),
        redirect: 'follow',
        signal: controller.signal,
      });
    }
  } catch {
    clearTimeout(timer);
    if (!navigator.onLine) throw new ApiError('You’re offline.', 'network');
    throw new ApiError('Google Sheets didn’t answer. Try again in a moment.', 'timeout');
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError('Google Sheets didn’t answer. Try again in a moment.', 'timeout');
  } finally {
    clearTimeout(timer);
  }
  if (!json.ok) throw new ApiError(json.error || 'Something went wrong.', json.code || 'server', json);
  return json.data;
}

/**
 * One request, retried when Google is slow: reads up to twice, actions (sign in, save a game…) once,
 * so you're never left waiting too long. `retry: false` for requests that aren't safe to repeat.
 */
async function call(method, params, { retry = true } = {}) {
  const retries = method === 'GET' ? RETRY_DELAYS.length : 1;
  for (let i = 0; ; i++) {
    try {
      return await attempt(method, params);
    } catch (err) {
      if (!retry || !isTransient(err) || i >= retries) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
    }
  }
}

const remote = {
  // Not retried here: if the first try reached the Sheet, a second would say "username taken".
  // store.signUp checks by signing in instead.
  signUp: (username, displayName, pin) => call('POST', { action: 'signUp', username, displayName, pin }, { retry: false }),
  signIn: (username, pin) => call('POST', { action: 'signIn', username, pin }),
  signOut: (token) => call('POST', { action: 'signOut', token }),
  bootstrap: (token) => call('GET', { action: 'bootstrap', token }),
  getMe: (token) => call('GET', { action: 'me', token }),
  getFriends: (token) => call('GET', { action: 'friends', token }),
  searchUsers: (token, q) => call('GET', { action: 'search', token, q }),
  updateProfile: (token, { username, displayName, avatar } = {}) => call('POST', { action: 'updateProfile', token, username, displayName, avatar }),
  changePin: (token, currentPin, newPin) => call('POST', { action: 'changePin', token, currentPin, newPin }, { retry: false }),
  addFriend: (token, userId) => call('POST', { action: 'addFriend', token, userId }),
  removeFriend: (token, userId) => call('POST', { action: 'removeFriend', token, userId }),
  blockUser: (token, userId) => call('POST', { action: 'blockUser', token, userId }),
  unblockUser: (token, userId) => call('POST', { action: 'unblockUser', token, userId }),
  getBlocked: (token) => call('GET', { action: 'blocked', token }),
  getProfile: (token, userId) => call('GET', { action: 'profile', token, userId }),
  getGames: (token) => call('GET', { action: 'games', token }),
  addGame: (token, game) => call('POST', { action: 'addGame', token, game }),
  updateGame: (token, game) => call('POST', { action: 'updateGame', token, game }),
  deleteGame: (token, id) => call('POST', { action: 'deleteGame', token, id }),
  requestChange: (token, { kind, game, id }) => call('POST', { action: 'requestChange', token, kind, game, id }),
  respondRequest: (token, requestId, approve) => call('POST', { action: 'respondRequest', token, requestId, approve }),
  cancelRequest: (token, requestId) => call('POST', { action: 'cancelRequest', token, requestId }),
  verifyPin: (token, pin) => call('POST', { action: 'verifyPin', token, pin }),
  deleteAccount: (token, pin) => call('POST', { action: 'deleteAccount', token, pin }),
};

const backend = isFirebase ? createFirebaseBackend(ApiError) : isDemo ? demo.createDemoBackend(ApiError) : remote;

/** Firebase pushes changes as they happen; the Sheet backend has no way to, so this does nothing there. */
export const onRemoteChange = backend.onRemoteChange || (() => () => {});

// Push notifications (Firebase only): pushStatus(userId) -> 'on' | 'off' | 'denied' | 'install' | 'unsupported'
export const pushStatus = backend.pushStatus || (() => 'unsupported');
export const enablePush = backend.enablePush || (async () => { throw new ApiError('Notifications aren’t available here.', 'invalid'); });
export const disablePush = backend.disablePush || (async () => ({}));
export const refreshPush = backend.refreshPush || (async () => {});

// PIN digits for a username (the admin has 8 on Firebase) and the admin console (Firebase only)
export const pinLength = backend.pinLength || (async () => 4);
const adminOnly = async () => {
  throw new ApiError('The admin console needs the Firebase version.', 'invalid');
};
export const [adminLoad, adminSaveGame, adminDeleteGame, adminSetFriends, adminHistory, adminResetPin, adminSuspend, adminAnnounce, adminAnnouncements, adminRemoveAnnouncement] = [
  'adminLoad', 'adminSaveGame', 'adminDeleteGame', 'adminSetFriends', 'adminHistory', 'adminResetPin', 'adminSuspend', 'adminAnnounce', 'adminAnnouncements', 'adminRemoveAnnouncement',
].map((name) => backend[name] || adminOnly);

export const { signUp, signIn, signOut, bootstrap, getMe, updateProfile, changePin, getFriends, searchUsers, addFriend, removeFriend, blockUser, unblockUser, getBlocked, getProfile, getGames, addGame, updateGame, deleteGame, requestChange, respondRequest, cancelRequest, verifyPin, deleteAccount } = backend;
export const demoControls = isDemo ? demo.controls : null;
