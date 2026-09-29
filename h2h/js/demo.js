// Demo backend: used when config.js has no Apps Script URL. It mirrors the real server's
// behaviour (sign-up, hashed PINs, sessions, lockout after 5 wrong tries, instant friends,
// friend-only games, soft deletes, validation, network latency) but stores everything in
// this browser.
import { uuid, sha256 } from './crypto.js';
import { getTeam } from './teams.js';
import { generateSampleGames } from './sample.js';

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
];
const SEED_FRIENDS = [['u_alex', 'u_sam'], ['u_alex', 'u_jordan'], ['u_riley', 'u_sam']];

const sampleGames = () => [
  ...generateSampleGames('u_alex', 'u_sam'),
  ...generateSampleGames('u_alex', 'u_jordan', { count: 12, seed: 7, startDaysAgo: 3, script: [false, true, true] }),
  ...generateSampleGames('u_sam', 'u_riley', { count: 9, seed: 99, startDaysAgo: 2 }),
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
  save(fresh);
  return fresh;
}
const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));


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
  const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
  if (![s1, s2].every((n) => Number.isInteger(n) && n >= 0 && n <= 999)) return 'Enter both scores.';
  if (s1 === s2) return 'Basketball has no ties. Someone has to win.';
  if (!getTeam(g.player1_team) || !getTeam(g.player2_team)) return 'Choose both teams.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date || '')) return 'Choose a date.';
  return null;
}

export function createDemoBackend(ApiError) {
  const delay = () => new Promise((r) => setTimeout(r, LATENCY));
  const net = async () => {
    await delay();
    if (controls.offline || !navigator.onLine) throw new ApiError('You’re offline.', 'network');
  };
  const pub = ({ id, username, display_name, color, initial }) => ({ id, username, display_name, color, initial });
  const me = (s, token) => {
    const user = s.users.find((u) => u.id === s.sessions[token]);
    if (!user) throw new ApiError('Your session has ended. Sign in again.', 'auth');
    return user;
  };
  const blockedEitherWay = (s, id) => (s.blocks || []).filter((b) => b.blocker === id || b.blocked === id).map((b) => (b.blocker === id ? b.blocked : b.blocker));
  const unfriend = (s, a, b) => (s.friendships = s.friendships.filter((f) => !((f.user_a === a && f.user_b === b) || (f.user_a === b && f.user_b === a))));
  const friendIds = (s, id) => s.friendships.filter((f) => f.user_a === id || f.user_b === id).map((f) => (f.user_a === id ? f.user_b : f.user_a));
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
      const display = String(displayName || '').trim().replace(/\s+/g, ' ');
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
      return { token, user: pub(user) };
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
      return { token, user: pub(user) };
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

    async updateProfile(token, { username, displayName } = {}) {
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
        const display = String(displayName).trim().replace(/\s+/g, ' ');
        if (!display || display.length > 24) throw new ApiError('Enter a name up to 24 characters.', 'invalid');
        user.display_name = display;
        user.initial = display[0].toUpperCase();
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
      const err = validateGame(g, user.id, friendIds(s, user.id));
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
  };
}
