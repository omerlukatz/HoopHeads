// The only module that talks to the backend. Both backends expose the same interface:
//   signUp(username, displayName, pin)  -> { token, user }
//   signIn(username, pin)               -> { token, user }
//   signOut(token)                      -> {}
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
//   deleteGame(token, id)               -> { id }  (soft delete)
// A user is { id, username, display_name, color, initial }.
// Failures throw ApiError with code: 'network' | 'auth' | 'locked' | 'taken' | 'wrong_pin' | 'invalid' | 'server'.
import { CONFIG } from '../config.js';
import * as demo from './demo.js';

export const isDemo = !CONFIG.APPS_SCRIPT_URL;

export class ApiError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const TIMEOUT_MS = 20000;

async function call(method, params) {
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
    throw new ApiError('You’re offline or the Sheet can’t be reached.', 'network');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    // Usually a Google sign-in page: the deployment isn't set to "Anyone"
    throw new ApiError('The Sheet returned an unexpected response. Check the deployment settings in SETUP.md.', 'server');
  }
  if (!json.ok) throw new ApiError(json.error || 'Something went wrong.', json.code || 'server', json);
  return json.data;
}

const remote = {
  signUp: (username, displayName, pin) => call('POST', { action: 'signUp', username, displayName, pin }),
  signIn: (username, pin) => call('POST', { action: 'signIn', username, pin }),
  signOut: (token) => call('POST', { action: 'signOut', token }),
  getMe: (token) => call('GET', { action: 'me', token }),
  getFriends: (token) => call('GET', { action: 'friends', token }),
  searchUsers: (token, q) => call('GET', { action: 'search', token, q }),
  updateProfile: (token, { username, displayName, avatar } = {}) => call('POST', { action: 'updateProfile', token, username, displayName, avatar }),
  changePin: (token, currentPin, newPin) => call('POST', { action: 'changePin', token, currentPin, newPin }),
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
};

const backend = isDemo ? demo.createDemoBackend(ApiError) : remote;

export const { signUp, signIn, signOut, getMe, updateProfile, changePin, getFriends, searchUsers, addFriend, removeFriend, blockUser, unblockUser, getBlocked, getProfile, getGames, addGame, updateGame, deleteGame } = backend;
export const demoControls = isDemo ? demo.controls : null;
