// Firebase backend (Auth + Cloud Firestore) behind the same interface as the Google Sheets one
// (see api.js). The security rules in firestore.rules enforce who may read and write what; the
// checks here just give friendly messages first.
//
// Accounts: you still sign in with a username and 4-digit PIN. Behind the scenes each player has a
// Firebase Auth account "<userId>@users.hoophead.xyz" whose password is derived from the PIN.
// Players who existed in the Google Sheet were copied over with the same ids; the first time they
// sign in here, the old Apps Script checks their PIN once and sets their Firebase password ("claim").
import { FIREBASE_CONFIG, VAPID_KEY, ADMIN_ID, ADMIN_USERNAME } from '../firebase-config.js';
import { CONFIG } from '../config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.3.0';
const EMAIL_DOMAIN = 'users.hoophead.xyz';
const AVATAR_COLORS = ['#5856D6', '#C93400', '#007A5E', '#A2338A', '#0060C7', '#8A5A00', '#B0263A', '#3D6591'];
const REQUEST_DAYS = 14;
const ANNOUNCEMENT_DAYS = 30; // how long an announcement stays on the Notifications page
const announcementsSince = () => new Date(Date.now() - ANNOUNCEMENT_DAYS * 86400000).toISOString();

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
      return { ...auth, ...fs, app: firebaseApp, auth: a, db };
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
    if (code === 'auth/user-disabled') return new ApiError('This account is suspended.', 'auth');
    if (code === 'unauthenticated' || code === 'auth/user-token-expired') {
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

  // ---------- live data ----------
  // Every document read counts against Firestore's free daily quota, so instead of re-reading
  // everything on each refresh, listeners stay open while you're signed in: your data is read once,
  // then Firestore only sends (and counts) documents that change. Refreshes read from these
  // listeners for free, and a change from a friend shows up at once (see onRemoteChange).

  let live = null;
  const changeListeners = new Set();
  const notifyChange = () => changeListeners.forEach((fn) => fn());

  function stopLive() {
    live?.stop();
    live = null;
  }

  function startLive(f, me) {
    const parts = { me: undefined, fa: undefined, fb: undefined, games: undefined, rf: undefined, rt: undefined, ann: undefined };
    const friendDocs = new Map();
    let friendKey = null;
    let friendUnsubs = [];
    let friendsReady = false;
    let resolveReady;
    const session = { me, failed: null, ready: new Promise((r) => (resolveReady = r)) };
    let initial = true;

    const settled = () => Object.values(parts).every((v) => v !== undefined) && friendsReady;
    const changed = () => {
      if (initial) {
        if (settled()) (initial = false), resolveReady();
      } else notifyChange();
    };
    const fail = (err) => {
      session.failed = err;
      resolveReady();
      if (live === session) stopLive(); // the next refresh starts over (or reports the error)
    };
    const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    function watchFriends() {
      if (parts.fa === undefined || parts.fb === undefined) return;
      const ids = [...new Set([...parts.fa.map((x) => x.user_b), ...parts.fb.map((x) => x.user_a)])].sort();
      if (ids.join() === friendKey) return;
      friendKey = ids.join();
      friendUnsubs.forEach((off) => off());
      friendDocs.clear();
      const parts30 = chunk(ids, 30);
      const seen = new Set();
      friendsReady = parts30.length === 0;
      friendUnsubs = parts30.map((part, i) => f.onSnapshot(f.query(f.collection(f.db, 'users'), f.where(f.documentId(), 'in', part)), (snap) => {
        part.forEach((id) => friendDocs.delete(id));
        snap.forEach((d) => friendDocs.set(d.id, pub(d.id, d.data())));
        seen.add(i);
        if (seen.size === parts30.length) friendsReady = true;
        changed();
      }, fail));
    }

    const listen = (key, q, onError = fail) => f.onSnapshot(q, (snap) => {
      parts[key] = key === 'me' ? (snap.exists() ? pub(me, snap.data()) : null) : docs(snap);
      if (key === 'fa' || key === 'fb') watchFriends();
      changed();
    }, onError);
    const qWhere = (coll, field, op, value) => f.query(f.collection(f.db, coll), f.where(field, op, value));
    const unsubs = [
      listen('me', ref(f, 'users', me)),
      listen('fa', qWhere('friendships', 'user_a', '==', me)),
      listen('fb', qWhere('friendships', 'user_b', '==', me)),
      listen('games', qWhere('games', 'players', 'array-contains', me)),
      listen('rf', qWhere('requests', 'from_id', '==', me)),
      listen('rt', qWhere('requests', 'to_id', '==', me)),
      // Announcements are extra: if they can't load, the rest of the app still works
      listen('ann', f.query(f.collection(f.db, 'announcements'), f.orderBy('created_at', 'desc'), f.limit(10)), () => {
        parts.ann = [];
        changed();
      }),
    ];
    watchFriends();

    session.stop = () => {
      [...unsubs, ...friendUnsubs].forEach((off) => off());
      session.failed ||= new ApiError('Your session has ended. Sign in again.', 'auth');
      resolveReady();
    };
    /** The current data, in the same shape bootstrap returns. */
    session.read = async () => {
      if (!parts.me) throw new ApiError('This account no longer exists.', 'auth');
      const ids = friendKey ? friendKey.split(',') : [];
      const missing = ids.filter((id) => !friendDocs.has(id)); // a brand-new friend, still loading
      const extra = missing.length ? await usersByIds(f, missing) : [];
      const since = new Date(Date.now() - REQUEST_DAYS * 86400000).toISOString();
      return {
        me: parts.me,
        friends: [...ids.map((id) => friendDocs.get(id)).filter(Boolean), ...extra],
        games: parts.games.filter((g) => !g.deleted).map(gameOut),
        requests: [...parts.rf, ...parts.rt].filter((r) => r.status === 'pending' || ((r.status === 'approved' || r.status === 'declined') && String(r.resolved_at) >= since)),
        announcements: parts.ann.filter((a) => String(a.created_at) >= announcementsSince()),
      };
    };
    return session;
  }

  /** Your profile, friends, games and requests, from the listeners (started on first use). */
  async function snapshot(f, me) {
    if (live?.me !== me) {
      stopLive();
      live = startLive(f, me);
    }
    const session = live;
    // The first load can stall on a bad connection; give up after a while (the listeners keep
    // trying, and the next refresh picks up whatever has arrived by then)
    let timer;
    const slow = new Promise((_, reject) => (timer = setTimeout(() => reject(new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout')), 20000)));
    try {
      await Promise.race([session.ready, slow]);
    } finally {
      clearTimeout(timer);
    }
    if (session.failed) throw session.failed;
    return session.read();
  }

  // ---------- accounts ----------

  /**
   * First sign-in after the move: the old Apps Script checks the PIN and sets the Firebase password.
   * Apps Script often answers with a broken redirect (an error page without CORS headers) instead
   * of its result, so this is retried a few times. Safe: claiming sets the same password each time.
   */
  async function claim(username, pin) {
    if (!CONFIG.APPS_SCRIPT_URL) throw new ApiError('Wrong username or PIN.', 'auth');
    for (let attempt = 0; ; attempt++) {
      let json = null;
      try {
        const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'claimFirebase', username, pin }),
          redirect: 'follow',
        });
        json = await res.json();
      } catch {
        /* no answer: try again below */
      }
      if (json) {
        if (!json.ok) throw new ApiError(json.error || 'Wrong username or PIN.', json.code || 'auth', json);
        return;
      }
      if (!navigator.onLine) throw new ApiError('You’re offline.', 'network');
      if (attempt >= 4) throw new ApiError('Couldn’t reach the server. Try again in a moment.', 'timeout');
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  async function signIn(username, pin) {
    const name = String(username || '').trim().toLowerCase().replace(/^@/, '');
    return run(async (f) => {
      if (!/^\d{4}(\d{4})?$/.test(String(pin))) throw new ApiError('Wrong username or PIN.', 'auth'); // 8 digits: the admin
      const entry = await f.getDoc(ref(f, 'usernames', name));
      if (!entry.exists()) throw new ApiError('Wrong username or PIN.', 'auth');
      const { userId, claimed } = entry.data();
      stopLive();
      try {
        await f.signInWithEmailAndPassword(f.auth, emailOf(userId), passwordOf(pin, userId));
      } catch (err) {
        const wrong = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(err?.code);
        if (!wrong || claimed) throw err;
        await claim(name, pin); // moved from the Google Sheet and not signed in here yet
        await f.signInWithEmailAndPassword(f.auth, emailOf(userId), passwordOf(pin, userId));
      }
      await releasePushFromOtherAccount(f, userId);
      const data = await snapshot(f, userId);
      return { token: userId, user: data.me, friends: data.friends, games: data.games, requests: data.requests, announcements: data.announcements };
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
      stopLive();
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

  const signOut = () =>
    run(async (f) => {
      stopLive();
      await forgetPush(f); // this phone stops getting your notifications
      await f.signOut(f.auth);
    }).catch(() => ({}));

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
    return run(async (f) => {
      const digits = meOf(f) === ADMIN_ID ? 8 : 4;
      if (!new RegExp(`^\\d{${digits}}$`).test(String(newPin))) throw new ApiError(`Your new PIN must be ${digits} digits.`, 'invalid');
      const id = await reauth(f, currentPin).catch((e) => {
        throw e.code === 'wrong_pin' ? new ApiError('Your current PIN is wrong.', 'wrong_pin') : e;
      });
      await f.updatePassword(f.auth.currentUser, passwordOf(newPin, id)); // signs out your other devices
      // The sign-in screen reads this to show the admin an 8-digit PIN pad
      if (id === ADMIN_ID) await f.setDoc(ref(f, 'config', 'adminPin'), { length: 8, updated_at: now() });
      return { token: id };
    });
  }

  /** How many digits this username's PIN has: 8 for the admin (once set up), otherwise 4. */
  async function pinLength(username) {
    if (String(username || '').trim().toLowerCase().replace(/^@/, '') !== ADMIN_USERNAME) return 4;
    return run(async (f) => ((await f.getDoc(ref(f, 'config', 'adminPin'))).exists() ? 8 : 4)).catch(() => 4);
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
      stopLive(); // its listeners would fail once the profile is gone
      await forgetPush(f);
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
  const getFriends = (token) => run(async (f) => (await snapshot(f, meOf(f))).friends);
  const getGames = (token) => run(async (f) => (await snapshot(f, meOf(f))).games);

  let everyone = null;
  async function searchUsers(token, query) {
    const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return [];
    return run(async (f) => {
      const me = meOf(f);
      // Searching reads every profile, so the list is kept for a couple of minutes while you type
      if (!everyone || Date.now() - everyone.at > 120000) {
        everyone = { at: Date.now(), users: (await f.getDocs(f.collection(f.db, 'users'))).docs.map((d) => pub(d.id, d.data())) };
      }
      const [friends, hidden] = await Promise.all([friendIdsOf(f, me), blockedEitherWay(f, me)]);
      return everyone.users
        .filter((u) => u.id !== me && u.id !== ADMIN_ID && !hidden.includes(u.id))
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
      if (!userId || userId === me || userId === ADMIN_ID || me === ADMIN_ID) throw new ApiError('Pick someone else to add.', 'invalid');
      const other = await userDoc(f, userId);
      if (!other) throw new ApiError('That user no longer exists.', 'invalid');
      if ((await blockedEitherWay(f, me)).includes(userId)) throw new ApiError('You can’t add this person.', 'invalid');
      const fid = pairId(me, userId);
      if (!(await f.getDoc(ref(f, 'friendships', fid))).exists()) {
        const [a, b] = fid.split('__');
        await f.setDoc(ref(f, 'friendships', fid), { user_a: a, user_b: b, created_at: now() });
        notify(f, 'friend', fid);
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
      notify(f, 'game', doc.id);
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
      notify(f, 'request', rid);
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
      notify(f, 'response', requestId);
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

  // ---------- admin console ----------
  // Only the admin account (ADMIN_ID) can use these; the security rules enforce it. Changes are
  // anonymous: no notifications, no labels, and games keep who logged them. Each change is written
  // to the admin's private history (adminLog).

  function requireAdmin(f) {
    const me = meOf(f);
    if (me !== ADMIN_ID) throw new ApiError('Only the admin can do that.', 'invalid');
    return me;
  }
  const all = async (f, coll) => (await f.getDocs(f.collection(f.db, coll))).docs.map((d) => ({ id: d.id, ...d.data() }));

  /** Everything the console shows: players (with status), friendships, games, notification phones. */
  async function adminLoad() {
    return run(async (f) => {
      requireAdmin(f);
      const [users, friendships, games, suspensions, tokens, blocks] = await Promise.all([
        all(f, 'users'), all(f, 'friendships'), all(f, 'games'), all(f, 'suspensions'), all(f, 'pushTokens'), all(f, 'blocks'),
      ]);
      const players = users.filter((u) => u.id !== ADMIN_ID);
      // "Moved": has signed in to the Firebase version (or signed up there)
      const moved = await Promise.all(players.map((u) => f.getDoc(ref(f, 'usernames', u.username)).then((d) => d.exists() && d.data().claimed === true)));
      const suspended = new Set(suspensions.map((x) => x.id));
      const phones = new Map();
      tokens.forEach((t) => phones.set(t.userId, (phones.get(t.userId) || 0) + 1));
      return {
        users: players.map((u, i) => ({ ...pub(u.id, u), created_at: u.created_at || '', moved: moved[i], suspended: suspended.has(u.id), phones: phones.get(u.id) || 0 })),
        friendships: friendships.map((x) => ({ id: x.id, a: x.user_a, b: x.user_b, created_at: x.created_at })),
        blocks: blocks.map((x) => ({ blocker: x.blocker, blocked: x.blocked })),
        games: games.filter((g) => !g.deleted).map(gameOut),
        phones: tokens.length,
      };
    });
  }

  /** Cancels open requests about a game the admin just changed (in the same batch). */
  async function cancelOpenRequests(f, batch, gameId, stamp) {
    const open = await f.getDocs(f.query(f.collection(f.db, 'requests'), f.where('game_id', '==', gameId)));
    open.docs.filter((d) => d.data().status === 'pending').forEach((d) => batch.update(d.ref, { status: 'cancelled', resolved_at: stamp }));
  }

  function logEntry(f, batch, action, summary, extra = {}) {
    batch.set(f.doc(f.collection(f.db, 'adminLog')), { at: now(), action, summary, ...extra });
  }

  /** Logs a new game for two friends, or saves changes to an existing one. `summary` goes to the history. */
  async function adminSaveGame(game, summary) {
    return run(async (f) => {
      requireAdmin(f);
      const stamp = now();
      const id = String(game.id);
      const snap = await f.getDoc(ref(f, 'games', id));
      const clean = cleanGame(game, game.player1_id); // same checks as a player's game
      const batch = f.writeBatch(f.db);
      if (snap.exists()) {
        const prev = snap.data();
        // The console edits a game in its saved order (player 1 stays player 1)
        if (clean.player1_id !== prev.player1_id || clean.player2_id !== prev.player2_id) {
          throw new ApiError('A game can’t be moved to different players.', 'invalid');
        }
        batch.set(ref(f, 'games', id), { ...prev, ...clean, id, updated_at: stamp, deleted: false });
        await cancelOpenRequests(f, batch, id, stamp);
        logEntry(f, batch, 'edit-game', summary, { game_id: id, before: gameOut(prev), after: clean });
      } else {
        if (!(await f.getDoc(ref(f, 'friendships', pairId(clean.player1_id, clean.player2_id)))).exists()) {
          throw new ApiError('They need to be friends first.', 'invalid');
        }
        // Credited to player 1, as if they had logged it
        batch.set(ref(f, 'games', id), { ...clean, created_by: clean.player1_id, created_at: stamp, updated_at: stamp, deleted: false, last_request: '' });
        logEntry(f, batch, 'log-game', summary, { game_id: id, after: clean });
      }
      await batch.commit();
      return {};
    });
  }
  async function adminDeleteGame(id, summary) {
    return run(async (f) => {
      requireAdmin(f);
      const snap = await f.getDoc(ref(f, 'games', String(id)));
      if (!snap.exists() || snap.data().deleted) return {};
      const stamp = now();
      const batch = f.writeBatch(f.db);
      batch.update(ref(f, 'games', String(id)), { deleted: true, updated_at: stamp });
      await cancelOpenRequests(f, batch, String(id), stamp);
      logEntry(f, batch, 'delete-game', summary, { game_id: String(id), before: gameOut(snap.data()) });
      await batch.commit();
      return {};
    });
  }

  async function adminSetFriends(a, b, friends, summary) {
    return run(async (f) => {
      requireAdmin(f);
      if (!a || !b || a === b || a === ADMIN_ID || b === ADMIN_ID) throw new ApiError('Pick two different players.', 'invalid');
      const fid = pairId(a, b);
      const exists = (await f.getDoc(ref(f, 'friendships', fid))).exists();
      if (exists === friends) return {};
      const batch = f.writeBatch(f.db);
      if (friends) {
        const [x, y] = fid.split('__');
        batch.set(ref(f, 'friendships', fid), { user_a: x, user_b: y, created_at: now() });
      } else batch.delete(ref(f, 'friendships', fid));
      logEntry(f, batch, friends ? 'add-friends' : 'remove-friends', summary, { users: [a, b] });
      await batch.commit();
      return {};
    });
  }

  /** The admin's private history, newest first. */
  async function adminHistory() {
    return run(async (f) => {
      requireAdmin(f);
      const snap = await f.getDocs(f.query(f.collection(f.db, 'adminLog'), f.orderBy('at', 'desc'), f.limit(200)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    });
  }
  const adminNote = (action, summary, extra = {}) =>
    run(async (f) => {
      requireAdmin(f);
      await f.addDoc(f.collection(f.db, 'adminLog'), { at: now(), action, summary, ...extra });
      return {};
    });

  /** Calls one of the Apps Script's admin actions (it checks this is really the admin). */
  async function adminScript(action, params) {
    return run(async (f) => {
      requireAdmin(f);
      const idToken = await f.auth.currentUser.getIdToken();
      for (let attempt = 0; ; attempt++) {
        let json = null;
        try {
          const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, idToken, ...params }),
            redirect: 'follow',
          });
          json = await res.json();
        } catch {
          /* Apps Script's broken redirect: try again (these actions are safe to repeat) */
        }
        if (json) {
          if (!json.ok) throw new ApiError(json.error || 'Something went wrong.', json.code === 'auth' ? 'invalid' : json.code || 'server');
          return json.data;
        }
        if (attempt >= 4) throw new ApiError('Google didn’t answer. Try again in a moment.', 'timeout');
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    });
  }
  const adminResetPin = async (userId, pin, summary) => {
    await adminScript('adminResetPin', { userId, pin });
    await adminNote('reset-pin', summary, { users: [userId] });
  };
  const adminSuspend = async (userId, suspended, summary) => {
    await adminScript('adminSuspend', { userId, suspended });
    await adminNote(suspended ? 'suspend' : 'unsuspend', summary, { users: [userId] });
  };
  /** Sends an announcement to everyone. `id` makes a retried send harmless. */
  const adminAnnounce = async (id, title, body) => {
    const result = await adminScript('adminAnnounce', { id, title, body });
    if (!result.duplicate) await adminNote('announce', `Sent announcement “${title}”`, { announcement_id: id });
    return result;
  };
  const adminAnnouncements = () =>
    run(async (f) => {
      requireAdmin(f);
      const snap = await f.getDocs(f.query(f.collection(f.db, 'announcements'), f.orderBy('created_at', 'desc'), f.limit(50)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    });
  const adminRemoveAnnouncement = (id, title) =>
    run(async (f) => {
      requireAdmin(f);
      const batch = f.writeBatch(f.db);
      batch.delete(ref(f, 'announcements', id));
      logEntry(f, batch, 'remove-announcement', `Removed announcement “${title}”`, { announcement_id: id });
      await batch.commit();
      return {};
    });

  // ---------- push notifications ----------
  // A phone that turns notifications on gets a push token from Firebase Cloud Messaging, saved in
  // pushTokens/{token}. After you log a game, ask to change one, answer a request or add a friend,
  // the app asks the Apps Script to notify the other player; it checks who's asking and that the
  // event is real, then sends the notification to their phones. (No paid Firebase plan needed.)
  // Tokens contain ":", which Firestore's REST paths can't take, so the doc id is the token's SHA-256.

  const PUSH_KEY = 'h2h.push.v1'; // { userId, doc }: this phone's notifications, and for whom
  const tokenDoc = async (token) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const savedPush = () => {
    try {
      return JSON.parse(localStorage.getItem(PUSH_KEY)) || null;
    } catch {
      return null;
    }
  };
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const canPush = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  /** 'on' | 'off' | 'denied' | 'install' (iPhone: only apps added to the Home Screen can) | 'unsupported' */
  function pushStatus(userId) {
    if (!canPush()) return isIOS() && !isStandalone() ? 'install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return Notification.permission === 'granted' && savedPush()?.userId === userId ? 'on' : 'off';
  }

  let messaging = null;
  async function pushToken(f) {
    const m = await import(`${SDK}/firebase-messaging.js`);
    if (!(await m.isSupported())) throw new ApiError('This device can’t get notifications.', 'invalid');
    messaging ||= m.getMessaging(f.app);
    // Our own service worker shows the notifications (see sw.js)
    return m.getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: await navigator.serviceWorker.ready });
  }

  async function saveToken(f, me, token) {
    const doc = await tokenDoc(token);
    const old = savedPush();
    if (old?.doc && old.doc !== doc && old.userId === me) await f.deleteDoc(ref(f, 'pushTokens', old.doc)).catch(() => {});
    const platform = isIOS() ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'web';
    await f.setDoc(ref(f, 'pushTokens', doc), { userId: me, token, created_at: now(), platform });
    localStorage.setItem(PUSH_KEY, JSON.stringify({ userId: me, doc }));
  }

  async function forgetPush(f) {
    const saved = savedPush();
    localStorage.removeItem(PUSH_KEY);
    if (saved?.doc) await f.deleteDoc(ref(f, 'pushTokens', saved.doc)).catch(() => {});
  }

  /** Signing in on a phone that got someone else's notifications: take the token over, then drop it. */
  async function releasePushFromOtherAccount(f, me) {
    const saved = savedPush();
    if (!saved?.doc || saved.userId === me) return;
    localStorage.removeItem(PUSH_KEY);
    try {
      // Rules only let you delete your own, so make it yours first (with a placeholder token)
      await f.setDoc(ref(f, 'pushTokens', saved.doc), { userId: me, token: '-', created_at: now(), platform: 'web' });
      await f.deleteDoc(ref(f, 'pushTokens', saved.doc));
    } catch {
      /* best effort */
    }
  }

  /** Turns notifications on for this phone. Call it straight from a tap (iPhones require one). */
  async function enablePush() {
    // Ask first, before anything else is awaited, so the tap still counts as the reason to ask
    const permission = canPush() ? await Notification.requestPermission() : 'denied';
    if (permission !== 'granted') {
      throw new ApiError(permission === 'denied' ? 'Notifications are blocked for Dubs. You can allow them in your phone’s Settings.' : 'Notifications weren’t turned on.', 'invalid');
    }
    return run(async (f) => {
      await saveToken(f, meOf(f), await pushToken(f));
      return {};
    });
  }

  const disablePush = () => run(async (f) => (await forgetPush(f), {}));

  /** On each app open: push tokens can change, so keep this phone's current. */
  async function refreshPush() {
    const saved = savedPush();
    if (!saved || !canPush() || Notification.permission !== 'granted') return;
    await run(async (f) => {
      const me = meOf(f);
      if (saved.userId === me) await saveToken(f, me, await pushToken(f));
    }).catch(() => {});
  }

  /** Asks the Apps Script to notify the other player about something you just did. Best effort. */
  function notify(f, kind, id) {
    if (!CONFIG.APPS_SCRIPT_URL) return;
    f.auth.currentUser
      ?.getIdToken()
      .then((idToken) =>
        // no-cors: the script runs on arrival; we don't need its answer (often lost in its redirect)
        fetch(CONFIG.APPS_SCRIPT_URL, {
          method: 'POST',
          mode: 'no-cors',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'notify', idToken, kind, id }),
        }),
      )
      .catch(() => {});
  }

  /** Calls `fn` whenever your data changes on the server; returns an unsubscribe function. */
  function onRemoteChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

  return {
    onRemoteChange, pushStatus, enablePush, disablePush, refreshPush, pinLength,
    adminLoad, adminSaveGame, adminDeleteGame, adminSetFriends, adminHistory, adminResetPin, adminSuspend, adminAnnounce, adminAnnouncements, adminRemoveAnnouncement,
    signUp, signIn, signOut, bootstrap, getMe, getFriends, searchUsers, updateProfile, changePin,
    addFriend, removeFriend, blockUser, unblockUser, getBlocked, getProfile, getGames,
    addGame, updateGame, deleteGame, requestChange, respondRequest, cancelRequest, verifyPin, deleteAccount,
  };
}
