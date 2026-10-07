// Firebase backend (Auth + Cloud Firestore) behind the same interface as the Google Sheets one
// (see api.js). The security rules in firestore.rules enforce who may read and write what; the
// checks here just give friendly messages first.
//
// Accounts: you still sign in with a username and 4-digit PIN. Behind the scenes each player has a
// Firebase Auth account "<userId>@users.hoophead.xyz" whose password is derived from the PIN.
// Players who existed in the Google Sheet were copied over with the same ids; the first time they
// sign in here, the old Apps Script checks their PIN once and sets their Firebase password ("claim").
import { FIREBASE_CONFIG } from '../firebase-config.js';
import { CONFIG } from '../config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.3.0';
const EMAIL_DOMAIN = 'users.hoophead.xyz';
const AVATAR_COLORS = ['#5856D6', '#C93400', '#007A5E', '#A2338A', '#0060C7', '#8A5A00', '#B0263A', '#3D6591'];
const REQUEST_DAYS = 14;

const emailOf = (userId) => `${userId}@${EMAIL_DOMAIN}`;
const passwordOf = (pin, userId) => `dubs:${pin}:${userId}`; // Firebase needs 6+ characters
const idOf = (user) => String(user?.email || '').split('@')[0];
const now = () => new Date().toISOString();
const pairId = (a, b) => (a < b ? `${a}__${b}` : `${b}__${a}`);
const niceName = (name) => String(name || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)(\S)/g, (m, sp, ch) => sp + ch.toUpperCase());
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export function createFirebaseBackend(ApiError) {
  // ---------- SDK (loaded on first use) ----------

  let sdk = null;
  function load() {
    sdk ||= (async () => {
      const [app, auth, fs] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]);
      const firebaseApp = app.initializeApp(FIREBASE_CONFIG);
      const a = auth.getAuth(firebaseApp);
      const db = fs.getFirestore(firebaseApp);
      // Wait until Firebase has restored any saved sign-in before answering "who am I"
      await new Promise((resolve) => {
        const off = auth.onAuthStateChanged(a, () => (off(), resolve()));
      });
      return { ...auth, ...fs, auth: a, db };
    })().catch((err) => {
      sdk = null; // let the next call try again (e.g. after coming back online)
      throw err;
    });
    return sdk;
  }

  /** Runs `fn` with the SDK, turning Firebase errors into the app's ApiError codes. */
  async function run(fn) {
    if (!navigator.onLine) throw new ApiError('You’re offline.', 'network');
    let f;
    try {
      f = await load();
    } catch {
      throw new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout');
    }
    try {
      return await fn(f);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw translate(err);
    }
  }

  function translate(err) {
    const code = String(err?.code || '');
    if (code === 'auth/too-many-requests') return new ApiError('Too many attempts.', 'locked', { retryAfter: 300 });
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      return new ApiError('Wrong username or PIN.', 'auth');
    }
    if (code === 'auth/network-request-failed' || code === 'unavailable' || code === 'deadline-exceeded') {
      return navigator.onLine ? new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout') : new ApiError('You’re offline.', 'network');
    }
    if (code === 'unauthenticated' || code === 'auth/user-token-expired' || code === 'auth/user-disabled') {
      return new ApiError('Your session has ended. Sign in again.', 'auth');
    }
    if (code === 'permission-denied') return new ApiError('That isn’t allowed.', 'invalid');
    console.error(err);
    return new ApiError(err?.message || 'Something went wrong.', 'server');
  }

  /** The signed-in player's id, or an 'auth' error. */
  function meOf(f) {
    const user = f.auth.currentUser;
    const id = idOf(user);
    if (!user || !id) throw new ApiError('Your session has ended. Sign in again.', 'auth');
    return id;
  }

  const ref = (f, coll, id) => f.doc(f.db, coll, id);
  const pub = (id, u) => ({
    id,
    username: u.username,
    display_name: niceName(u.display_name),
    color: u.color || '#5856D6',
    initial: String(u.initial || niceName(u.display_name)[0] || '?').toUpperCase(),
    avatar: u.avatar || '',
  });
  async function userDoc(f, id) {
    const snap = await f.getDoc(ref(f, 'users', id));
    return snap.exists() ? pub(id, snap.data()) : null;
  }
  async function usersByIds(f, ids) {
    const unique = [...new Set(ids)].filter(Boolean);
    const out = [];
    for (const part of chunk(unique, 30)) {
      const snap = await f.getDocs(f.query(f.collection(f.db, 'users'), f.where(f.documentId(), 'in', part)));
      snap.forEach((d) => out.push(pub(d.id, d.data())));
    }
    return out;
  }
  async function where(f, coll, field, op, value) {
    const snap = await f.getDocs(f.query(f.collection(f.db, coll), f.where(field, op, value)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function friendIdsOf(f, me) {
    const [a, b] = await Promise.all([where(f, 'friendships', 'user_a', '==', me), where(f, 'friendships', 'user_b', '==', me)]);
    return [...a.map((x) => x.user_b), ...b.map((x) => x.user_a)];
  }
  async function blockedEitherWay(f, me) {
    const [mine, theirs] = await Promise.all([where(f, 'blocks', 'blocker', '==', me), where(f, 'blocks', 'blocked', '==', me)]);
    return [...mine.map((b) => b.blocked), ...theirs.map((b) => b.blocker)];
  }
  /** Games as the app expects them (the Firestore-only fields are harmless extras). */
  const gameOut = (g) => ({ ...g, overtime: Boolean(g.overtime), deleted: Boolean(g.deleted), sport: g.sport === 'fifa' ? 'fifa' : '2k' });
  async function gamesOf(f, userId) {
    return (await where(f, 'games', 'players', 'array-contains', userId)).filter((g) => !g.deleted).map(gameOut);
  }
  async function requestsOf(f, me) {
    const since = new Date(Date.now() - REQUEST_DAYS * 86400000).toISOString();
    const [from, to] = await Promise.all([where(f, 'requests', 'from_id', '==', me), where(f, 'requests', 'to_id', '==', me)]);
    return [...from, ...to].filter((r) => r.status === 'pending' || ((r.status === 'approved' || r.status === 'declined') && String(r.resolved_at) >= since));
  }
  async function snapshot(f, me) {
    const [meUser, friendIds, games, requests] = await Promise.all([userDoc(f, me), friendIdsOf(f, me), gamesOf(f, me), requestsOf(f, me)]);
    if (!meUser) throw new ApiError('This account no longer exists.', 'auth');
    return { me: meUser, friends: await usersByIds(f, friendIds), games, requests };
  }

  // ---------- accounts ----------

  /** First sign-in after the move: the old Apps Script checks the PIN and sets the Firebase password. */
  async function claim(username, pin) {
    if (!CONFIG.APPS_SCRIPT_URL) throw new ApiError('Wrong username or PIN.', 'auth');
    let res;
    try {
      res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'claimFirebase', username, pin }),
        redirect: 'follow',
      });
    } catch {
      throw new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout');
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout');
    }
    if (!json.ok) throw new ApiError(json.error || 'Wrong username or PIN.', json.code || 'auth', json);
  }

  async function signIn(username, pin) {
    const name = String(username || '').trim().toLowerCase().replace(/^@/, '');
    return run(async (f) => {
      if (!/^\d{4}$/.test(String(pin))) throw new ApiError('Wrong username or PIN.', 'auth');
      const entry = await f.getDoc(ref(f, 'usernames', name));
      if (!entry.exists()) throw new ApiError('Wrong username or PIN.', 'auth');
      const { userId, claimed } = entry.data();
      try {
        await f.signInWithEmailAndPassword(f.auth, emailOf(userId), passwordOf(pin, userId));
      } catch (err) {
        const wrong = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(err?.code);
        if (!wrong || claimed) throw err;
        await claim(name, pin); // moved from the Google Sheet and not signed in here yet
        await f.signInWithEmailAndPassword(f.auth, emailOf(userId), passwordOf(pin, userId));
      }
      const data = await snapshot(f, userId);
      return { token: userId, user: data.me, friends: data.friends, games: data.games, requests: data.requests };
    });
  }

  async function signUp(username, displayName, pin) {
    const name = String(username || '').trim().toLowerCase();
    const display = niceName(displayName);
    if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw new ApiError('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
    if (!display || display.length > 24) throw new ApiError('Enter a name up to 24 characters.', 'invalid');
    if (!/^\d{4}$/.test(String(pin))) throw new ApiError('Your PIN must be 4 digits.', 'invalid');
    return run(async (f) => {
      if ((await f.getDoc(ref(f, 'usernames', name))).exists()) throw new ApiError('That username is taken.', 'taken');
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const id = `u_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const cred = await f.createUserWithEmailAndPassword(f.auth, emailOf(id), passwordOf(pin, id));
      const h = [...name].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0);
      const profile = { username: name, display_name: display, color: AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length], initial: display[0].toUpperCase(), avatar: '', created_at: now() };
      try {
        const batch = f.writeBatch(f.db);
        batch.set(ref(f, 'users', id), profile);
        batch.set(ref(f, 'usernames', name), { userId: id, claimed: true });
        await batch.commit();
      } catch (err) {
        await f.deleteUser(cred.user).catch(() => {}); // don't leave a login with no profile
        if (err?.code === 'permission-denied') throw new ApiError('That username is taken.', 'taken');
        throw err;
      }
      return { token: id, user: pub(id, profile), friends: [], games: [], requests: [] };
    });
  }

  const signOut = () => run((f) => f.signOut(f.auth)).catch(() => ({}));

  async function reauth(f, pin) {
    const id = meOf(f);
    try {
      await f.reauthenticateWithCredential(f.auth.currentUser, f.EmailAuthProvider.credential(emailOf(id), passwordOf(pin, id)));
    } catch (err) {
      if (err?.code === 'auth/too-many-requests') throw new ApiError('Too many attempts.', 'locked', { retryAfter: 300 });
      if (['auth/invalid-credential', 'auth/wrong-password'].includes(err?.code)) throw new ApiError('That PIN is wrong.', 'wrong_pin');
      throw err;
    }
    return id;
  }

  async function updateProfile(token, { username, displayName, avatar } = {}) {
    return run(async (f) => {
      const id = meOf(f);
      const snap = await f.getDoc(ref(f, 'users', id));
      if (!snap.exists()) throw new ApiError('This account no longer exists.', 'auth');
      const next = { ...snap.data() };
      const batch = f.writeBatch(f.db);
      if (username != null) {
        const name = String(username).trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_.]{3,20}$/.test(name)) throw new ApiError('Usernames are 3–20 letters, numbers, dots or underscores.', 'invalid');
        if (name !== next.username) {
          if ((await f.getDoc(ref(f, 'usernames', name))).exists()) throw new ApiError('That username is taken.', 'taken');
          batch.set(ref(f, 'usernames', name), { userId: id, claimed: true });
          batch.delete(ref(f, 'usernames', next.username));
          next.username = name;
        }
      }
      if (displayName != null) {
        const display = niceName(displayName);
        if (!display || display.length > 24) throw new ApiError('Enter a name up to 24 characters.', 'invalid');
        next.display_name = display;
        next.initial = display[0].toUpperCase();
      }
      if (avatar != null) {
        if (avatar && !/^a\d{2}$/.test(avatar)) throw new ApiError('Pick one of the avatars.', 'invalid');
        next.avatar = avatar;
      }
      batch.set(ref(f, 'users', id), next);
      await batch.commit();
      return pub(id, next);
    });
  }

  async function changePin(token, currentPin, newPin) {
    if (!/^\d{4}$/.test(String(newPin))) throw new ApiError('Your new PIN must be 4 digits.', 'invalid');
    return run(async (f) => {
      const id = await reauth(f, currentPin).catch((e) => {
        throw e.code === 'wrong_pin' ? new ApiError('Your current PIN is wrong.', 'wrong_pin') : e;
      });
      await f.updatePassword(f.auth.currentUser, passwordOf(newPin, id)); // signs out your other devices
      return { token: id };
    });
  }

  const verifyPin = (token, pin) => run(async (f) => (await reauth(f, pin), {}));

  /**
   * Deletes your account: profile and username first (so the rules know you're leaving), then your
   * friendships, blocks and requests, then your games are hidden from everyone's stats. Finally
   * the login itself.
   */
  async function deleteAccount(token, pin) {
    return run(async (f) => {
      const id = await reauth(f, pin);
      const profile = await f.getDoc(ref(f, 'users', id));
      const [friendsA, friendsB, blocksMine, blocksTheirs, reqFrom, reqTo, games] = await Promise.all([
        where(f, 'friendships', 'user_a', '==', id),
        where(f, 'friendships', 'user_b', '==', id),
        where(f, 'blocks', 'blocker', '==', id),
        where(f, 'blocks', 'blocked', '==', id),
        where(f, 'requests', 'from_id', '==', id),
        where(f, 'requests', 'to_id', '==', id),
        where(f, 'games', 'players', 'array-contains', id),
      ]);
      const first = f.writeBatch(f.db);
      first.delete(ref(f, 'users', id));
      if (profile.exists()) first.delete(ref(f, 'usernames', profile.data().username));
      await first.commit();
      const ops = [
        ...[...friendsA, ...friendsB].map((x) => (b) => b.delete(ref(f, 'friendships', x.id))),
        ...[...blocksMine, ...blocksTheirs].map((x) => (b) => b.delete(ref(f, 'blocks', x.id))),
        ...[...reqFrom, ...reqTo].map((x) => (b) => b.delete(ref(f, 'requests', x.id))),
        ...games.filter((g) => !g.deleted).map((g) => (b) => b.update(ref(f, 'games', g.id), { deleted: true, updated_at: now() })),
      ];
      for (const part of chunk(ops, 400)) {
        const batch = f.writeBatch(f.db);
        part.forEach((op) => op(batch));
        await batch.commit();
      }
      await f.deleteUser(f.auth.currentUser);
      return {};
    });
  }

  // ---------- reads ----------

  const bootstrap = (token) => run(async (f) => snapshot(f, meOf(f)));
  const getMe = (token) => run(async (f) => (await snapshot(f, meOf(f))).me);
  const getFriends = (token) => run(async (f) => usersByIds(f, await friendIdsOf(f, meOf(f))));
  const getGames = (token) => run(async (f) => gamesOf(f, meOf(f)));

  async function searchUsers(token, query) {
    const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return [];
    return run(async (f) => {
      const me = meOf(f);
      const [all, friends, hidden] = await Promise.all([f.getDocs(f.collection(f.db, 'users')), friendIdsOf(f, me), blockedEitherWay(f, me)]);
      return all.docs
        .filter((d) => d.id !== me && !hidden.includes(d.id))
        .map((d) => pub(d.id, d.data()))
        .filter((u) => u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((u) => ({ ...u, isFriend: friends.includes(u.id) }));
    });
  }

  async function getProfile(token, userId) {
    return run(async (f) => {
      const me = meOf(f);
      const id = userId || me;
      if (id !== me && !(await f.getDoc(ref(f, 'friendships', pairId(me, id)))).exists()) {
        throw new ApiError('You can only see your friends’ profiles.', 'invalid');
      }
      const user = await userDoc(f, id);
      if (!user) throw new ApiError('That user no longer exists.', 'invalid');
      const games = await gamesOf(f, id);
      const oppIds = games.map((g) => (g.player1_id === id ? g.player2_id : g.player1_id));
      return { user, opponents: await usersByIds(f, oppIds), games };
    });
  }

  const getBlocked = (token) => run(async (f) => usersByIds(f, (await where(f, 'blocks', 'blocker', '==', meOf(f))).map((b) => b.blocked)));

  // ---------- friends ----------

  async function addFriend(token, userId) {
    return run(async (f) => {
      const me = meOf(f);
      if (!userId || userId === me) throw new ApiError('Pick someone else to add.', 'invalid');
      const other = await userDoc(f, userId);
      if (!other) throw new ApiError('That user no longer exists.', 'invalid');
      if ((await blockedEitherWay(f, me)).includes(userId)) throw new ApiError('You can’t add this person.', 'invalid');
      const fid = pairId(me, userId);
      if (!(await f.getDoc(ref(f, 'friendships', fid))).exists()) {
        const [a, b] = fid.split('__');
        await f.setDoc(ref(f, 'friendships', fid), { user_a: a, user_b: b, created_at: now() });
      }
      return other;
    });
  }

  async function removeFriend(token, userId) {
    return run(async (f) => {
      const fid = pairId(meOf(f), userId);
      if ((await f.getDoc(ref(f, 'friendships', fid))).exists()) await f.deleteDoc(ref(f, 'friendships', fid));
      return {};
    });
  }

  async function blockUser(token, userId) {
    return run(async (f) => {
      const me = meOf(f);
      const batch = f.writeBatch(f.db);
      batch.set(ref(f, 'blocks', `${me}__${userId}`), { blocker: me, blocked: userId, created_at: now() });
      const fid = pairId(me, userId);
      if ((await f.getDoc(ref(f, 'friendships', fid))).exists()) batch.delete(ref(f, 'friendships', fid));
      await batch.commit();
      return {};
    });
  }

  async function unblockUser(token, userId) {
    return run(async (f) => {
      const bid = `${meOf(f)}__${userId}`;
      if ((await f.getDoc(ref(f, 'blocks', bid))).exists()) await f.deleteDoc(ref(f, 'blocks', bid));
      return {};
    });
  }

  // ---------- games ----------

  /** The stored shape of a game (the same fields as the Sheet, plus `players` and `last_request`). */
  function cleanGame(g, me) {
    const sport = g.sport === 'fifa' ? 'fifa' : '2k';
    const int = (v) => (v === '' || v == null ? '' : Number(v));
    const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
    if (![s1, s2].every((n) => Number.isInteger(n) && n >= 0 && n <= (sport === 'fifa' ? 99 : 999))) throw new ApiError('Enter both scores.', 'invalid');
    if (sport === '2k' && s1 === s2) throw new ApiError('Basketball has no ties. Someone has to win.', 'invalid');
    if (!g.player1_team || !g.player2_team) throw new ApiError('Choose both teams.', 'invalid');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(g.date || ''))) throw new ApiError('Choose a date.', 'invalid');
    if (g.player1_id !== me && g.player2_id !== me) throw new ApiError('You can only log games you played in.', 'invalid');
    return {
      id: String(g.id),
      date: String(g.date),
      player1_id: g.player1_id,
      player2_id: g.player2_id,
      player1_score: s1,
      player2_score: s2,
      player1_team: String(g.player1_team),
      player2_team: String(g.player2_team),
      overtime: g.overtime === true,
      note: String(g.note || '').slice(0, 120),
      sport,
      player1_pens: int(g.player1_pens),
      player2_pens: int(g.player2_pens),
      players: [g.player1_id, g.player2_id],
    };
  }

  async function addGame(token, game) {
    return run(async (f) => {
      const me = meOf(f);
      const existing = await f.getDoc(ref(f, 'games', String(game.id)));
      if (existing.exists()) return gameOut(existing.data()); // a retry of an add that already landed
      const other = game.player1_id === me ? game.player2_id : game.player1_id;
      if (!(await f.getDoc(ref(f, 'friendships', pairId(me, other)))).exists()) throw new ApiError('You can only log games against your friends.', 'invalid');
      const stamp = now();
      const doc = { ...cleanGame(game, me), created_by: me, created_at: game.created_at || stamp, updated_at: stamp, deleted: false, last_request: '' };
      await f.setDoc(ref(f, 'games', doc.id), doc);
      return gameOut(doc);
    });
  }

  // Saved games only change through an approved request (same rule as the Sheet version)
  const updateGame = async () => {
    throw new ApiError('Changes now need your friend’s approval. Close and reopen the app to update it.', 'invalid');
  };
  const deleteGame = async () => {
    throw new ApiError('Deleting now needs your friend’s approval. Close and reopen the app to update it.', 'invalid');
  };

  // ---------- change requests ----------

  async function requestChange(token, { kind, game, id }) {
    if (kind !== 'edit' && kind !== 'delete') throw new ApiError('Unknown change.', 'invalid');
    return run(async (f) => {
      const me = meOf(f);
      const gameId = String(kind === 'edit' ? game?.id : id);
      const snap = await f.getDoc(ref(f, 'games', gameId));
      if (!snap.exists()) throw new ApiError('That game no longer exists.', 'invalid');
      const prev = snap.data();
      if (prev.deleted) throw new ApiError('That game was already deleted.', 'invalid');
      if (!prev.players.includes(me)) throw new ApiError('You can only change your own games.', 'invalid');
      let proposed = null;
      if (kind === 'edit') {
        proposed = cleanGame(game, me);
        if ([prev.player1_id, prev.player2_id].sort().join() !== [proposed.player1_id, proposed.player2_id].sort().join()) {
          throw new ApiError('A game can’t be moved to different players.', 'invalid');
        }
        // keep the stored orientation so the approval can be checked field by field
        if (proposed.player1_id !== prev.player1_id) {
          const flip = (k) => k.replace('player1', 'tmp').replace('player2', 'player1').replace('tmp', 'player2');
          proposed = Object.fromEntries(Object.entries(proposed).map(([k, v]) => [flip(k), v]));
          proposed.players = [proposed.player1_id, proposed.player2_id];
        }
      }
      const [mine, theirs] = await Promise.all([
        where(f, 'requests', 'from_id', '==', me).then((l) => l.filter((r) => r.game_id === gameId && r.status === 'pending')),
        where(f, 'requests', 'to_id', '==', me).then((l) => l.filter((r) => r.game_id === gameId && r.status === 'pending')),
      ]);
      if (theirs.length) throw new ApiError('Your friend already asked to change this game. Answer that first in Notifications.', 'invalid');
      const rid = mine[0]?.id || f.doc(f.collection(f.db, 'requests')).id;
      const request = {
        game_id: gameId,
        from_id: me,
        to_id: prev.player1_id === me ? prev.player2_id : prev.player1_id,
        kind,
        game: proposed,
        status: 'pending',
        created_at: now(),
        resolved_at: '',
      };
      await f.setDoc(ref(f, 'requests', rid), request);
      return { id: rid, ...request };
    });
  }

  async function respondRequest(token, requestId, approve) {
    return run(async (f) => {
      const me = meOf(f);
      const rsnap = await f.getDoc(ref(f, 'requests', requestId));
      const r = rsnap.exists() ? rsnap.data() : null;
      if (!r || r.status !== 'pending') throw new ApiError('This request was already answered or cancelled.', 'invalid');
      if (r.to_id !== me) throw new ApiError('Only your friend can answer this request.', 'invalid');
      const stamp = now();
      const batch = f.writeBatch(f.db);
      batch.update(ref(f, 'requests', requestId), { status: approve ? 'approved' : 'declined', resolved_at: stamp });
      if (approve) {
        const gsnap = await f.getDoc(ref(f, 'games', r.game_id));
        if (!gsnap.exists()) throw new ApiError('That game no longer exists.', 'invalid');
        const prev = gsnap.data();
        if (r.kind === 'delete') {
          batch.update(ref(f, 'games', r.game_id), { deleted: true, updated_at: stamp, last_request: requestId });
        } else {
          batch.set(ref(f, 'games', r.game_id), {
            ...prev,
            ...r.game,
            id: prev.id,
            players: prev.players,
            created_by: prev.created_by,
            created_at: prev.created_at,
            updated_at: stamp,
            deleted: false,
            last_request: requestId,
          });
        }
      }
      await batch.commit();
      return {};
    });
  }

  async function cancelRequest(token, requestId) {
    return run(async (f) => {
      const me = meOf(f);
      const snap = await f.getDoc(ref(f, 'requests', requestId));
      if (!snap.exists() || snap.data().status !== 'pending') return {};
      if (snap.data().from_id !== me) throw new ApiError('Only the person who asked can cancel this.', 'invalid');
      await f.updateDoc(ref(f, 'requests', requestId), { status: 'cancelled', resolved_at: now() });
      return {};
    });
  }

  return {
    signUp, signIn, signOut, bootstrap, getMe, getFriends, searchUsers, updateProfile, changePin,
    addFriend, removeFriend, blockUser, unblockUser, getBlocked, getProfile, getGames,
    addGame, updateGame, deleteGame, requestChange, respondRequest, cancelRequest, verifyPin, deleteAccount,
  };
}
