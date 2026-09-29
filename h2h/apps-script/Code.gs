/**
 * H2H — Google Apps Script backend
 * ================================
 * Turns a Google Sheet into a tiny API for the H2H web app. Setup steps are in SETUP.md.
 *
 * Tabs
 *   Users:       id, username, display_name, pin_hash, color, initial, created_at
 *   Friendships: id, user_a, user_b, created_at
 *   Games:       id, date, player1_id, player2_id, player1_score, player2_score, player1_team,
 *                player2_team, overtime, note, created_by, created_at, updated_at, deleted
 *
 * API (every response is JSON: { ok: true, data } or { ok: false, error, code })
 *   GET  ?action=me&token=...                  -> your user
 *   GET  ?action=friends&token=...             -> your friends
 *   GET  ?action=search&token=...&q=...        -> users matching a name or username
 *   GET  ?action=games&token=...               -> every non-deleted game you played in
 *   POST { action: 'signUp', username, displayName, pin }  -> { token, user }
 *   POST { action: 'signIn', username, pin }               -> { token, user }
 *   POST { action: 'signOut', token }                      -> {}
 *   POST { action: 'addFriend', token, userId }            -> friend (instant; safe to repeat)
 *   POST { action: 'addGame', token, game }                -> game (idempotent by id: safe to retry)
 *   POST { action: 'updateGame', token, game }             -> game (also un-deletes)
 *   POST { action: 'deleteGame', token, id }               -> { id } (soft delete: deleted = TRUE)
 *
 * Security model (lightweight, for friends):
 *   - PINs are stored only as SHA-256(salt : userId : pin). The salt lives in Script Properties.
 *   - 5 wrong PINs lock that username for 5 minutes (enforced here, on the server).
 *   - Signing in returns a random session token; every read and write requires it.
 *   - You can only log, edit or delete games between yourself and one of your friends.
 *   - Writes run inside LockService so two phones saving at once can't collide.
 *
 * After ANY edit to this file: Deploy → Manage deployments → Edit → Version: New version → Deploy.
 * Saving alone does not update the live web app.
 */

const SHEETS = {
  Users: ['id', 'username', 'display_name', 'pin_hash', 'color', 'initial', 'created_at'],
  Friendships: ['id', 'user_a', 'user_b', 'created_at'],
  Games: ['id', 'date', 'player1_id', 'player2_id', 'player1_score', 'player2_score', 'player1_team', 'player2_team', 'overtime', 'note', 'created_by', 'created_at', 'updated_at', 'deleted'],
};
const TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS'];
// Avatar colours: all dark enough for a white initial (WCAG AA)
const AVATAR_COLORS = ['#5856D6', '#C93400', '#007A5E', '#A2338A', '#0060C7', '#8A5A00', '#B0263A', '#3D6591'];

const MAX_TRIES = 5;
const LOCK_MINUTES = 5;
const SESSION_DAYS = 180;

/* =====================================================================
 * ONE-TIME HELPERS: pick one in the editor's function dropdown and click Run
 * ===================================================================== */

/** Creates the Users, Friendships and Games tabs with the right headers. Safe to run again. */
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(SHEETS[name]);
    sheet.getRange(1, 1, sheet.getMaxRows(), SHEETS[name].length).setNumberFormat('@'); // plain text: never reformat dates/IDs
    sheet.setFrozenRows(1);
  });
  Logger.log('Done. Deploy the web app, then create accounts from the app itself.');
}

/**
 * Forgot a PIN? Type the username and a new 4-digit PIN below, click Run, then clear both
 * and save. This also signs that person out on every device.
 */
function resetPin() {
  const USERNAME = '';
  const NEW_PIN = '';
  if (!USERNAME || !NEW_PIN) throw new Error('Fill in USERNAME and NEW_PIN first.');
  if (!/^\d{4}$/.test(NEW_PIN)) throw new Error('The PIN must be exactly 4 digits.');
  const found = findUserByUsername_(USERNAME);
  if (!found) throw new Error('No user named ' + USERNAME + '.');
  const sheet = sheet_('Users');
  sheet.getRange(found.row, colIndex_(sheet, 'pin_hash')).setValue(hash_(found.user.id, NEW_PIN));
  endSessionsFor_(found.user.id);
  PropertiesService.getScriptProperties().deleteProperty('fails:' + found.user.username);
  Logger.log('PIN reset for @' + found.user.username + '.');
}

/** Unlocks every username right away after too many wrong PINs, instead of waiting 5 minutes. */
function clearLockouts() {
  deleteProps_('fails:');
  Logger.log('Lockouts cleared.');
}

/** Signs everyone out on every device (they'll need their PIN again). */
function signOutEverywhere() {
  deleteProps_('session:');
  Logger.log('All sessions ended.');
}

/* =====================================================================
 * HTTP ENTRY POINTS
 * ===================================================================== */

function doGet(e) {
  return respond_(function () {
    const p = (e && e.parameter) || {};
    const me = requireSession_(p.token);
    switch (p.action) {
      case 'me': return publicUser_(me);
      case 'friends': return listFriends_(me.id);
      case 'search': return searchUsers_(me.id, p.q);
      case 'games': return listGames_(me.id);
      default: throw apiError_('Unknown action.', 'invalid');
    }
  });
}

function doPost(e) {
  return respond_(function () {
    // The app sends Content-Type text/plain (avoids a CORS preflight), so parse the raw body.
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'signUp': return signUp_(body.username, body.displayName, body.pin);
      case 'signIn': return signIn_(body.username, body.pin);
      case 'signOut': return signOut_(body.token);
      case 'addFriend': return addFriend_(requireSession_(body.token), body.userId);
      case 'addGame': return addGame_(requireSession_(body.token), body.game);
      case 'updateGame': return updateGame_(requireSession_(body.token), body.game);
      case 'deleteGame': return deleteGame_(requireSession_(body.token), body.id);
      default: throw apiError_('Unknown action.', 'invalid');
    }
  });
}

/* =====================================================================
 * ACCOUNTS & SESSIONS
 * ===================================================================== */

function signUp_(username, displayName, pin) {
  const name = String(username || '').trim().toLowerCase();
  const display = String(displayName || '').trim().replace(/\s+/g, ' ');
  if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw apiError_('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
  if (!display || display.length > 24) throw apiError_('Enter a name up to 24 characters.', 'invalid');
  if (!/^\d{4}$/.test(String(pin))) throw apiError_('Your PIN must be 4 digits.', 'invalid');

  return withLock_(function () {
    if (findUserByUsername_(name)) throw apiError_('That username is taken.', 'taken');
    const id = 'u_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    const user = {
      id: id,
      username: name,
      display_name: display,
      pin_hash: hash_(id, String(pin)),
      color: AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length],
      initial: display.charAt(0).toUpperCase(),
      created_at: new Date().toISOString(),
    };
    appendRow_(sheet_('Users'), user);
    return { token: newSession_(id), user: publicUser_(user) };
  });
}

function signIn_(username, pin) {
  const name = String(username || '').trim().toLowerCase();
  return withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const key = 'fails:' + name;
    const fails = JSON.parse(props.getProperty(key) || '{"count":0,"lockedUntil":0}');
    if (fails.lockedUntil > Date.now()) {
      throw apiError_('Too many attempts.', 'locked', { retryAfter: Math.ceil((fails.lockedUntil - Date.now()) / 1000) });
    }
    const found = findUserByUsername_(name);
    // Same answer for "no such user" and "wrong PIN", so usernames can't be probed here
    if (!found || !/^\d{4}$/.test(String(pin)) || hash_(found.user.id, String(pin)) !== found.user.pin_hash) {
      fails.count += 1;
      if (fails.count >= MAX_TRIES) {
        props.setProperty(key, JSON.stringify({ count: 0, lockedUntil: Date.now() + LOCK_MINUTES * 60000 }));
        throw apiError_('Too many attempts.', 'locked', { retryAfter: LOCK_MINUTES * 60 });
      }
      props.setProperty(key, JSON.stringify(fails));
      throw apiError_('Wrong username or PIN.', 'auth', { triesLeft: MAX_TRIES - fails.count });
    }
    props.deleteProperty(key);
    pruneSessions_();
    return { token: newSession_(found.user.id), user: publicUser_(found.user) };
  });
}

function signOut_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('session:' + token);
  return {};
}

function newSession_(userId) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('session:' + token, JSON.stringify({ userId: userId, expires: Date.now() + SESSION_DAYS * 86400000 }));
  return token;
}

/** Returns the signed-in user (full row), or throws an 'auth' error. */
function requireSession_(token) {
  const props = PropertiesService.getScriptProperties();
  const raw = token && props.getProperty('session:' + token);
  const session = raw && JSON.parse(raw);
  if (!session || session.expires < Date.now()) {
    if (raw) props.deleteProperty('session:' + token);
    throw apiError_('Your session has ended. Sign in again.', 'auth');
  }
  const user = readObjects_(sheet_('Users')).find(function (u) { return u.id === session.userId; });
  if (!user) throw apiError_('This account no longer exists.', 'auth');
  return user;
}

function endSessionsFor_(userId) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session:') === 0 && JSON.parse(all[k]).userId === userId) props.deleteProperty(k);
  });
}

function pruneSessions_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session:') === 0 && JSON.parse(all[k]).expires < Date.now()) props.deleteProperty(k);
  });
}

/** SHA-256 of salt:userId:pin, as hex. The salt is created once and kept in Script Properties. */
function hash_(userId, pin) {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('PIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PIN_SALT', salt);
  }
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + userId + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* =====================================================================
 * USERS & FRIENDS
 * ===================================================================== */

function publicUser_(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, color: u.color || '#5856D6', initial: u.initial || String(u.display_name || '?').charAt(0).toUpperCase() };
}

function findUserByUsername_(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) return null;
  const rows = readRows_(sheet_('Users'));
  const hit = rows.find(function (r) { return String(r.data.username).toLowerCase() === name; });
  return hit ? { row: hit.row, user: hit.data } : null;
}

function friendIds_(userId) {
  return readObjects_(sheet_('Friendships'))
    .filter(function (f) { return f.user_a === userId || f.user_b === userId; })
    .map(function (f) { return f.user_a === userId ? f.user_b : f.user_a; });
}

function listFriends_(userId) {
  const ids = friendIds_(userId);
  return readObjects_(sheet_('Users'))
    .filter(function (u) { return ids.indexOf(u.id) !== -1; })
    .map(publicUser_);
}

function searchUsers_(userId, query) {
  const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2) return [];
  const friends = friendIds_(userId);
  return readObjects_(sheet_('Users'))
    .filter(function (u) {
      return u.id !== userId && (String(u.username).toLowerCase().indexOf(q) !== -1 || String(u.display_name).toLowerCase().indexOf(q) !== -1);
    })
    .slice(0, 20)
    .map(function (u) { return Object.assign(publicUser_(u), { isFriend: friends.indexOf(u.id) !== -1 }); });
}

function addFriend_(me, userId) {
  if (!userId || userId === me.id) throw apiError_('Pick someone else to add.', 'invalid');
  const other = readObjects_(sheet_('Users')).find(function (u) { return u.id === userId; });
  if (!other) throw apiError_('That user no longer exists.', 'invalid');
  return withLock_(function () {
    if (friendIds_(me.id).indexOf(userId) === -1) {
      const pair = [me.id, userId].sort();
      appendRow_(sheet_('Friendships'), { id: Utilities.getUuid(), user_a: pair[0], user_b: pair[1], created_at: new Date().toISOString() });
    }
    return publicUser_(other);
  });
}

/* =====================================================================
 * GAMES
 * ===================================================================== */

function listGames_(userId) {
  return readObjects_(sheet_('Games'))
    .map(normalizeGame_)
    .filter(function (g) { return g.id && !g.deleted && (g.player1_id === userId || g.player2_id === userId); });
}

function addGame_(me, game) {
  return withLock_(function () {
    const clean = cleanGame_(game, me);
    const sheet = sheet_('Games');
    const existing = findGameRow_(sheet, clean.id);
    const now = new Date().toISOString();
    if (existing) {
      // A retry of an add that already landed (e.g. the response was lost). Treat as an update.
      const prev = normalizeGame_(existing.data);
      assertPlayedIn_(prev, me);
      return writeRow_(sheet, existing.row, Object.assign(clean, { created_by: prev.created_by, created_at: prev.created_at, updated_at: now, deleted: false }));
    }
    return writeRow_(sheet, sheet.getLastRow() + 1, Object.assign(clean, { created_by: me.id, created_at: now, updated_at: now, deleted: false }));
  });
}

function updateGame_(me, game) {
  return withLock_(function () {
    const clean = cleanGame_(game, me);
    const sheet = sheet_('Games');
    const existing = findGameRow_(sheet, clean.id);
    if (!existing) throw apiError_('That game no longer exists.', 'invalid');
    const prev = normalizeGame_(existing.data);
    assertPlayedIn_(prev, me);
    const samePair = [prev.player1_id, prev.player2_id].sort().join() === [clean.player1_id, clean.player2_id].sort().join();
    if (!samePair) throw apiError_('A game can’t be moved to different players.', 'invalid');
    return writeRow_(sheet, existing.row, Object.assign(clean, {
      created_by: prev.created_by,
      created_at: prev.created_at,
      updated_at: new Date().toISOString(),
      deleted: game.deleted === true,
    }));
  });
}

function deleteGame_(me, id) {
  return withLock_(function () {
    const sheet = sheet_('Games');
    const existing = findGameRow_(sheet, id);
    if (existing) {
      const g = normalizeGame_(existing.data);
      assertPlayedIn_(g, me);
      writeRow_(sheet, existing.row, Object.assign(g, { deleted: true, updated_at: new Date().toISOString() }));
    }
    return { id: id };
  });
}

function assertPlayedIn_(game, me) {
  if (game.player1_id !== me.id && game.player2_id !== me.id) throw apiError_('You can only change your own games.', 'invalid');
}

/** Validates an incoming game: you plus one of your friends, a winner, real teams. */
function cleanGame_(g, me) {
  if (!g || typeof g !== 'object') throw apiError_('Missing game.', 'invalid');
  const id = String(g.id || '');
  if (!/^[\w-]{8,64}$/.test(id)) throw apiError_('Invalid game id.', 'invalid');
  const players = [g.player1_id, g.player2_id];
  const opponent = players[0] === me.id ? players[1] : players[1] === me.id ? players[0] : null;
  if (!opponent || opponent === me.id) throw apiError_('You can only log games you played in.', 'invalid');
  if (friendIds_(me.id).indexOf(opponent) === -1) throw apiError_('You can only log games against your friends.', 'invalid');
  const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
  if (![s1, s2].every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 999; })) throw apiError_('Enter both scores.', 'invalid');
  if (s1 === s2) throw apiError_('Basketball has no ties. Someone has to win.', 'invalid');
  const t1 = String(g.player1_team || '').toUpperCase(), t2 = String(g.player2_team || '').toUpperCase();
  if (TEAMS.indexOf(t1) === -1 || TEAMS.indexOf(t2) === -1) throw apiError_('Choose both teams.', 'invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(g.date || ''))) throw apiError_('Choose a date.', 'invalid');
  return {
    id: id,
    date: String(g.date),
    player1_id: players[0],
    player2_id: players[1],
    player1_score: s1,
    player2_score: s2,
    player1_team: t1,
    player2_team: t2,
    overtime: g.overtime === true,
    note: String(g.note || '').slice(0, 120),
  };
}

/** Sheet values → typed game (handles cells someone edited by hand). */
function normalizeGame_(r) {
  const bool = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
  const text = function (v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); };
  const date = r.date instanceof Date ? Utilities.formatDate(r.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(r.date || '');
  return {
    id: text(r.id),
    date: date,
    player1_id: text(r.player1_id),
    player2_id: text(r.player2_id),
    player1_score: Number(r.player1_score),
    player2_score: Number(r.player2_score),
    player1_team: text(r.player1_team),
    player2_team: text(r.player2_team),
    overtime: bool(r.overtime),
    note: text(r.note),
    created_by: text(r.created_by),
    created_at: text(r.created_at),
    updated_at: text(r.updated_at),
    deleted: bool(r.deleted),
  };
}

/* =====================================================================
 * SHEET HELPERS
 * ===================================================================== */

function sheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw apiError_('The "' + name + '" tab is missing. Run setupSheet in the script editor.', 'server');
  return sheet;
}

function colIndex_(sheet, name) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(name) + 1;
}

/** All rows as { row, data } keyed by the header row, so columns can be in any order. */
function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  return values.slice(1).map(function (v, i) {
    const data = {};
    headers.forEach(function (h, j) { data[h] = v[j]; });
    return { row: i + 2, data: data };
  }).filter(function (r) { return r.data.id !== '' && r.data.id != null; });
}

function readObjects_(sheet) {
  return readRows_(sheet).map(function (r) { return r.data; });
}

function findGameRow_(sheet, id) {
  if (!id || sheet.getLastRow() < 2) return null;
  const hit = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(hit.getRow(), 1, 1, headers.length).getValues()[0];
  const data = {};
  headers.forEach(function (h, j) { data[h] = values[j]; });
  return { row: hit.getRow(), data: data };
}

function writeRow_(sheet, rowNumber, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(function (h) {
    const v = obj[h];
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v == null ? '' : String(v);
  });
  sheet.getRange(rowNumber, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  return obj;
}

function appendRow_(sheet, obj) {
  return writeRow_(sheet, sheet.getLastRow() + 1, obj);
}

function deleteProps_(prefix) {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf(prefix) === 0) props.deleteProperty(k);
  });
}

/* =====================================================================
 * PLUMBING
 * ===================================================================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('The Sheet is busy. Try again in a moment.', 'server');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function apiError_(message, code, extra) {
  const e = new Error(message);
  e.apiCode = code;
  e.extra = extra || {};
  return e;
}

function respond_(fn) {
  let body;
  try {
    body = { ok: true, data: fn() };
  } catch (e) {
    if (e.apiCode) body = Object.assign({ ok: false, error: e.message, code: e.apiCode }, e.extra);
    else {
      console.error(e);
      body = { ok: false, error: 'Server error: ' + e.message, code: 'server' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
