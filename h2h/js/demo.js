// Demo backend: used when config.js has no Apps Script URL. It mirrors the real server's
// behaviour (sign-up, hashed PINs, sessions, lockout after 5 wrong tries, instant friends,
// friend-only games, soft deletes, validation, network latency) but stores everything in
// this browser.
import { uuid, sha256 } from './crypto.js';
import { getTeam, teamsFor } from './teams.js';
import { generateSampleGames } from './sample.js';
import { drawFor, checkLayout, storedLayout, cleanSettings, cleanName, groupIds, recordOf, buildBracket, accepted, allAnswered, hostOf, nextHost, MIN_PLAYERS, MAX_PLAYERS } from './tournament.js';

const KEY = 'h2h.demo.v3';
const OFFLINE_KEY = 'h2h.demo.offline';
const LATENCY = 350;
const MAX_TRIES = 5;
const LOCK_MS = 5 * 60 * 1000;
const SALT = 'demo-salt';
const COLORS = ['#5856D6', '#C93400', '#007A5E', '#A2338A', '#0060C7', '#8A5A00', '#B0263A', '#3D6591'];

const SEED_USERS = [
  { id: 'u_alex', username: 'alex', display_name: 'Alex', color: '#5856D6', initial: 'A', seed_pin: '1111' },
  { id: 'u_sam', username: 'sam', display_name: 'Sam', color: '#C93400', initial: 'S', seed_pin: '2222' },
  { id: 'u_jordan', username: 'jordan', display_name: 'Jordan', color: '#007A5E', initial: 'J', seed_pin: '3333' },
  { id: 'u_riley', username: 'riley', display_name: 'Riley', color: '#A2338A', initial: 'R', seed_pin: '4444' },
  // More of Alex's friends, so a demo tournament has a real bracket
  { id: 'u_casey', username: 'casey', display_name: 'Casey', color: '#0060C7', initial: 'C', seed_pin: '5555' },
  { id: 'u_morgan', username: 'morgan', display_name: 'Morgan', color: '#8A5A00', initial: 'M', seed_pin: '6666' },
  { id: 'u_taylor', username: 'taylor', display_name: 'Taylor', color: '#B0263A', initial: 'T', seed_pin: '7777' },
];
const SEED_FRIENDS = [['u_alex', 'u_sam'], ['u_alex', 'u_jordan'], ['u_riley', 'u_sam'], ['u_alex', 'u_casey'], ['u_alex', 'u_morgan'], ['u_alex', 'u_taylor']];
const ACCEPT_AFTER_MS = 4000; // demo friends answer an invite after a few seconds

const sampleGames = () => [
  ...generateSampleGames('u_alex', 'u_sam'),
  ...generateSampleGames('u_alex', 'u_jordan', { count: 12, seed: 7, startDaysAgo: 3, script: [false, true, true] }),
  ...generateSampleGames('u_sam', 'u_riley', { count: 9, seed: 99, startDaysAgo: 2 }),
  ...generateSampleGames('u_alex', 'u_sam', { sport: 'fifa', count: 24, seed: 11, startDaysAgo: 0, script: [true, null, false] }),
  ...generateSampleGames('u_alex', 'u_jordan', { sport: 'fifa', count: 8, seed: 5, startDaysAgo: 4 }),
];

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s?.users) return s;
  } catch { /* fall through */ }
  const now = new Date().toISOString();
  const fresh = {
    users: SEED_USERS.map((u) => ({ ...u, created_at: now })),
    friendships: SEED_FRIENDS.map(([a, b], i) => ({ id: `f${i}`, user_a: a, user_b: b, created_at: now })),
    games: sampleGames(),
    sessions: {},
    fails: {},
    sample: true,
  };
  // One open request so the Notifications bell has something to show: Sam asks Alex to delete
  // their most recent 2K game.
  const target = fresh.games.find((g) => g.player1_id === 'u_alex' && g.player2_id === 'u_sam' && g.sport !== 'fifa');
  if (target) fresh.requests = [{ id: 'req-demo-1', game_id: target.id, from_id: 'u_sam', to_id: 'u_alex', kind: 'delete', game: null, status: 'pending', created_at: now, resolved_at: '' }];
  // A tournament invite from Sam, so the invite looks like something (it starts once Alex answers)
  const inWeekend = ['u_sam', 'u_alex', 'u_riley', 'u_jordan'];
  fresh.tournaments = [
    {
      id: 'tour-demo-1', name: 'Weekend Cup', sport: '2k', creator: 'u_sam', created_at: now, status: 'inviting',
      players: inWeekend,
      answers: { u_sam: 'accepted', u_alex: 'pending', u_riley: 'accepted', u_jordan: 'accepted' },
      format: 'knockout', group_games: 1, best_of: { early: 3, semi: 3, final: 3 }, draw: 'random', auto_start: true, deadline_days: 0,
      seeds: null, groups: null, decisions: {}, nudges: {}, started_at: '',
      people: Object.fromEntries(SEED_USERS.filter((u) => inWeekend.includes(u.id)).map((u) => [u.id, { display_name: u.display_name, username: u.username, color: u.color, initial: u.initial, avatar: '' }])),
    },
  ];
  save(fresh);
  return fresh;
}
const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));


/** Same as the server: first letter of each word capitalised. */
const niceName = (name) => String(name || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)(\S)/g, (m, space, ch) => space + ch.toUpperCase());

export const controls = {
  get offline() {
    return localStorage.getItem(OFFLINE_KEY) === '1';
  },
  set offline(on) {
    localStorage.setItem(OFFLINE_KEY, on ? '1' : '0');
    window.dispatchEvent(new Event(on ? 'offline' : 'online'));
  },
  get sample() {
    return load().sample;
  },
  setSample(on) {
    const s = load();
    const own = s.games.filter((g) => !g.id.startsWith('sample-'));
    s.games = on ? [...own, ...sampleGames()] : own;
    s.sample = on;
    save(s);
  },
  hint: 'alex · 1111, sam · 2222, jordan · 3333',
};

/** Same validation as the Apps Script server. Returns an error message or null. */
function validateGame(g, meId, friendIds) {
  const players = [g.player1_id, g.player2_id];
  const opponent = players[0] === meId ? players[1] : players[1] === meId ? players[0] : null;
  if (!opponent || opponent === meId) return 'You can only log games you played in.';
  if (!friendIds.includes(opponent)) return 'You can only log games against your friends.';
  const fifa = g.sport === 'fifa';
  if (g.sport != null && g.sport !== '2k' && !fifa) return 'Unknown game mode.';
  const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
  if (![s1, s2].every((n) => Number.isInteger(n) && n >= 0 && n <= (fifa ? 99 : 999))) return 'Enter both scores.';
  if (!fifa && s1 === s2) return 'Basketball has no ties. Someone has to win.';
  const hasPens = g.player1_pens != null && g.player1_pens !== '';
  if (hasPens) {
    const p1 = Number(g.player1_pens), p2 = Number(g.player2_pens);
    if (!fifa || s1 !== s2) return 'Penalties are only for level FIFA games.';
    if (![p1, p2].every((n) => Number.isInteger(n) && n >= 0 && n <= 99) || p1 === p2) return 'A shootout needs a winner.';
  }
  const team = (t) => getTeam(t) && String(t).startsWith('F-') === fifa;
  if (!team(g.player1_team) || !team(g.player2_team)) return 'Choose both teams.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date || '')) return 'Choose a date.';
  return null;
}

export function createDemoBackend(ApiError) {
  const delay = () => new Promise((r) => setTimeout(r, LATENCY));
  const net = async () => {
    await delay();
    if (controls.offline || !navigator.onLine) throw new ApiError('You’re offline.', 'network');
  };
  const pub = ({ id, username, display_name, color, initial, avatar }) => ({ id, username, display_name: niceName(display_name), color, initial: String(initial || '?').toUpperCase(), avatar: avatar || '' });
  const me = (s, token) => {
    const user = s.users.find((u) => u.id === s.sessions[token]);
    if (!user) throw new ApiError('Your session has ended. Sign in again.', 'auth');
    return user;
  };
  const blockedEitherWay = (s, id) => (s.blocks || []).filter((b) => b.blocker === id || b.blocked === id).map((b) => (b.blocker === id ? b.blocked : b.blocker));
  const unfriend = (s, a, b) => (s.friendships = s.friendships.filter((f) => !((f.user_a === a && f.user_b === b) || (f.user_a === b && f.user_b === a))));
  const friendIds = (s, id) => s.friendships.filter((f) => f.user_a === id || f.user_b === id).map((f) => (f.user_a === id ? f.user_b : f.user_a));
  // What the app needs after sign-in and on every sync (like the server's bootstrap_)
  const since = () => new Date(Date.now() - 14 * 86400000).toISOString();
  const snapshot = (s, id) => ({
    friends: s.users.filter((u) => friendIds(s, id).includes(u.id)).map(pub),
    games: s.games.filter((g) => !g.deleted && (g.player1_id === id || g.player2_id === id)),
    requests: (s.requests || []).filter(
      (r) => (r.from_id === id || r.to_id === id) && (r.status === 'pending' || (['approved', 'declined'].includes(r.status) && r.resolved_at >= since())),
    ),
    tournaments: answerInvites(s, id).filter((t) => t.players.includes(id)),
    tournamentGames: s.games.filter((g) => g.tournament_id && !g.deleted && (s.tournaments || []).some((t) => t.id === g.tournament_id && t.players.includes(id))),
    trophies: trophiesFor(s, [id, ...friendIds(s, id)]),
  });
  /**
   * Demo friends answer their invites by themselves a few seconds after they're sent, and a demo
   * friend's own tournament starts once everyone has answered.
   */
  const answerInvites = (s, myId) => {
    let changed = false;
    for (const t of s.tournaments || []) {
      if (t.status !== 'inviting') continue;
      for (const id of t.players) {
        const invitedAt = Date.parse(t.invited_at?.[id] || t.created_at);
        if (Date.now() - invitedAt < ACCEPT_AFTER_MS) continue;
        if (id !== myId && t.answers[id] === 'pending' && s.users.some((u) => u.id === id && u.seed_pin)) {
          t.answers[id] = 'accepted';
          changed = true;
          // A demo friend brings along one of their own friends (whom you may not know)
          const outside = !t.brought && friendIds(s, id).find((x) => !t.players.includes(x) && x !== myId);
          if (outside && t.players.length < MAX_PLAYERS) {
            addInvite(t, outside, id, s);
            t.brought = true;
          }
        }
      }
      if (t.auto_start && allAnswered(t) && accepted(t).length >= MIN_PLAYERS) {
        startNow(s, t);
        changed = true;
      }
    }
    if (changed) save(s);
    return s.tournaments || [];
  };
  const profileOf = (s, id) => {
    const u = pub(s.users.find((x) => x.id === id));
    return { display_name: u.display_name, username: u.username, color: u.color, initial: u.initial, avatar: u.avatar };
  };
  const hostTour = (s, id, myId, status) => {
    const t = (s.tournaments || []).find((x) => x.id === id);
    if (!t || hostOf(t) !== myId) throw new ApiError('Only the host can do that.', 'invalid');
    if (t.status !== status) throw new ApiError(status === 'inviting' ? 'This tournament has already started or was cancelled.' : 'This tournament isn’t being played right now.', 'invalid');
    return t;
  };
  const addInvite = (t, p, by, s) => {
    t.players.push(p);
    t.answers[p] = 'pending';
    (t.invited_by ||= {})[p] = by;
    t.people[p] = profileOf(s, p);
    (t.invited_at ||= {})[p] = new Date().toISOString();
  };
  /** Draws (or takes the host's) bracket or groups; the tournament goes live. */
  const startNow = (s, t, layout = null) => {
    Object.assign(t, { status: 'live', ...storedLayout(layout || drawFor(t, accepted(t), s.games)), started_at: new Date().toISOString() });
  };
  /** Trophies of you and your friends, from every finished tournament (the real app stores them). */
  const trophiesFor = (s, ids) =>
    (s.tournaments || [])
      .filter((t) => t.status === 'live')
      .map((t) => ({ t, b: buildBracket(t, s.games) }))
      .filter(({ b }) => b.champion && ids.includes(b.champion))
      .map(({ t, b }) => ({ id: t.id, winner: b.champion, name: t.name, sport: t.sport, date: String(b.rounds.at(-1)[0].decidedAt || '').slice(0, 10), players: (t.seeds || (t.groups || []).flatMap(groupIds)).filter(Boolean) }));
  /** Your PIN, with the wrong-PIN lockout. Throws wrong_pin / locked. */
  const checkPin = async (s, user, pin) => {
    const f = s.fails[user.username] || { count: 0, lockedUntil: 0 };
    if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: Math.ceil((f.lockedUntil - Date.now()) / 1000) });
    const expected = user.pin_hash || (await sha256(`${SALT}:${user.id}:${user.seed_pin}`));
    if (!/^\d{4}$/.test(String(pin)) || (await sha256(`${SALT}:${user.id}:${pin}`)) !== expected) {
      f.count += 1;
      if (f.count >= MAX_TRIES) Object.assign(f, { count: 0, lockedUntil: Date.now() + LOCK_MS });
      s.fails[user.username] = f;
      save(s);
      if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: LOCK_MS / 1000 });
      throw new ApiError('That PIN is wrong.', 'wrong_pin', { triesLeft: MAX_TRIES - f.count });
    }
    delete s.fails[user.username];
  };
  const clean = (g) => Object.fromEntries(Object.entries(g).filter(([k]) => !k.startsWith('_')));
  const session = (s, userId) => {
    const token = uuid();
    s.sessions[token] = userId;
    return token;
  };

  return {
    async signUp(username, displayName, pin) {
      await net();
      const s = load();
      const name = String(username || '').trim().toLowerCase();
      const display = niceName(displayName);
      if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw new ApiError('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
      if (!display || display.length > 24) throw new ApiError('Enter a name up to 24 characters.', 'invalid');
      if (!/^\d{4}$/.test(String(pin))) throw new ApiError('Your PIN must be 4 digits.', 'invalid');
      if (s.users.some((u) => u.username === name)) throw new ApiError('That username is taken.', 'taken');
      const id = `u_${uuid().replace(/-/g, '').slice(0, 16)}`;
      const h = [...name].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0);
      const user = { id, username: name, display_name: display, color: COLORS[Math.abs(h) % COLORS.length], initial: display[0].toUpperCase(), pin_hash: await sha256(`${SALT}:${id}:${pin}`), created_at: new Date().toISOString() };
      s.users.push(user);
      const token = session(s, id);
      save(s);
      return { token, user: pub(user), friends: [], games: [] };
    },

    async signIn(username, pin) {
      await net();
      const s = load();
      const name = String(username || '').trim().toLowerCase();
      const f = s.fails[name] || { count: 0, lockedUntil: 0 };
      if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: Math.ceil((f.lockedUntil - Date.now()) / 1000) });
      const user = s.users.find((u) => u.username === name);
      const expected = user && (user.pin_hash || (await sha256(`${SALT}:${user.id}:${user.seed_pin}`)));
      const ok = user && /^\d{4}$/.test(String(pin)) && (await sha256(`${SALT}:${user.id}:${pin}`)) === expected;
      if (!ok) {
        f.count += 1;
        if (f.count >= MAX_TRIES) Object.assign(f, { count: 0, lockedUntil: Date.now() + LOCK_MS });
        s.fails[name] = f;
        save(s);
        if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: LOCK_MS / 1000 });
        throw new ApiError('Wrong username or PIN.', 'auth', { triesLeft: MAX_TRIES - f.count });
      }
      delete s.fails[name];
      const token = session(s, user.id);
      save(s);
      return { token, user: pub(user), ...snapshot(s, user.id) };
    },

    async bootstrap(token) {
      await net();
      const s = load();
      const user = me(s, token);
      return { me: pub(user), ...snapshot(s, user.id) };
    },

    async signOut(token) {
      await delay();
      const s = load();
      delete s.sessions[token];
      save(s);
      return {};
    },

    async getMe(token) {
      await net();
      return pub(me(load(), token));
    },

    async updateProfile(token, { username, displayName, avatar } = {}) {
      await net();
      const s = load();
      const user = me(s, token);
      if (username != null) {
        const name = String(username).trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw new ApiError('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
        if (s.users.some((u) => u.username === name && u.id !== user.id)) throw new ApiError('That username is taken.', 'taken');
        user.username = name;
      }
      if (displayName != null) {
        const display = niceName(displayName);
        if (!display || display.length > 24) throw new ApiError('Enter a name up to 24 characters.', 'invalid');
        user.display_name = display;
        user.initial = display[0].toUpperCase();
      }
      if (avatar != null) {
        if (avatar && !/^a\d{2}$/.test(avatar)) throw new ApiError('Pick one of the avatars.', 'invalid');
        user.avatar = avatar;
      }
      save(s);
      return pub(user);
    },

    async changePin(token, currentPin, newPin) {
      await net();
      const s = load();
      const user = me(s, token);
      if (!/^\d{4}$/.test(String(newPin))) throw new ApiError('Your new PIN must be 4 digits.', 'invalid');
      const f = s.fails[user.username] || { count: 0, lockedUntil: 0 };
      if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: Math.ceil((f.lockedUntil - Date.now()) / 1000) });
      const expected = user.pin_hash || (await sha256(`${SALT}:${user.id}:${user.seed_pin}`));
      if ((await sha256(`${SALT}:${user.id}:${currentPin}`)) !== expected) {
        f.count += 1;
        if (f.count >= MAX_TRIES) Object.assign(f, { count: 0, lockedUntil: Date.now() + LOCK_MS });
        s.fails[user.username] = f;
        save(s);
        if (f.lockedUntil > Date.now()) throw new ApiError('Too many attempts.', 'locked', { retryAfter: LOCK_MS / 1000 });
        throw new ApiError('Your current PIN is wrong.', 'wrong_pin', { triesLeft: MAX_TRIES - f.count });
      }
      delete s.fails[user.username];
      user.pin_hash = await sha256(`${SALT}:${user.id}:${newPin}`);
      delete user.seed_pin;
      for (const [t, id] of Object.entries(s.sessions)) if (id === user.id) delete s.sessions[t]; // sign out other devices
      const newToken = session(s, user.id);
      save(s);
      return { token: newToken };
    },

    async getFriends(token) {
      await net();
      const s = load();
      const ids = friendIds(s, me(s, token).id);
      return s.users.filter((u) => ids.includes(u.id)).map(pub);
    },

    async searchUsers(token, query) {
      await net();
      const s = load();
      const user = me(s, token);
      const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
      if (q.length < 2) return [];
      const ids = friendIds(s, user.id);
      const hidden = blockedEitherWay(s, user.id);
      return s.users
        .filter((u) => u.id !== user.id && !hidden.includes(u.id) && (u.username.includes(q) || u.display_name.toLowerCase().includes(q)))
        .slice(0, 20)
        .map((u) => ({ ...pub(u), isFriend: ids.includes(u.id) }));
    },

    async addFriend(token, userId) {
      await net();
      const s = load();
      const user = me(s, token);
      const other = s.users.find((u) => u.id === userId);
      if (!other || other.id === user.id) throw new ApiError('Pick someone else to add.', 'invalid');
      if (blockedEitherWay(s, user.id).includes(userId)) throw new ApiError('You can’t add this person.', 'invalid');
      if (!friendIds(s, user.id).includes(userId)) {
        const [a, b] = [user.id, userId].sort();
        s.friendships.push({ id: uuid(), user_a: a, user_b: b, created_at: new Date().toISOString() });
        save(s);
      }
      return pub(other);
    },

    async removeFriend(token, userId) {
      await net();
      const s = load();
      unfriend(s, me(s, token).id, userId);
      save(s);
      return {};
    },

    async blockUser(token, userId) {
      await net();
      const s = load();
      const user = me(s, token);
      if (!userId || userId === user.id) throw new ApiError('Pick someone else to block.', 'invalid');
      unfriend(s, user.id, userId);
      s.blocks = s.blocks || [];
      if (!s.blocks.some((b) => b.blocker === user.id && b.blocked === userId)) s.blocks.push({ id: uuid(), blocker: user.id, blocked: userId, created_at: new Date().toISOString() });
      save(s);
      return {};
    },

    async unblockUser(token, userId) {
      await net();
      const s = load();
      const user = me(s, token);
      s.blocks = (s.blocks || []).filter((b) => !(b.blocker === user.id && b.blocked === userId));
      save(s);
      return {};
    },

    async getBlocked(token) {
      await net();
      const s = load();
      const user = me(s, token);
      const ids = (s.blocks || []).filter((b) => b.blocker === user.id).map((b) => b.blocked);
      return s.users.filter((u) => ids.includes(u.id)).map(pub);
    },

    async getProfile(token, userId) {
      await net();
      const s = load();
      const user = me(s, token);
      const id = userId || user.id;
      if (id !== user.id && !friendIds(s, user.id).includes(id)) throw new ApiError('You can only see your friends’ profiles.', 'invalid');
      const target = s.users.find((u) => u.id === id);
      if (!target) throw new ApiError('That user no longer exists.', 'invalid');
      const games = s.games.filter((g) => !g.deleted && (g.player1_id === id || g.player2_id === id));
      const oppIds = new Set(games.map((g) => (g.player1_id === id ? g.player2_id : g.player1_id)));
      return { user: pub(target), opponents: s.users.filter((u) => oppIds.has(u.id)).map(pub), games };
    },

    async getGames(token) {
      await net();
      const s = load();
      const id = me(s, token).id;
      return s.games.filter((g) => !g.deleted && (g.player1_id === id || g.player2_id === id));
    },

    async addGame(token, game) {
      await net();
      const s = load();
      const user = me(s, token);
      const g = clean(game);
      let allowed = friendIds(s, user.id);
      if (g.tournament_id) {
        // A tournament game: both players are in the bracket (they don't have to be friends)
        const t = (s.tournaments || []).find((x) => x.id === g.tournament_id);
        const placed = t ? t.seeds || (t.groups || []).flatMap(groupIds) : [];
        if (!t || t.status !== 'live' || !placed.includes(g.player1_id) || !placed.includes(g.player2_id) || t.sport !== (g.sport || '2k')) {
          throw new ApiError('That game can’t count for this tournament.', 'invalid');
        }
        allowed = [...allowed, ...placed.filter(Boolean)];
      }
      const err = validateGame(g, user.id, allowed);
      if (err) throw new ApiError(err, 'invalid');
      const now = new Date().toISOString();
      const i = s.games.findIndex((x) => x.id === g.id);
      const stored = { ...g, created_by: i === -1 ? user.id : s.games[i].created_by, created_at: i === -1 ? now : s.games[i].created_at, updated_at: now, deleted: false };
      if (i === -1) s.games.push(stored);
      else s.games[i] = stored; // retry of an add that already landed
      save(s);
      return stored;
    },

    async updateGame(token, game) {
      await net();
      const s = load();
      const user = me(s, token);
      const g = clean(game);
      const i = s.games.findIndex((x) => x.id === g.id);
      if (i === -1) throw new ApiError('That game no longer exists.', 'invalid');
      const prev = s.games[i];
      if (prev.player1_id !== user.id && prev.player2_id !== user.id) throw new ApiError('You can only change your own games.', 'invalid');
      const err = validateGame(g, user.id, friendIds(s, user.id));
      if (err) throw new ApiError(err, 'invalid');
      s.games[i] = { ...prev, ...g, created_by: prev.created_by, created_at: prev.created_at, updated_at: new Date().toISOString(), deleted: Boolean(g.deleted) };
      save(s);
      return s.games[i];
    },

    async deleteGame(token, id) {
      await net();
      const s = load();
      const user = me(s, token);
      const g = s.games.find((x) => x.id === id);
      if (g && (g.player1_id === user.id || g.player2_id === user.id)) Object.assign(g, { deleted: true, updated_at: new Date().toISOString() });
      save(s);
      return { id };
    },

    // ----- change requests (same rules as the server) -----

    async requestChange(token, { kind, game, id }) {
      await net();
      const s = load();
      const user = me(s, token);
      s.requests ||= [];
      const gameId = kind === 'edit' ? game?.id : id;
      const prev = s.games.find((x) => x.id === gameId && !x.deleted);
      if (!prev) throw new ApiError('That game no longer exists.', 'invalid');
      if (prev.player1_id !== user.id && prev.player2_id !== user.id) throw new ApiError('You can only change your own games.', 'invalid');
      if (kind === 'edit') {
        const err = validateGame(clean(game), user.id, friendIds(s, user.id));
        if (err) throw new ApiError(err, 'invalid');
      }
      const open = s.requests.filter((r) => r.game_id === gameId && r.status === 'pending');
      if (open.some((r) => r.from_id !== user.id)) throw new ApiError('Your friend already asked to change this game. Answer that first in Notifications.', 'invalid');
      const request = {
        id: open[0]?.id || uuid(),
        game_id: gameId,
        from_id: user.id,
        to_id: prev.player1_id === user.id ? prev.player2_id : prev.player1_id,
        kind,
        game: kind === 'edit' ? clean(game) : null,
        status: 'pending',
        created_at: new Date().toISOString(),
        resolved_at: '',
      };
      s.requests = [...s.requests.filter((r) => r.id !== request.id), request];
      save(s);
      return request;
    },

    async respondRequest(token, requestId, approve) {
      await net();
      const s = load();
      const user = me(s, token);
      const r = (s.requests || []).find((x) => x.id === requestId);
      if (!r || r.status !== 'pending') throw new ApiError('This request was already answered or cancelled.', 'invalid');
      if (r.to_id !== user.id) throw new ApiError('Only your friend can answer this request.', 'invalid');
      const now = new Date().toISOString();
      if (approve) {
        const g = s.games.find((x) => x.id === r.game_id);
        if (!g) throw new ApiError('That game no longer exists.', 'invalid');
        if (r.kind === 'delete') Object.assign(g, { deleted: true, updated_at: now });
        else Object.assign(g, { ...r.game, created_by: g.created_by, created_at: g.created_at, updated_at: now, deleted: false });
      }
      Object.assign(r, { status: approve ? 'approved' : 'declined', resolved_at: now });
      save(s);
      return {};
    },

    async cancelRequest(token, requestId) {
      await net();
      const s = load();
      const user = me(s, token);
      const r = (s.requests || []).find((x) => x.id === requestId);
      if (r && r.status === 'pending') {
        if (r.from_id !== user.id) throw new ApiError('Only the person who asked can cancel this.', 'invalid');
        Object.assign(r, { status: 'cancelled', resolved_at: new Date().toISOString() });
        save(s);
      }
      return {};
    },

    // ----- account deletion -----

    async verifyPin(token, pin) {
      await net();
      const s = load();
      await checkPin(s, me(s, token), pin);
      return {};
    },

    async deleteAccount(token, pin) {
      await net();
      const s = load();
      const user = me(s, token);
      await checkPin(s, user, pin);
      const id = user.id;
      s.friendships = s.friendships.filter((f) => f.user_a !== id && f.user_b !== id);
      s.blocks = (s.blocks || []).filter((b) => b.blocker !== id && b.blocked !== id);
      s.requests = (s.requests || []).filter((r) => r.from_id !== id && r.to_id !== id);
      s.games.forEach((g) => (g.player1_id === id || g.player2_id === id) && Object.assign(g, { deleted: true }));
      s.users = s.users.filter((u) => u.id !== id);
      for (const [t, uid] of Object.entries(s.sessions)) if (uid === id) delete s.sessions[t];
      save(s);
      return {};
    },

    // ---------- tournaments (same rules as the Firebase version) ----------

    async createTournament(token, opts = {}) {
      await net();
      const s = load();
      const user = me(s, token);
      const title = cleanName(opts.name);
      if (!title) throw new ApiError('Give the tournament a name (up to 40 characters).', 'invalid');
      const invited = [...new Set((opts.players || []).filter((id) => id && id !== user.id))];
      if (invited.length + 1 < MIN_PLAYERS) throw new ApiError(`Invite at least ${MIN_PLAYERS - 1} friends.`, 'invalid');
      if (invited.length + 1 > MAX_PLAYERS) throw new ApiError(`A tournament can have up to ${MAX_PLAYERS} players.`, 'invalid');
      if (invited.some((id) => !friendIds(s, user.id).includes(id))) throw new ApiError('You can only invite your friends.', 'invalid');
      const t = {
        id: uuid(),
        name: title,
        ...cleanSettings(opts),
        creator: user.id,
        created_at: new Date().toISOString(),
        status: 'inviting',
        players: [user.id, ...invited],
        answers: Object.fromEntries([[user.id, 'accepted'], ...invited.map((id) => [id, 'pending'])]),
        invited_by: Object.fromEntries(invited.map((id) => [id, user.id])),
        seeds: null,
        groups: null,
        decisions: {},
        nudges: {},
        started_at: '',
      };
      t.people = Object.fromEntries(t.players.map((id) => [id, profileOf(s, id)]));
      (s.tournaments ||= []).push(t);
      save(s);
      return t;
    },

    async updateTournament(token, id, patch = {}) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = hostTour(s, id, user.id, 'inviting');
      const title = patch.name != null ? cleanName(patch.name) : t.name;
      if (!title) throw new ApiError('Give the tournament a name (up to 40 characters).', 'invalid');
      Object.assign(t, { name: title, ...cleanSettings({ ...t, ...patch }) });
      save(s);
      return {};
    },

    async inviteToTournament(token, id, players) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id);
      if (!t || t.status !== 'inviting') throw new ApiError('This tournament has already started or was cancelled.', 'invalid');
      if (t.answers[user.id] !== 'accepted') throw new ApiError('Join the tournament first, then invite your friends.', 'invalid');
      const fresh = [...new Set(players || [])].filter((p) => p && !t.players.includes(p));
      if (fresh.some((p) => !friendIds(s, user.id).includes(p))) throw new ApiError('You can only invite your friends.', 'invalid');
      if (t.players.length + fresh.length > MAX_PLAYERS) throw new ApiError(`A tournament can have up to ${MAX_PLAYERS} players.`, 'invalid');
      for (const p of fresh) addInvite(t, p, user.id, s);
      save(s);
      return {};
    },

    async respondTournament(token, id, accept) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id && x.players.includes(user.id));
      if (!t || t.status !== 'inviting') throw new ApiError('This tournament has already started or was cancelled.', 'invalid');
      if (t.creator === user.id) throw new ApiError('You’re the host. Cancel the tournament instead.', 'invalid');
      t.answers[user.id] = accept ? 'accepted' : 'declined';
      if (t.auto_start && allAnswered(t) && accepted(t).length >= MIN_PLAYERS) startNow(s, t);
      save(s);
      return {};
    },

    async startTournament(token, id, layout = null) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = hostTour(s, id, user.id, 'inviting');
      if (accepted(t).length < MIN_PLAYERS) throw new ApiError(`At least ${MIN_PLAYERS} players need to join first.`, 'invalid');
      if (t.draw === 'custom') {
        const problem = layout ? checkLayout(t, layout, accepted(t)) : 'Set up the bracket first.';
        if (problem) throw new ApiError(problem, 'invalid');
      }
      startNow(s, t, t.draw === 'custom' ? layout : null);
      save(s);
      return {};
    },

    async cancelTournament(token, id) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id);
      if (!t || hostOf(t) !== user.id) throw new ApiError('Only the host can do that.', 'invalid');
      Object.assign(t, { status: 'cancelled', cancelled_at: new Date().toISOString() });
      save(s);
      return {};
    },

    async quitTournament(token, id) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id && x.players.includes(user.id));
      if (!t) return {};
      if (t.status === 'inviting') {
        if (t.creator === user.id) throw new ApiError('You’re the host. Cancel the tournament instead.', 'invalid');
        t.answers[user.id] = 'declined';
      } else if (t.status === 'live' && t.answers[user.id] === 'accepted') {
        const next = nextHost(t, user.id);
        if (next) t.host = next;
        else if (hostOf(t) === user.id) Object.assign(t, { status: 'cancelled', cancelled_at: new Date().toISOString() });
        t.answers[user.id] = 'left';
        (t.left ||= {})[user.id] = new Date().toISOString();
      }
      save(s);
      return {};
    },

    async decideSeries(token, id, key, winner) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = hostTour(s, id, user.id, 'live');
      t.decisions ||= {};
      if (winner) t.decisions[key] = { winner, at: new Date().toISOString() };
      else delete t.decisions[key];
      save(s);
      return {};
    },

    async replacePlayer(token, id, oldId, newId) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = hostTour(s, id, user.id, 'live');
      const placed = t.seeds || (t.groups || []).flatMap(groupIds);
      if (!placed.includes(oldId)) throw new ApiError('That player isn’t in the bracket.', 'invalid');
      if (placed.includes(newId)) throw new ApiError('They’re already in it.', 'invalid');
      if (!friendIds(s, user.id).includes(newId)) throw new ApiError('You can only bring in your friends.', 'invalid');
      const swap = (x) => (x === oldId ? newId : x);
      if (t.seeds) t.seeds = t.seeds.map(swap);
      else t.groups = t.groups.map((g) => ({ ids: groupIds(g).map(swap) }));
      if (!t.players.includes(newId)) t.players.push(newId);
      t.answers[newId] = 'accepted';
      (t.invited_by ||= {})[newId] = user.id;
      t.people[newId] = profileOf(s, newId);
      (t.replaced ||= {})[oldId] = newId;
      save(s);
      return {};
    },

    async nudge(token, id, toId) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id && x.status === 'live');
      if (!t || !t.players.includes(user.id) || !t.players.includes(toId)) throw new ApiError('You’re not both in this tournament.', 'invalid');
      const last = t.nudges?.[toId];
      if (last?.from === user.id && Date.now() - Date.parse(last.at) < 3600000) throw new ApiError('You nudged them less than an hour ago.', 'invalid');
      (t.nudges ||= {})[toId] = { from: user.id, at: new Date().toISOString() };
      save(s);
      return {};
    },

    async recordTrophy() {
      return {}; // the demo works trophies out from the tournaments themselves
    },

    async playerRecords(token, ids, sport) {
      await delay();
      const s = load();
      return Object.fromEntries(ids.map((id) => [id, recordOf(id, s.games, sport)]));
    },

    /** Demo only: plays out every game you're not in that's ready (group games, then series). */
    async demoSimulate(token, id) {
      await net();
      const s = load();
      const user = me(s, token);
      const t = (s.tournaments || []).find((x) => x.id === id && x.status === 'live');
      if (!t) return { played: 0 };
      const teams = teamsFor(t.sport).map((x) => x.key);
      const pick = () => teams[Math.floor(Math.random() * teams.length)];
      const fifa = t.sport === 'fifa';
      let played = 0;
      const play = (a, b, stage) => {
        const hi = fifa ? 1 + Math.floor(Math.random() * 4) : 90 + Math.floor(Math.random() * 30);
        const lo = Math.max(0, hi - 1 - Math.floor(Math.random() * (fifa ? hi : 12)));
        const aWins = Math.random() < 0.5;
        const stamp = new Date(Date.now() + played).toISOString();
        s.games.push({
          id: uuid(), sport: t.sport, date: stamp.slice(0, 10), overtime: false, note: '', player1_id: a, player2_id: b,
          player1_score: aWins ? hi : lo, player2_score: aWins ? lo : hi, player1_team: pick(), player2_team: pick(), player1_pens: '', player2_pens: '',
          tournament_id: t.id, ...(stage ? { tournament_stage: stage } : {}), created_by: a, created_at: stamp, updated_at: stamp, deleted: false,
        });
        played++;
      };
      for (let guard = 0; guard < 300; guard++) {
        const b = buildBracket(t, s.games);
        if (b.stage === 'groups') {
          const pair = b.groups.flatMap((g) => g.pairs).find((p) => !p.done && p.a !== user.id && p.b !== user.id);
          if (!pair) break;
          play(pair.a, pair.b, 'group');
          continue;
        }
        const ready = b.rounds.flat().find((m) => m.winner === undefined && m.a && m.b && m.a !== user.id && m.b !== user.id);
        if (!ready) break;
        play(ready.a, ready.b, null);
      }
      save(s);
      return { played };
    },
  };
}
