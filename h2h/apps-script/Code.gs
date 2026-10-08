/**
 * H2H — Google Apps Script backend
 * ================================
 * Turns a Google Sheet into a tiny API for the H2H web app. Setup steps are in SETUP.md.
 *
 * Tabs
 *   Users:       id, username, display_name, pin_hash, color, initial, created_at
 *   Friendships: id, user_a, user_b, created_at
 *   Blocks:      id, blocker, blocked, created_at
 *   Requests:    id, game_id, from_id, to_id, kind (edit/delete), game (proposed JSON), status
 *                (pending/approved/declined/cancelled), created_at, resolved_at
 *   Games:       id, date, player1_id, player2_id, player1_score, player2_score, player1_team,
 *                player2_team, overtime, note, created_by, created_at, updated_at, deleted,
 *                sport ('2k' or 'fifa'; empty = 2k), player1_pens, player2_pens (FIFA shootouts)
 *
 * API (every response is JSON: { ok: true, data } or { ok: false, error, code })
 *   GET  ?action=bootstrap&token=...           -> { me, friends, games } in one call (what the app polls)
 *   GET  ?action=me&token=...                  -> your user
 *   GET  ?action=friends&token=...             -> your friends
 *   GET  ?action=search&token=...&q=...        -> users matching a name or username
 *   GET  ?action=games&token=...               -> every non-deleted game you played in
 *   GET  ?action=blocked&token=...             -> users you've blocked
 *   GET  ?action=profile&token=...&userId=...  -> a friend's (or your own) profile: user, opponents, games
 *   POST { action: 'signUp', username, displayName, pin }  -> { token, user, friends, games }
 *   POST { action: 'signIn', username, pin }               -> { token, user, friends, games }
 *   POST { action: 'signOut', token }                      -> {}
 *   POST { action: 'requestChange', token, kind, game?, id? } -> request (edit/delete waits for the other player)
 *   POST { action: 'respondRequest', token, requestId, approve } -> {} (approve applies the change)
 *   POST { action: 'cancelRequest', token, requestId }       -> {}
 *   POST { action: 'verifyPin', token, pin }                  -> {} (or wrong_pin / locked)
 *   POST { action: 'deleteAccount', token, pin }              -> {} (deletes the account; its games are hidden)
 *   POST { action: 'updateProfile', token, username?, displayName?, avatar? } -> user
 *   POST { action: 'changePin', token, currentPin, newPin }  -> { token } (other devices are signed out)
 *   POST { action: 'addFriend', token, userId }            -> friend (instant; safe to repeat)
 *   POST { action: 'removeFriend', token, userId }         -> {} (games are kept)
 *   POST { action: 'blockUser', token, userId }            -> {} (also removes the friendship)
 *   POST { action: 'unblockUser', token, userId }          -> {}
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
  Users: ['id', 'username', 'display_name', 'pin_hash', 'color', 'initial', 'created_at', 'avatar'],
  Friendships: ['id', 'user_a', 'user_b', 'created_at'],
  Blocks: ['id', 'blocker', 'blocked', 'created_at'],
  Requests: ['id', 'game_id', 'from_id', 'to_id', 'kind', 'game', 'status', 'created_at', 'resolved_at'],
  Games: ['id', 'date', 'player1_id', 'player2_id', 'player1_score', 'player2_score', 'player1_team', 'player2_team', 'overtime', 'note', 'created_by', 'created_at', 'updated_at', 'deleted', 'sport', 'player1_pens', 'player2_pens'],
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

/** Creates the Users, Friendships, Blocks and Games tabs with the right headers. Safe to run again. */
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
  touch_(sheet);
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

/**
 * Product testing: adds 3 random test players (usernames start with "test_"), makes them friends
 * with each other and with YOUR_USERNAME, and logs ~3 months of games between the three of them.
 * Your own games aren't touched. Optional: put a 4-digit TEST_PIN in to be able to sign in as them.
 * Run removeTestPlayers to delete all of it again.
 */
function seedTestPlayers() {
  const YOUR_USERNAME = 'omer';
  const TEST_PIN = '';
  if (TEST_PIN && !/^\d{4}$/.test(TEST_PIN)) throw new Error('TEST_PIN must be exactly 4 digits (or empty).');
  const you = findUserByUsername_(YOUR_USERNAME);
  if (!you) throw new Error('No user named ' + YOUR_USERNAME + '. Fix YOUR_USERNAME at the top of seedTestPlayers.');

  const NAMES = ['Marcus', 'Tyler', 'Jalen', 'Devin', 'Chris', 'Isaiah', 'Andre', 'Malik', 'Noah', 'Eli', 'Darius', 'Kobe', 'Luka', 'Zion', 'Trey', 'Miles', 'Jamal', 'Nico', 'Omar', 'Leo'];
  const taken = readObjects_('Users').map(function (u) { return String(u.username).toLowerCase(); });
  const pool = NAMES.filter(function (n) { return taken.indexOf('test_' + n.toLowerCase()) === -1; });
  if (pool.length < 3) throw new Error('Not enough unused test names. Run removeTestPlayers first.');
  shuffle_(pool);
  const now = new Date().toISOString();
  ensureColumn_(sheet_('Users'), 'avatar');
  const faces = shuffle_(Array.from({ length: 20 }, function (_, i) { return 'a' + ('0' + (i + 1)).slice(-2); }));

  withLock_(function () {
    // Each player gets a hidden skill level, so some rivalries are one-sided and some are close
    const players = pool.slice(0, 3).map(function (name, i) {
      const id = 'u_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      const user = {
        id: id,
        username: 'test_' + name.toLowerCase(),
        display_name: name,
        pin_hash: TEST_PIN ? hash_(id, TEST_PIN) : '',
        color: AVATAR_COLORS[(i * 3 + Math.floor(Math.random() * AVATAR_COLORS.length)) % AVATAR_COLORS.length],
        initial: name.charAt(0),
        created_at: now,
        avatar: faces[i],
      };
      appendRow_(sheet_('Users'), user);
      return { user: user, skill: 0.35 + Math.random() * 0.3, teams: pickTeams_(3) };
    });

    const friendships = sheet_('Friendships');
    const befriend = function (a, b) {
      const pair = [a, b].sort();
      appendRow_(friendships, { id: Utilities.getUuid(), user_a: pair[0], user_b: pair[1], created_at: now });
    };
    players.forEach(function (p, i) {
      befriend(p.user.id, you.user.id);
      players.slice(i + 1).forEach(function (q) { befriend(p.user.id, q.user.id); });
    });

    const NOTES = ['Down 15 at the half', 'Buzzer beater', 'Controller died in the 4th', 'Rematch game', 'Best of 3, game 1', 'Best of 3, game 2', 'Lag in the 2nd half', 'Triple double'];
    const rows = [];
    const headers = SHEETS.Games;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const count = 10 + Math.floor(Math.random() * 14);
        const pWin = a.skill / (a.skill + b.skill);
        for (let k = 0; k < count; k++) {
          const day = new Date(Date.now() - Math.floor(Math.random() * 90) * 86400000);
          const aWins = Math.random() < pWin;
          const overtime = Math.random() < 0.12;
          const margin = overtime ? 1 + Math.floor(Math.random() * 6) : 1 + Math.floor(Math.random() * Math.random() * 30);
          const loser = 78 + Math.floor(Math.random() * 38) + (overtime ? 8 : 0);
          const g = {
            id: Utilities.getUuid(),
            date: Utilities.formatDate(day, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
            player1_id: a.user.id,
            player2_id: b.user.id,
            player1_score: aWins ? loser + margin : loser,
            player2_score: aWins ? loser : loser + margin,
            player1_team: pick_(Math.random() < 0.7 ? a.teams : TEAMS),
            player2_team: pick_(Math.random() < 0.7 ? b.teams : TEAMS),
            overtime: overtime ? 'TRUE' : 'FALSE',
            note: Math.random() < 0.15 ? pick_(NOTES) : '',
            created_by: Math.random() < 0.5 ? a.user.id : b.user.id,
            created_at: now,
            updated_at: now,
            deleted: 'FALSE',
          };
          rows.push(headers.map(function (h) { return String(g[h]); }));
        }
      }
    }
    const games = sheet_('Games');
    const cols = games.getRange(1, 1, 1, games.getLastColumn()).getValues()[0];
    const ordered = rows.map(function (r) { return cols.map(function (c) { const i = headers.indexOf(c); return i === -1 ? '' : r[i]; }); });
    games.getRange(games.getLastRow() + 1, 1, ordered.length, cols.length).setNumberFormat('@').setValues(ordered);
    touch_(games);
    Logger.log('Added ' + players.map(function (p) { return p.user.display_name + ' (@' + p.user.username + ')'; }).join(', ') +
      ' with ' + ordered.length + ' games between them. They are now friends with @' + you.user.username + '.' +
      (TEST_PIN ? ' They can sign in with the TEST_PIN.' : ''));
  });
}

/** Deletes every test_ player plus their friendships and games. Real players' data is untouched. */
function removeTestPlayers() {
  withLock_(function () {
    const users = sheet_('Users');
    const testRows = readRows_(users).filter(function (r) { return String(r.data.username).indexOf('test_') === 0; });
    const ids = testRows.map(function (r) { return r.data.id; });
    if (!ids.length) return Logger.log('No test players to remove.');
    const isTest = function (id) { return ids.indexOf(String(id)) !== -1; };
    const removeRows = function (sheet, test) {
      const rows = readRows_(sheet).filter(function (r) { return test(r.data); });
      rows.reverse().forEach(function (r) { sheet.deleteRow(r.row); }); // bottom-up keeps row numbers valid
      touch_(sheet);
      return rows.length;
    };
    const games = removeRows(sheet_('Games'), function (g) { return isTest(g.player1_id) || isTest(g.player2_id); });
    removeRows(sheet_('Friendships'), function (f) { return isTest(f.user_a) || isTest(f.user_b); });
    removeRows(sheet_('Blocks'), function (b) { return isTest(b.blocker) || isTest(b.blocked); });
    removeRows(sheet_('Requests'), function (r) { return isTest(r.from_id) || isTest(r.to_id); });
    ids.forEach(endSessionsFor_);
    removeRows(users, function (u) { return isTest(u.id); });
    Logger.log('Removed ' + ids.length + ' test players and ' + games + ' games.');
  });
}

function pick_(list) {
  return list[Math.floor(Math.random() * list.length)];
}
function shuffle_(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list;
}
function pickTeams_(n) {
  return shuffle_(TEAMS.slice()).slice(0, n);
}

/* =====================================================================
 * MOVE TO FIREBASE
 * Run exportToFirestore (then verifyFirestore) from the editor. The Sheet itself is only read.
 * ===================================================================== */

const FIREBASE_PROJECT = 'dubs-d46eb';
const FIREBASE_EMAIL_DOMAIN = 'users.hoophead.xyz';
const FS_DOCS = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT + '/databases/(default)/documents';
const IDT = 'https://identitytoolkit.googleapis.com/v1/projects/' + FIREBASE_PROJECT;

/**
 * Copies every user, username, friendship, block, game (including deleted ones) and request from
 * this Sheet into Firestore, with the same ids, and gives each player a Firebase login (with a
 * random password until their first sign-in in the new app). Safe to run again: it makes
 * Firestore an exact copy of the Sheet, keeping who has already signed in to the new app.
 * Don't run it after the app has switched to Firebase (it refuses), or newer data would be lost.
 */
function exportToFirestore() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIREBASE_LIVE') === 'yes') throw new Error('The app already runs on Firebase. Copying the Sheet again would overwrite newer data.');
  const counts = withLock_(function () { // fresh reads, and no writes from the app while copying
    const users = readObjects_('Users');
    const docs = {}; // full document path → fields

    // Players and their logins
    users.forEach(function (u) {
      ensureFirebaseLogin_(u.id);
      docs['users/' + u.id] = {
        username: String(u.username), display_name: niceName_(u.display_name), color: String(u.color || '#5856D6'),
        initial: String(u.initial || niceName_(u.display_name).charAt(0) || '?').toUpperCase(), avatar: String(u.avatar || ''),
        created_at: text_(u.created_at), migrated: true,
      };
    });
    // Usernames, keeping the "already signed in to the new app" flag
    const claimedNow = {};
    listDocs_('usernames').forEach(function (d) { claimedNow[d.id] = d.fields.claimed && d.fields.claimed.booleanValue === true; });
    users.forEach(function (u) { docs['usernames/' + String(u.username).toLowerCase()] = { userId: u.id, claimed: claimedNow[String(u.username).toLowerCase()] === true }; });

    readObjects_('Friendships').forEach(function (f) {
      const pair = [String(f.user_a), String(f.user_b)].sort();
      docs['friendships/' + pair[0] + '__' + pair[1]] = { user_a: pair[0], user_b: pair[1], created_at: text_(f.created_at) };
    });
    readObjects_('Blocks').forEach(function (b) {
      docs['blocks/' + b.blocker + '__' + b.blocked] = { blocker: String(b.blocker), blocked: String(b.blocked), created_at: text_(b.created_at) };
    });
    readObjects_('Games').map(normalizeGame_).filter(function (g) { return g.id; }).forEach(function (g) {
      docs['games/' + g.id] = {
        id: g.id, date: g.date, player1_id: g.player1_id, player2_id: g.player2_id,
        player1_score: g.player1_score, player2_score: g.player2_score, player1_team: g.player1_team, player2_team: g.player2_team,
        overtime: g.overtime, note: g.note, created_by: g.created_by, created_at: g.created_at, updated_at: g.updated_at,
        deleted: g.deleted, sport: g.sport, player1_pens: g.player1_pens, player2_pens: g.player2_pens,
        players: [g.player1_id, g.player2_id], last_request: '',
      };
    });
    readObjects_('Requests').map(publicRequest_).forEach(function (r) {
      docs['requests/' + r.id] = { game_id: r.game_id, from_id: r.from_id, to_id: r.to_id, kind: r.kind, game: r.game, status: r.status, created_at: r.created_at, resolved_at: r.resolved_at };
    });

    // Make Firestore an exact copy: write everything, remove what's no longer in the Sheet
    const writes = Object.keys(docs).map(function (path) {
      return { update: { name: fsName_(path), fields: fsFields_(docs[path]) } };
    });
    ['users', 'usernames', 'friendships', 'blocks', 'games', 'requests'].forEach(function (coll) {
      listDocs_(coll).forEach(function (d) { if (!docs[coll + '/' + d.id]) writes.push({ delete: fsName_(coll + '/' + d.id) }); });
    });
    for (let i = 0; i < writes.length; i += 400) firestore_('post', FS_DOCS + ':commit', { writes: writes.slice(i, i + 400) });

    const tally = {};
    Object.keys(docs).forEach(function (path) { const c = path.split('/')[0]; tally[c] = (tally[c] || 0) + 1; });
    return tally;
  });
  Logger.log('Copied to Firestore: ' + JSON.stringify(counts) + '. Now run verifyFirestore.');
}

/**
 * Compares the Sheet with Firestore, record by record: every user, friendship, block, game and
 * request must be there with the same key fields. Logs "All good" or every difference.
 */
function verifyFirestore() {
  const problems = [];
  const fs = {};
  ['users', 'usernames', 'friendships', 'blocks', 'games', 'requests'].forEach(function (coll) {
    fs[coll] = {};
    listDocs_(coll).forEach(function (d) { fs[coll][d.id] = fromFields_(d.fields); });
  });
  const check = function (label, coll, id, expected) {
    const got = fs[coll][id];
    if (!got) return problems.push(label + ' missing in Firestore: ' + coll + '/' + id);
    Object.keys(expected).forEach(function (k) {
      if (JSON.stringify(got[k]) !== JSON.stringify(expected[k])) problems.push(label + ' ' + coll + '/' + id + ': ' + k + ' is ' + JSON.stringify(got[k]) + ', Sheet has ' + JSON.stringify(expected[k]));
    });
  };
  const users = readObjects_('Users');
  users.forEach(function (u) {
    check('User', 'users', u.id, { username: String(u.username) });
    check('Username', 'usernames', String(u.username).toLowerCase(), { userId: u.id });
    if (!PropertiesService.getScriptProperties().getProperty('fbuid:' + u.id)) problems.push('No Firebase login for ' + u.username);
  });
  const friendships = readObjects_('Friendships');
  friendships.forEach(function (f) { const p = [String(f.user_a), String(f.user_b)].sort(); check('Friendship', 'friendships', p[0] + '__' + p[1], { user_a: p[0], user_b: p[1] }); });
  const blocks = readObjects_('Blocks');
  blocks.forEach(function (b) { check('Block', 'blocks', b.blocker + '__' + b.blocked, { blocker: String(b.blocker) }); });
  const games = readObjects_('Games').map(normalizeGame_).filter(function (g) { return g.id; });
  games.forEach(function (g) {
    check('Game', 'games', g.id, { date: g.date, player1_id: g.player1_id, player2_id: g.player2_id, player1_score: g.player1_score, player2_score: g.player2_score, player1_team: g.player1_team, player2_team: g.player2_team, deleted: g.deleted, sport: g.sport });
  });
  const requests = readObjects_('Requests');
  requests.forEach(function (r) { check('Request', 'requests', String(r.id), { status: String(r.status) }); });
  const sheet = { users: users.length, friendships: friendships.length, blocks: blocks.length, games: games.length, requests: requests.length };
  Object.keys(sheet).forEach(function (c) {
    const n = Object.keys(fs[c]).length;
    if (n !== sheet[c]) problems.push(c + ': Sheet has ' + sheet[c] + ', Firestore has ' + n);
  });
  Logger.log('Sheet: ' + JSON.stringify(sheet) + ' (' + games.filter(function (g) { return !g.deleted; }).length + ' games not deleted)');
  Logger.log(problems.length ? problems.length + ' problem(s):\n' + problems.join('\n') : 'All good: Firestore matches the Sheet exactly.');
}

/**
 * First sign-in in the Firebase version of the app: checks the PIN against this Sheet (with the
 * usual wrong-PIN lockout) and, if it's right, sets the player's Firebase password from it.
 */
function claimFirebase_(username, pin) {
  const name = String(username || '').trim().toLowerCase();
  const user = withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const key = 'fails:' + name;
    const fails = JSON.parse(props.getProperty(key) || '{"count":0,"lockedUntil":0}');
    if (fails.lockedUntil > Date.now()) {
      throw apiError_('Too many attempts.', 'locked', { retryAfter: Math.ceil((fails.lockedUntil - Date.now()) / 1000) });
    }
    const found = findUserByUsername_(name);
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
    return found.user;
  });
  const uid = PropertiesService.getScriptProperties().getProperty('fbuid:' + user.id);
  if (!uid) throw apiError_('Your account hasn’t been moved to the new system yet.', 'server');
  identity_('post', IDT + '/accounts:update', { localId: uid, password: 'dubs:' + pin + ':' + user.id });
  firestore_('patch', FS_DOCS + '/usernames/' + encodeURIComponent(name) + '?updateMask.fieldPaths=claimed', { fields: { claimed: { booleanValue: true } } });
  return {};
}

/** Makes sure a player has a Firebase login "<id>@users.hoophead.xyz" and remembers its uid. */
function ensureFirebaseLogin_(userId) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('fbuid:' + userId)) return;
  const email = userId + '@' + FIREBASE_EMAIL_DOMAIN;
  let uid;
  const made = identity_('post', IDT + '/accounts', { email: email, password: Utilities.getUuid() + Utilities.getUuid() }, true);
  if (made.localId) uid = made.localId;
  else {
    const found = identity_('post', IDT + '/accounts:lookup', { email: [email] });
    uid = found.users && found.users[0] && found.users[0].localId;
  }
  if (!uid) throw new Error('Couldn’t create a Firebase login for ' + userId);
  props.setProperty('fbuid:' + userId, uid);
}

/* ---------- push notifications ----------
 * Right after you log a game ('game'), ask to change one ('request'), answer a request ('response')
 * or add a friend ('friend'), the app posts { action: 'notify', idToken, kind, id }. This checks the
 * Firebase sign-in token, re-reads the event from Firestore to make sure it's real, recent and
 * yours, and sends the other player's phones a notification through Firebase Cloud Messaging.
 * Phones that turned notifications on are in pushTokens (doc id = SHA-256 of the token).
 */
const FIREBASE_WEB_API_KEY = 'AIzaSyBtMKXnF5FTxnHjg9Ra6ZnkY6QeK0_fAw4'; // public (same as the app's)
const NOTIFY_WINDOW_MS = 15 * 60 * 1000; // only about things that just happened
const MODE_NAMES_ = { '2k': 'NBA 2K', fifa: 'FIFA' };

function notify_(idToken, kind, id) {
  const me = firebaseCaller_(idToken);
  if (!me) throw apiError_('Your session has ended. Sign in again.', 'auth');
  const key = ('notified:' + kind + ':' + id).slice(0, 240);
  const cache = CacheService.getScriptCache();
  if (cache.get(key)) return { sent: 0 }; // already sent (e.g. a retried request)
  const msg = notification_(me, String(kind || ''), String(id || ''));
  if (!msg) return { sent: 0 };
  cache.put(key, '1', 21600);
  return { sent: sendPush_(msg.to, msg) };
}

/** The user id behind a Firebase sign-in token, or null if it isn't valid. */
function firebaseCaller_(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: String(idToken) }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  const user = (JSON.parse(res.getContentText()).users || [])[0];
  const email = String((user && user.email) || '');
  const at = email.indexOf('@');
  return at > 0 && email.slice(at + 1) === FIREBASE_EMAIL_DOMAIN ? email.slice(0, at) : null;
}

function fsGet_(coll, id) {
  if (!id || /[\/]/.test(id)) return null;
  const doc = firestore_('get', FS_DOCS + '/' + coll + '/' + encodeURIComponent(id), null, true);
  return doc && doc.fields ? fromFields_(doc.fields) : null;
}

function recent_(iso) {
  const t = Date.parse(iso);
  return Boolean(t) && Date.now() - t < NOTIFY_WINDOW_MS;
}

/** What to tell whom, or null if the event isn't real, recent and yours. */
function notification_(me, kind, id) {
  const nameOf = function (uid) {
    const u = fsGet_('users', uid);
    return u ? niceName_(u.display_name) || u.username : 'A friend';
  };
  if (kind === 'game') {
    const g = fsGet_('games', id);
    if (!g || g.deleted || g.created_by !== me || !recent_(g.created_at)) return null;
    const first = g.player1_id === me; // the logger is player 1
    const theirs = first ? g.player1_score : g.player2_score;
    const yours = first ? g.player2_score : g.player1_score;
    const theirPens = first ? g.player1_pens : g.player2_pens;
    const yourPens = first ? g.player2_pens : g.player1_pens;
    let line = (yours > theirs ? 'You won ' : yours < theirs ? 'You lost ' : 'Draw ') + yours + '–' + theirs;
    if (yours === theirs && typeof yourPens === 'number' && typeof theirPens === 'number') {
      line = (yourPens > theirPens ? 'You won ' : 'You lost ') + yours + '–' + theirs + ' on penalties (' + yourPens + '–' + theirPens + ')';
    } else if (g.overtime) line += g.sport === 'fifa' ? ' (ET)' : ' (OT)';
    return { to: first ? g.player2_id : g.player1_id, title: nameOf(me) + ' logged a game', body: line + ' · ' + (MODE_NAMES_[g.sport] || 'NBA 2K'), url: './#dashboard', tag: 'game-' + id };
  }
  if (kind === 'request') {
    const r = fsGet_('requests', id);
    if (!r || r.from_id !== me || r.status !== 'pending' || !recent_(r.created_at)) return null;
    return { to: r.to_id, title: nameOf(me) + (r.kind === 'delete' ? ' wants to delete a game' : ' wants to edit a game'), body: 'Tap to approve or decline.', url: './#notifications', tag: 'request-' + id };
  }
  if (kind === 'response') {
    const r = fsGet_('requests', id);
    if (!r || r.to_id !== me || (r.status !== 'approved' && r.status !== 'declined') || !recent_(r.resolved_at)) return null;
    const approved = r.status === 'approved';
    const body = !approved ? 'The game stays as it was.' : r.kind === 'delete' ? 'The game was deleted.' : 'The game was updated.';
    return { to: r.from_id, title: nameOf(me) + (approved ? ' approved' : ' declined') + ' your request', body: body, url: './#notifications', tag: 'response-' + id };
  }
  if (kind === 'friend') {
    const f = fsGet_('friendships', id);
    if (!f || (f.user_a !== me && f.user_b !== me) || !recent_(f.created_at)) return null;
    return { to: f.user_a === me ? f.user_b : f.user_a, title: nameOf(me) + ' added you on Dubs', body: 'Log your first game against them.', url: './#friends', tag: 'friend-' + id };
  }
  return null;
}

/** Sends to every phone of `userId` that has notifications on; forgets phones that turned them off. */
function sendPush_(userId, msg) {
  const rows = firestore_('post', FS_DOCS + ':runQuery', {
    structuredQuery: { from: [{ collectionId: 'pushTokens' }], where: { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: userId } } } },
  });
  let sent = 0;
  (rows || []).forEach(function (row) {
    if (!row.document) return;
    const token = fromFields_(row.document.fields).token;
    if (!token) return;
    const res = google_('post', 'https://fcm.googleapis.com/v1/projects/' + FIREBASE_PROJECT + '/messages:send', {
      message: { token: token, data: { title: msg.title, body: msg.body, url: msg.url, tag: msg.tag }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } },
    }, true);
    if (res && res.name) sent++;
    else if (res && res.error && (res.error.status === 'NOT_FOUND' || /UNREGISTERED/.test(JSON.stringify(res.error)))) {
      firestore_('delete', 'https://firestore.googleapis.com/v1/' + row.document.name, null, true);
    }
  });
  return sent;
}

function google_(method, url, body, allowError) {
  const res = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json',
    // x-goog-user-project: count the call against the Firebase project (where these APIs are on)
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': FIREBASE_PROJECT },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300 && !allowError) throw new Error(method.toUpperCase() + ' ' + url.split('?')[0] + ' → ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return json;
}
const firestore_ = google_;
const identity_ = google_;

function fsName_(path) {
  return 'projects/' + FIREBASE_PROJECT + '/databases/(default)/documents/' + path;
}

/** Every document in a collection as { id, fields }. */
function listDocs_(coll) {
  const out = [];
  let token = '';
  do {
    const page = firestore_('get', FS_DOCS + '/' + coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (page.documents || []).forEach(function (d) { out.push({ id: d.name.split('/').pop(), fields: d.fields || {} }); });
    token = page.nextPageToken || '';
  } while (token);
  return out;
}

function fsValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue_) } };
  if (typeof v === 'object') return { mapValue: { fields: fsFields_(v) } };
  return { stringValue: String(v) };
}
function fsFields_(obj) {
  const fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = fsValue_(obj[k]); });
  return fields;
}
function fromValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  return null;
}
function fromFields_(fields) {
  const out = {};
  Object.keys(fields || {}).forEach(function (k) { out[k] = fromValue_(fields[k]); });
  return out;
}
function text_(v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }

/* =====================================================================
 * HTTP ENTRY POINTS
 * ===================================================================== */

function doGet(e) {
  return respond_(function () {
    const p = (e && e.parameter) || {};
    refuseIfMoved_(p.action);
    const me = requireSession_(p.token);
    switch (p.action) {
      case 'bootstrap': return bootstrap_(me);
      case 'me': return publicUser_(me);
      case 'friends': return listFriends_(me.id);
      case 'search': return searchUsers_(me.id, p.q);
      case 'games': return listGames_(me.id);
      case 'blocked': return listBlocked_(me.id);
      case 'profile': return getProfile_(me, p.userId);
      default: throw apiError_('Unknown action.', 'invalid');
    }
  });
}

function doPost(e) {
  return respond_(function () {
    // The app sends Content-Type text/plain (avoids a CORS preflight), so parse the raw body.
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    refuseIfMoved_(body.action);
    switch (body.action) {
      case 'signUp': return signUp_(body.username, body.displayName, body.pin);
      case 'signIn': return signIn_(body.username, body.pin);
      case 'claimFirebase': return claimFirebase_(body.username, body.pin);
      case 'notify': return notify_(body.idToken, body.kind, body.id);
      case 'signOut': return signOut_(body.token);
      case 'updateProfile': return updateProfile_(requireSession_(body.token), body.username, body.displayName, body.avatar);
      case 'changePin': return changePin_(requireSession_(body.token), body.currentPin, body.newPin);
      case 'addFriend': return addFriend_(requireSession_(body.token), body.userId);
      case 'removeFriend': return removeFriend_(requireSession_(body.token), body.userId);
      case 'blockUser': return blockUser_(requireSession_(body.token), body.userId);
      case 'unblockUser': return unblockUser_(requireSession_(body.token), body.userId);
      case 'addGame': return addGame_(requireSession_(body.token), body.game);
      case 'updateGame': return updateGame_(requireSession_(body.token), body.game);
      case 'requestChange': return requestChange_(requireSession_(body.token), body.kind, body.game, body.id);
      case 'respondRequest': return respondRequest_(requireSession_(body.token), body.requestId, body.approve === true);
      case 'cancelRequest': return cancelRequest_(requireSession_(body.token), body.requestId);
      case 'verifyPin': return verifyPin_(requireSession_(body.token), body.pin);
      case 'deleteAccount': return deleteAccount_(requireSession_(body.token), body.pin);
      case 'deleteGame': return deleteGame_(requireSession_(body.token), body.id);
      default: throw apiError_('Unknown action.', 'invalid');
    }
  });
}

/**
 * Once the app runs on Firebase (Script Property FIREBASE_LIVE = yes), this Sheet is a frozen backup:
 * an old copy of the app still open on a phone gets told to reopen, and nothing new lands here
 * (its unsent games stay on the phone and go to Firebase after the update). Only the one-time
 * PIN check for moving an account (claimFirebase) and push notifications (notify) keep working.
 */
function refuseIfMoved_(action) {
  if (action === 'claimFirebase' || action === 'notify') return;
  if (PropertiesService.getScriptProperties().getProperty('FIREBASE_LIVE') === 'yes') {
    throw apiError_('Dubs just got faster! Close the app completely and open it again to update.', 'moved');
  }
}

/* =====================================================================
 * ACCOUNTS & SESSIONS
 * ===================================================================== */

/** "omer lukatz" → "Omer Lukatz": first letter of each word capitalised, the rest left as typed. */
function niceName_(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)(\S)/g, function (m, space, ch) { return space + ch.toUpperCase(); });
}

function signUp_(username, displayName, pin) {
  const name = String(username || '').trim().toLowerCase();
  const display = niceName_(displayName);
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
    return { token: newSession_(id), user: publicUser_(user), friends: [], games: [], requests: [] };
  });
}

function signIn_(username, pin) {
  const name = String(username || '').trim().toLowerCase();
  const result = withLock_(function () {
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
    return { token: newSession_(found.user.id), user: found.user };
  });
  // Everything the app needs to show the dashboard straight away (read outside the lock)
  const data = bootstrap_(result.user);
  if (Math.random() < 0.05) pruneSessions_(); // tidy expired sessions now and then, not on every sign-in
  return { token: result.token, user: data.me, friends: data.friends, games: data.games, requests: data.requests };
}

/** Your profile, friends and games in one response: one execution instead of three. */
function bootstrap_(me) {
  return { me: publicUser_(me), friends: listFriends_(me.id), games: listGames_(me.id), requests: listRequests_(me.id) };
}

function updateProfile_(me, username, displayName, avatar) {
  return withLock_(function () {
    const found = findUserByUsername_(me.username);
    if (!found) throw apiError_('This account no longer exists.', 'auth');
    const next = Object.assign({}, found.user);
    if (username != null) {
      const name = String(username).trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw apiError_('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
      const taken = findUserByUsername_(name);
      if (taken && taken.user.id !== me.id) throw apiError_('That username is taken.', 'taken');
      next.username = name;
    }
    if (displayName != null) {
      const display = niceName_(displayName);
      if (!display || display.length > 24) throw apiError_('Enter a name up to 24 characters.', 'invalid');
      next.display_name = display;
      next.initial = display.charAt(0).toUpperCase();
    }
    if (avatar != null) {
      if (avatar && !/^a\d{2}$/.test(String(avatar))) throw apiError_('Pick one of the avatars.', 'invalid');
      next.avatar = String(avatar);
    }
    const users = sheet_('Users');
    ensureColumn_(users, 'avatar'); // sheets made before avatars existed don't have the column yet
    writeRow_(users, found.row, next);
    return publicUser_(next);
  });
}

function changePin_(me, currentPin, newPin) {
  if (!/^\d{4}$/.test(String(newPin))) throw apiError_('Your new PIN must be 4 digits.', 'invalid');
  return withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const key = 'fails:' + me.username;
    const fails = JSON.parse(props.getProperty(key) || '{"count":0,"lockedUntil":0}');
    if (fails.lockedUntil > Date.now()) {
      throw apiError_('Too many attempts.', 'locked', { retryAfter: Math.ceil((fails.lockedUntil - Date.now()) / 1000) });
    }
    if (hash_(me.id, String(currentPin)) !== me.pin_hash) {
      fails.count += 1;
      if (fails.count >= MAX_TRIES) {
        props.setProperty(key, JSON.stringify({ count: 0, lockedUntil: Date.now() + LOCK_MINUTES * 60000 }));
        throw apiError_('Too many attempts.', 'locked', { retryAfter: LOCK_MINUTES * 60 });
      }
      props.setProperty(key, JSON.stringify(fails));
      throw apiError_('Your current PIN is wrong.', 'wrong_pin', { triesLeft: MAX_TRIES - fails.count });
    }
    props.deleteProperty(key);
    const found = findUserByUsername_(me.username);
    const sheet = sheet_('Users');
    sheet.getRange(found.row, colIndex_(sheet, 'pin_hash')).setNumberFormat('@').setValue(hash_(me.id, String(newPin)));
    touch_(sheet);
    endSessionsFor_(me.id); // sign out every other device
    return { token: newSession_(me.id) };
  });
}

function signOut_(token) {
  if (token) {
    PropertiesService.getScriptProperties().deleteProperty('session:' + token);
    CacheService.getScriptCache().remove('session:' + token);
  }
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
  const cache = CacheService.getScriptCache();
  let raw = token && cache.get('session:' + token);
  if (token && !raw) {
    raw = props.getProperty('session:' + token);
    if (raw) cache.put('session:' + token, raw, 600); // 10 minutes; removed on sign-out / PIN change
  }
  const session = raw && JSON.parse(raw);
  if (!session || session.expires < Date.now()) {
    if (raw) {
      props.deleteProperty('session:' + token);
      cache.remove('session:' + token);
    }
    throw apiError_('Your session has ended. Sign in again.', 'auth');
  }
  const user = readObjects_('Users').find(function (u) { return u.id === session.userId; });
  if (!user) throw apiError_('This account no longer exists.', 'auth');
  return user;
}

function endSessionsFor_(userId) {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session:') === 0 && JSON.parse(all[k]).userId === userId) {
      props.deleteProperty(k);
      cache.remove(k);
    }
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
  const name = niceName_(u.display_name);
  return { id: u.id, username: u.username, display_name: name, color: u.color || '#5856D6', initial: String(u.initial || name.charAt(0) || '?').toUpperCase(), avatar: String(u.avatar || '') };
}

function findUserByUsername_(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) return null;
  const rows = readRows_('Users');
  const hit = rows.find(function (r) { return String(r.data.username).toLowerCase() === name; });
  return hit ? { row: hit.row, user: hit.data } : null;
}

function friendIds_(userId) {
  return readObjects_('Friendships')
    .filter(function (f) { return f.user_a === userId || f.user_b === userId; })
    .map(function (f) { return f.user_a === userId ? f.user_b : f.user_a; });
}

function listFriends_(userId) {
  const ids = friendIds_(userId);
  return readObjects_('Users')
    .filter(function (u) { return ids.indexOf(u.id) !== -1; })
    .map(publicUser_);
}

function searchUsers_(userId, query) {
  const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 2) return [];
  const friends = friendIds_(userId);
  const hidden = blockedEitherWay_(userId);
  return readObjects_('Users')
    .filter(function (u) {
      return u.id !== userId && hidden.indexOf(u.id) === -1 && (String(u.username).toLowerCase().indexOf(q) !== -1 || String(u.display_name).toLowerCase().indexOf(q) !== -1);
    })
    .slice(0, 20)
    .map(function (u) { return Object.assign(publicUser_(u), { isFriend: friends.indexOf(u.id) !== -1 }); });
}

function addFriend_(me, userId) {
  if (!userId || userId === me.id) throw apiError_('Pick someone else to add.', 'invalid');
  const other = readObjects_('Users').find(function (u) { return u.id === userId; });
  if (!other) throw apiError_('That user no longer exists.', 'invalid');
  if (blockedEitherWay_(me.id).indexOf(userId) !== -1) throw apiError_('You can’t add this person.', 'invalid');
  return withLock_(function () {
    if (friendIds_(me.id).indexOf(userId) === -1) {
      const pair = [me.id, userId].sort();
      appendRow_(sheet_('Friendships'), { id: Utilities.getUuid(), user_a: pair[0], user_b: pair[1], created_at: new Date().toISOString() });
    }
    return publicUser_(other);
  });
}

/** Deletes the friendship row between two users, if any. Games between them are kept. */
function deleteFriendship_(a, b) {
  const sheet = sheet_('Friendships');
  const rows = readRows_(sheet).filter(function (r) {
    return (r.data.user_a === a && r.data.user_b === b) || (r.data.user_a === b && r.data.user_b === a);
  });
  rows.reverse().forEach(function (r) { sheet.deleteRow(r.row); }); // bottom-up keeps row numbers valid
  touch_(sheet);
}

function removeFriend_(me, userId) {
  return withLock_(function () {
    deleteFriendship_(me.id, userId);
    return {};
  });
}

/** Users blocked by, or blocking, this user: neither side can find or add the other. */
function blockedEitherWay_(userId) {
  return readObjects_('Blocks')
    .filter(function (b) { return b.blocker === userId || b.blocked === userId; })
    .map(function (b) { return b.blocker === userId ? b.blocked : b.blocker; });
}

function listBlocked_(userId) {
  const ids = readObjects_('Blocks').filter(function (b) { return b.blocker === userId; }).map(function (b) { return b.blocked; });
  return readObjects_('Users').filter(function (u) { return ids.indexOf(u.id) !== -1; }).map(publicUser_);
}

function blockUser_(me, userId) {
  if (!userId || userId === me.id) throw apiError_('Pick someone else to block.', 'invalid');
  return withLock_(function () {
    deleteFriendship_(me.id, userId);
    const already = readObjects_('Blocks').some(function (b) { return b.blocker === me.id && b.blocked === userId; });
    if (!already) appendRow_(sheet_('Blocks'), { id: Utilities.getUuid(), blocker: me.id, blocked: userId, created_at: new Date().toISOString() });
    return {};
  });
}

function unblockUser_(me, userId) {
  return withLock_(function () {
    const sheet = sheet_('Blocks');
    readRows_(sheet)
      .filter(function (r) { return r.data.blocker === me.id && r.data.blocked === userId; })
      .reverse()
      .forEach(function (r) { sheet.deleteRow(r.row); });
    touch_(sheet);
    return {};
  });
}

/**
 * A profile: the user, everyone they've played, and all their games. Only you and your friends can
 * see it (so blocking someone also hides your profile from them).
 */
function getProfile_(me, userId) {
  const id = userId || me.id;
  if (id !== me.id && friendIds_(me.id).indexOf(id) === -1) throw apiError_('You can only see your friends’ profiles.', 'invalid');
  const users = readObjects_('Users');
  const user = users.find(function (u) { return u.id === id; });
  if (!user) throw apiError_('That user no longer exists.', 'invalid');
  const games = listGames_(id);
  const oppIds = {};
  games.forEach(function (g) { oppIds[g.player1_id === id ? g.player2_id : g.player1_id] = true; });
  return {
    user: publicUser_(user),
    opponents: users.filter(function (u) { return oppIds[u.id]; }).map(publicUser_),
    games: games,
  };
}

/* =====================================================================
 * GAMES
 * ===================================================================== */

function listGames_(userId) {
  return readObjects_('Games')
    .map(normalizeGame_)
    .filter(function (g) { return g.id && !g.deleted && (g.player1_id === userId || g.player2_id === userId); });
}

function addGame_(me, game) {
  return withLock_(function () {
    const clean = cleanGame_(game, me);
    const sheet = sheet_('Games');
    ['sport', 'player1_pens', 'player2_pens'].forEach(function (c) { ensureColumn_(sheet, c); }); // added with FIFA
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

// Saved games can't be changed directly any more: edits and deletes go through requestChange_ and
// the other player's approval. (Kept so old versions of the app get a clear message.)
function updateGame_(me, game) {
  throw apiError_('Changes now need your friend’s approval. Close and reopen the app to update it.', 'invalid');
}

function deleteGame_(me, id) {
  throw apiError_('Deleting now needs your friend’s approval. Close and reopen the app to update it.', 'invalid');
}

/* =====================================================================
 * CHANGE REQUESTS: editing or deleting a saved game needs the other player to approve
 * ===================================================================== */

const REQUEST_DAYS = 14; // answered requests stay visible (as notifications) this long

function requestChange_(me, kind, game, id) {
  if (kind !== 'edit' && kind !== 'delete') throw apiError_('Unknown change.', 'invalid');
  return withLock_(function () {
    const gameId = String(kind === 'edit' ? (game && game.id) || '' : id || '');
    const existing = findGameRow_(sheet_('Games'), gameId);
    if (!existing) throw apiError_('That game no longer exists.', 'invalid');
    const prev = normalizeGame_(existing.data);
    if (prev.deleted) throw apiError_('That game was already deleted.', 'invalid');
    assertPlayedIn_(prev, me);
    const other = prev.player1_id === me.id ? prev.player2_id : prev.player1_id;
    let proposed = '';
    if (kind === 'edit') {
      const clean = cleanGame_(game, me);
      const samePair = [prev.player1_id, prev.player2_id].sort().join() === [clean.player1_id, clean.player2_id].sort().join();
      if (!samePair) throw apiError_('A game can’t be moved to different players.', 'invalid');
      proposed = JSON.stringify(clean);
    }
    const sheet = sheet_('Requests');
    const open = readRows_(sheet).filter(function (r) { return r.data.game_id === gameId && r.data.status === 'pending'; });
    if (open.some(function (r) { return r.data.from_id !== me.id; })) {
      throw apiError_('Your friend already asked to change this game. Answer that first in Notifications.', 'invalid');
    }
    const mine = open[0]; // asking again replaces your earlier request for this game
    const request = {
      id: mine ? mine.data.id : Utilities.getUuid(),
      game_id: gameId,
      from_id: me.id,
      to_id: other,
      kind: kind,
      game: proposed,
      status: 'pending',
      created_at: new Date().toISOString(),
      resolved_at: '',
    };
    if (mine) writeRow_(sheet, mine.row, request);
    else appendRow_(sheet, request);
    return publicRequest_(request);
  });
}

function respondRequest_(me, requestId, approve) {
  return withLock_(function () {
    const sheet = sheet_('Requests');
    const hit = readRows_(sheet).find(function (r) { return r.data.id === requestId; });
    if (!hit || hit.data.status !== 'pending') throw apiError_('This request was already answered or cancelled.', 'invalid');
    if (hit.data.to_id !== me.id) throw apiError_('Only your friend can answer this request.', 'invalid');
    const now = new Date().toISOString();
    if (approve) {
      const games = sheet_('Games');
      ['sport', 'player1_pens', 'player2_pens'].forEach(function (c) { ensureColumn_(games, c); });
      const existing = findGameRow_(games, hit.data.game_id);
      if (!existing) throw apiError_('That game no longer exists.', 'invalid');
      const prev = normalizeGame_(existing.data);
      if (hit.data.kind === 'delete') {
        writeRow_(games, existing.row, Object.assign(prev, { deleted: true, updated_at: now }));
      } else {
        const next = JSON.parse(hit.data.game);
        writeRow_(games, existing.row, Object.assign(next, { created_by: prev.created_by, created_at: prev.created_at, updated_at: now, deleted: false }));
      }
    }
    writeRow_(sheet, hit.row, Object.assign({}, hit.data, { status: approve ? 'approved' : 'declined', resolved_at: now }));
    return {};
  });
}

function cancelRequest_(me, requestId) {
  return withLock_(function () {
    const sheet = sheet_('Requests');
    const hit = readRows_(sheet).find(function (r) { return r.data.id === requestId; });
    if (!hit || hit.data.status !== 'pending') return {};
    if (hit.data.from_id !== me.id) throw apiError_('Only the person who asked can cancel this.', 'invalid');
    writeRow_(sheet, hit.row, Object.assign({}, hit.data, { status: 'cancelled', resolved_at: new Date().toISOString() }));
    return {};
  });
}

/** Open requests to or from you, plus ones answered in the last two weeks (shown as notifications). */
function listRequests_(userId) {
  const since = new Date(Date.now() - REQUEST_DAYS * 86400000).toISOString();
  return readObjects_('Requests')
    .filter(function (r) {
      if (r.from_id !== userId && r.to_id !== userId) return false;
      if (r.status === 'pending') return true;
      return (r.status === 'approved' || r.status === 'declined') && String(r.resolved_at) >= since;
    })
    .map(publicRequest_);
}

function publicRequest_(r) {
  let game = null;
  try { game = r.game ? JSON.parse(r.game) : null; } catch (e) { game = null; }
  const text = function (v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); };
  return { id: text(r.id), game_id: text(r.game_id), from_id: text(r.from_id), to_id: text(r.to_id), kind: text(r.kind), game: game, status: text(r.status), created_at: text(r.created_at), resolved_at: text(r.resolved_at) };
}

/* =====================================================================
 * ACCOUNT DELETION
 * ===================================================================== */

/** Checks your PIN (with the usual wrong-PIN lockout). Used before deleting your account. */
function verifyPin_(me, pin) {
  return withLock_(function () {
    checkPin_(me, pin);
    return {};
  });
}

function checkPin_(me, pin) {
  const props = PropertiesService.getScriptProperties();
  const key = 'fails:' + me.username;
  const fails = JSON.parse(props.getProperty(key) || '{"count":0,"lockedUntil":0}');
  if (fails.lockedUntil > Date.now()) {
    throw apiError_('Too many attempts.', 'locked', { retryAfter: Math.ceil((fails.lockedUntil - Date.now()) / 1000) });
  }
  if (!/^\d{4}$/.test(String(pin)) || hash_(me.id, String(pin)) !== me.pin_hash) {
    fails.count += 1;
    if (fails.count >= MAX_TRIES) {
      props.setProperty(key, JSON.stringify({ count: 0, lockedUntil: Date.now() + LOCK_MINUTES * 60000 }));
      throw apiError_('Too many attempts.', 'locked', { retryAfter: LOCK_MINUTES * 60 });
    }
    props.setProperty(key, JSON.stringify(fails));
    throw apiError_('That PIN is wrong.', 'wrong_pin', { triesLeft: MAX_TRIES - fails.count });
  }
  props.deleteProperty(key);
}

/**
 * Deletes your account: your user row, friendships, blocks and requests, and hides your games
 * (soft delete, so the Sheet owner could still recover them). Signs you out everywhere.
 */
function deleteAccount_(me, pin) {
  return withLock_(function () {
    checkPin_(me, pin);
    const now = new Date().toISOString();
    const removeRows = function (name, test) {
      const sheet = sheet_(name);
      const rows = readRows_(sheet).filter(function (r) { return test(r.data); });
      rows.reverse().forEach(function (r) { sheet.deleteRow(r.row); }); // bottom-up keeps row numbers valid
      if (rows.length) touch_(sheet);
    };
    removeRows('Friendships', function (f) { return f.user_a === me.id || f.user_b === me.id; });
    removeRows('Blocks', function (b) { return b.blocker === me.id || b.blocked === me.id; });
    removeRows('Requests', function (r) { return r.from_id === me.id || r.to_id === me.id; });
    const games = sheet_('Games');
    readRows_(games).forEach(function (r) {
      const g = normalizeGame_(r.data);
      if (!g.deleted && (g.player1_id === me.id || g.player2_id === me.id)) writeRow_(games, r.row, Object.assign(g, { deleted: true, updated_at: now }));
    });
    removeRows('Users', function (u) { return u.id === me.id; });
    endSessionsFor_(me.id);
    return {};
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
  const sport = g.sport == null || g.sport === '' ? '2k' : String(g.sport);
  if (sport !== '2k' && sport !== 'fifa') throw apiError_('Unknown game mode.', 'invalid');
  const fifa = sport === 'fifa';
  const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
  if (![s1, s2].every(function (n) { return Number.isInteger(n) && n >= 0 && n <= (fifa ? 99 : 999); })) throw apiError_('Enter both scores.', 'invalid');
  if (!fifa && s1 === s2) throw apiError_('Basketball has no ties. Someone has to win.', 'invalid');
  let p1 = '', p2 = '';
  if (g.player1_pens != null && g.player1_pens !== '') {
    p1 = Number(g.player1_pens); p2 = Number(g.player2_pens);
    if (!fifa || s1 !== s2) throw apiError_('Penalties are only for level FIFA games.', 'invalid');
    if (![p1, p2].every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 99; }) || p1 === p2) throw apiError_('A shootout needs a winner.', 'invalid');
  }
  // NBA teams are 3-letter codes; FIFA teams are "F-" + code (e.g. F-ARS)
  const t1 = fifa ? String(g.player1_team || '') : String(g.player1_team || '').toUpperCase();
  const t2 = fifa ? String(g.player2_team || '') : String(g.player2_team || '').toUpperCase();
  const validTeam = function (t) { return fifa ? /^F-[A-Z0-9]{2,4}$/.test(t) : TEAMS.indexOf(t) !== -1; };
  if (!validTeam(t1) || !validTeam(t2)) throw apiError_('Choose both teams.', 'invalid');
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
    sport: sport,
    player1_pens: p1,
    player2_pens: p2,
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
    sport: String(r.sport || '') === 'fifa' ? 'fifa' : '2k',
    player1_pens: r.player1_pens === '' || r.player1_pens == null ? '' : Number(r.player1_pens),
    player2_pens: r.player2_pens === '' || r.player2_pens == null ? '' : Number(r.player2_pens),
  };
}

/* =====================================================================
 * SHEET HELPERS
 * ===================================================================== */

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet && name === 'Requests') {
    // Added after launch: create it the first time it's needed instead of asking you to run setupSheet
    sheet = ss.insertSheet(name);
    sheet.appendRow(SHEETS[name]);
    sheet.getRange(1, 1, sheet.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
    sheet.setFrozenRows(1);
  }
  if (!sheet) throw apiError_('The "' + name + '" tab is missing. Run setupSheet in the script editor.', 'server');
  return sheet;
}

function colIndex_(sheet, name) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(name) + 1;
}

/** All rows as { row, data } keyed by the header row, so columns can be in any order. */
/**
 * A whole tab as { row, data } keyed by the header row, so columns can be in any order.
 * Accepts a tab name or a Sheet. Outside writes, the values come from a 60-second cache
 * (opening the spreadsheet is the slowest part of every request). Every write clears the
 * tab's cache, and code inside withLock_ always reads the live Sheet.
 */
function readRows_(sheetOrName) {
  const values = sheetValues_(sheetOrName);
  const headers = values[0] || [];
  return values.slice(1).map(function (v, i) {
    const data = {};
    headers.forEach(function (h, j) { data[h] = v[j]; });
    return { row: i + 2, data: data };
  }).filter(function (r) { return r.data.id !== '' && r.data.id != null; });
}

function readObjects_(sheetOrName) {
  return readRows_(sheetOrName).map(function (r) { return r.data; });
}

// ---------- cache ----------

const CACHE_SECONDS = 60;
let FRESH_ = false; // true inside withLock_: writes never act on cached rows

function sheetValues_(sheetOrName) {
  const name = typeof sheetOrName === 'string' ? sheetOrName : sheetOrName.getName();
  const key = 'sheet:' + name;
  if (!FRESH_) {
    const hit = cacheGet_(key);
    if (hit) return hit.map(function (row) { return row.map(function (v) { return v && v.$d != null ? new Date(v.$d) : v; }); });
  }
  const sheet = typeof sheetOrName === 'string' ? sheet_(name) : sheetOrName;
  const values = sheet.getDataRange().getValues();
  cachePut_(key, values.map(function (row) { return row.map(function (v) { return v instanceof Date ? { $d: v.getTime() } : v; }); }));
  return values;
}

/** Call after changing a tab so the next read sees it. */
function touch_(sheet) {
  CacheService.getScriptCache().remove('sheet:' + sheet.getName());
}

// Values over 100 KB are split across keys: "key" holds the part count, "key:0", "key:1", … the parts.
function cacheGet_(key) {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(key));
  if (!count) return null;
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(key + ':' + i);
  const parts = cache.getAll(keys);
  let text = '';
  for (let i = 0; i < count; i++) {
    if (parts[key + ':' + i] == null) return null;
    text += parts[key + ':' + i];
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

function cachePut_(key, value) {
  const text = JSON.stringify(value);
  const size = 40000; // characters per part: safely under 100 KB even for non-Latin names
  const count = Math.max(1, Math.ceil(text.length / size));
  if (count > 40) return; // too big to be worth caching
  const map = {};
  for (let i = 0; i < count; i++) map[key + ':' + i] = text.substr(i * size, size);
  map[key] = String(count);
  try { CacheService.getScriptCache().putAll(map, CACHE_SECONDS); } catch (e) { /* the cache is best-effort */ }
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
  touch_(sheet);
  return obj;
}

/** Adds a header column at the end if it's missing. */
function ensureColumn_(sheet, name) {
  if (colIndex_(sheet, name)) return;
  const col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(name);
  sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  touch_(sheet);
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
  const wasFresh = FRESH_;
  FRESH_ = true;
  try {
    return fn();
  } finally {
    FRESH_ = wasFresh;
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
