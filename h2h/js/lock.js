// Welcome / sign-in / sign-up screens and the PIN pad.
//   showLock()                -> welcome screen: continue as a known account, sign in, or create one
//   showLock({ local: true }) -> "Require PIN on open": re-enter your PIN, checked on-device
//                                (works offline). 5 misses signs you out.
import * as store from './store.js';
import { isDemo, demoControls } from './api.js';
import { esc, haptic, reducedMotion } from './ui.js';

const PIN_LENGTH = 4;
const LOCAL_TRIES = 5;
const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
];
const BACK_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.75 8.25 12l6.25 6.25"/></svg>';

const root = () => document.getElementById('lock');
let resolveUnlock = null;
let keyHandler = null;
let countdown = null;

/** Picture avatars a01…a20 (assets/avatars). A user without one shows their initial instead. */
export const AVATARS = Array.from({ length: 20 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
const isAvatar = (id) => AVATARS.includes(id);

export const avatar = (user, size = 'md') =>
  isAvatar(user?.avatar)
    ? `<span class="avatar avatar--${size} avatar--img" aria-hidden="true"><img src="assets/avatars/${user.avatar}.webp" alt="" width="256" height="256" decoding="async" draggable="false"></span>`
    : `<span class="avatar avatar--${size}" style="--avatar:${esc(user?.color || '#8E8E93')}" aria-hidden="true">${esc(user?.initial || user?.display_name?.[0] || '?')}</span>`;

export function isLocked() {
  return root().classList.contains('is-shown');
}

export function showLock({ local = false, message = '' } = {}) {
  const el = root();
  el.classList.add('is-shown');
  el.getBoundingClientRect();
  el.classList.add('is-visible');
  document.getElementById('app').inert = true;
  if (local) renderLocalPin(message);
  else renderWelcome(message);
  return new Promise((resolve) => (resolveUnlock = resolve));
}

async function hideLock() {
  const el = root();
  stopCountdown();
  setKeys(null);
  el.classList.remove('is-visible');
  document.documentElement.classList.remove('boot-locked');
  document.getElementById('app').inert = false;
  await new Promise((r) => setTimeout(r, reducedMotion.matches ? 0 : 320));
  el.classList.remove('is-shown');
  el.innerHTML = '';
  resolveUnlock?.();
  resolveUnlock = null;
}

function stopCountdown() {
  clearInterval(countdown);
  countdown = null;
}

function setKeys(fn) {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = fn;
  if (fn) document.addEventListener('keydown', fn);
}

function swap(html) {
  stopCountdown();
  setKeys(null);
  const el = root();
  el.innerHTML = `<div class="lock__view">${html}</div>`;
  return el.firstElementChild;
}

const topBar = (label = 'Back') => `<div class="pin__top"><button type="button" class="btn-text pin__back" data-back>${BACK_ICON}${esc(label)}</button></div>`;
const demoHint = () => (isDemo ? `<p class="lock__hint">Demo accounts: ${esc(demoControls.hint)}</p>` : '');

// ---------- welcome ----------

function renderWelcome(message = '') {
  const accounts = store.deviceAccounts();
  const view = swap(`
    <div class="lock__center">
      <img class="lock__icon" src="assets/icons/icon-192.png" alt="" width="64" height="64">
      <h1 class="lock__title">Dubs</h1>
      <p class="lock__sub">Your 2K &amp; FIFA rivalries, tracked.</p>
      ${message ? `<p class="lock__notice" role="status">${esc(message)}</p>` : ''}
      ${
        accounts.length
          ? `<ul class="list auth-accounts" role="list" aria-label="Accounts on this device">
          ${accounts
            .map(
              (a) => `<li><button type="button" class="cell cell--button auth-account" data-username="${esc(a.username)}">
                ${avatar(a, 'md')}<span class="cell__stack"><span class="cell__title">Continue as ${esc(a.display_name)}</span><span class="cell__sub">@${esc(a.username)}</span></span>
                <svg class="icon cell__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.75 6.25 6.25-6.25 6.25"/></svg></button></li>`,
            )
            .join('')}
        </ul>`
          : ''
      }
      <div class="auth-actions">
        <button type="button" class="btn btn--primary btn--block" data-go="signup">Create Account</button>
        <button type="button" class="btn btn--tinted btn--block" data-go="signin">${accounts.length ? 'Use Another Account' : 'Sign In'}</button>
      </div>
      ${demoHint()}
    </div>`);
  view.querySelectorAll('[data-username]').forEach((btn) =>
    btn.addEventListener('click', () => {
      haptic('light');
      const account = accounts.find((a) => a.username === btn.dataset.username);
      renderSignInPin(account, () => renderWelcome());
    }),
  );
  view.querySelector('[data-go="signup"]').addEventListener('click', () => renderSignUp());
  view.querySelector('[data-go="signin"]').addEventListener('click', () => renderSignIn());
  (view.querySelector('.auth-account') || view.querySelector('.btn'))?.focus({ preventScroll: true });
}

// ---------- sign in ----------

function renderSignIn(prefill = '', error = '') {
  const view = swap(`
    ${topBar()}
    <form class="auth-form" novalidate>
      <h1 class="lock__title">Sign In</h1>
      <p class="lock__sub">Enter your username, then your PIN.</p>
      <ul class="list" role="list">
        <li class="cell"><label for="auth-username" class="visually-hidden">Username</label>
          <input id="auth-username" class="cell__input cell__input--full" name="username" placeholder="Username" value="${esc(prefill)}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></li>
      </ul>
      <p class="auth-error" role="alert">${esc(error)}</p>
      <button type="submit" class="btn btn--primary btn--block">Continue</button>
      ${demoHint()}
    </form>`);
  const form = view.querySelector('form');
  const input = form.username;
  view.querySelector('[data-back]').addEventListener('click', () => renderWelcome());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = input.value.trim().toLowerCase().replace(/^@/, '');
    if (!username) return (view.querySelector('.auth-error').textContent = 'Enter your username.');
    renderSignInPin({ username }, () => renderSignIn(username));
  });
  input.focus({ preventScroll: true });
}

function renderSignInPin(account, back) {
  renderPin({
    user: account.id ? account : null,
    title: 'Enter PIN',
    subtitle: account.display_name || `@${account.username}`,
    back,
    onPin: async (pin) => {
      await store.signIn(account.username, pin);
      return 'done';
    },
  });
}

// ---------- sign up ----------

function renderSignUp(values = {}, error = '') {
  const view = swap(`
    ${topBar()}
    <form class="auth-form" novalidate>
      <h1 class="lock__title">Create Account</h1>
      <p class="lock__sub">Friends find you by your name or username.</p>
      <ul class="list" role="list">
        <li class="cell"><label for="su-name" class="visually-hidden">Name</label>
          <input id="su-name" class="cell__input cell__input--full" name="displayName" placeholder="Name" value="${esc(values.displayName || '')}" autocomplete="nickname" maxlength="24" enterkeyhint="next" required></li>
        <li class="cell"><label for="su-username" class="visually-hidden">Username</label>
          <span class="cell__prefix" aria-hidden="true">@</span><input id="su-username" class="cell__input cell__input--full" name="username" placeholder="username" value="${esc(values.username || '')}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="20" enterkeyhint="next" required></li>
      </ul>
      <p class="auth-help">3–20 characters: letters, numbers, dots or underscores.</p>
      <p class="auth-error" role="alert">${esc(error)}</p>
      <button type="submit" class="btn btn--primary btn--block">Continue</button>
    </form>`);
  const form = view.querySelector('form');
  const err = view.querySelector('.auth-error');
  view.querySelector('[data-back]').addEventListener('click', () => renderWelcome());
  form.username.addEventListener('input', () => {
    form.username.value = form.username.value.toLowerCase().replace(/[^a-z0-9_.]/g, '');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const displayName = form.displayName.value.trim();
    const username = form.username.value.trim();
    if (!displayName) return (err.textContent = 'Enter your name.');
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) return (err.textContent = 'Usernames are 3–20 letters, numbers, dots or underscores.');
    renderCreatePin({ displayName, username });
  });
  (values.displayName ? form.username : form.displayName).focus({ preventScroll: true });
}

function renderCreatePin(values, message = '') {
  renderPin({
    title: 'Create a PIN',
    subtitle: 'You’ll use it to sign in.',
    message,
    back: () => renderSignUp(values),
    onPin: async (first) => {
      renderPin({
        title: 'Confirm PIN',
        subtitle: 'Enter the same 4 digits again.',
        back: () => renderCreatePin(values),
        onPin: async (second) => {
          if (second !== first) {
            haptic('warning');
            renderCreatePin(values, 'The PINs didn’t match. Try again.');
            return 'handled';
          }
          try {
            await store.signUp(values.username, values.displayName, first);
            return 'done';
          } catch (e) {
            if (e.code === 'taken' || e.code === 'invalid') {
              renderSignUp(values, e.message);
              return 'handled';
            }
            throw e;
          }
        },
      });
      return 'handled';
    },
  });
}

// ---------- change PIN (from Settings) ----------

/** Current PIN → new PIN → confirm, checked by the server. Resolves true if the PIN changed. */
export function changePinFlow() {
  const el = root();
  el.classList.add('is-shown');
  el.getBoundingClientRect();
  el.classList.add('is-visible');
  document.getElementById('app').inert = true;
  let changed = false;
  const cancel = { label: 'Cancel', fn: () => hideLock() };
  const user = store.state.me;

  const current = (message = '') =>
    renderPin({
      user,
      title: 'Current PIN',
      subtitle: 'Enter the PIN you use now.',
      message,
      leave: cancel,
      onPin: async (currentPin) => (next(currentPin), 'handled'),
    });
  const next = (currentPin, message = '') =>
    renderPin({
      user,
      title: 'New PIN',
      subtitle: 'Choose 4 new digits.',
      message,
      leave: cancel,
      onPin: async (newPin) => {
        if (newPin === currentPin) return next(currentPin, 'Pick a PIN that’s different from your current one.'), 'handled';
        confirm(currentPin, newPin);
        return 'handled';
      },
    });
  const confirm = (currentPin, newPin) =>
    renderPin({
      user,
      title: 'Confirm New PIN',
      subtitle: 'Enter the new PIN again.',
      leave: cancel,
      onPin: async (again) => {
        if (again !== newPin) {
          haptic('warning');
          next(currentPin, 'The PINs didn’t match. Try again.');
          return 'handled';
        }
        try {
          await store.changePin(currentPin, newPin);
          changed = true;
          return 'done';
        } catch (e) {
          if (e.code === 'wrong_pin') {
            haptic('warning');
            current(`${e.message}${e.triesLeft ? ` ${e.triesLeft} ${e.triesLeft === 1 ? 'try' : 'tries'} left.` : ''}`);
            return 'handled';
          }
          throw e;
        }
      },
    });

  current();
  return new Promise((resolve) => (resolveUnlock = () => resolve(changed)));
}

// ---------- "Require PIN on open" ----------

function renderLocalPin(message = '') {
  let misses = 0;
  renderPin({
    user: store.state.me,
    title: 'Enter PIN',
    subtitle: store.state.me?.display_name || '',
    message,
    leave: { label: 'Sign Out', fn: () => (store.signOut(), renderWelcome()) },
    onPin: async (pin) => {
      if (await store.verifyLocalPin(pin)) return 'done';
      misses++;
      if (misses >= LOCAL_TRIES) {
        store.signOut();
        renderWelcome('Too many attempts. Sign in again.');
        return 'handled';
      }
      const left = LOCAL_TRIES - misses;
      throw Object.assign(new Error(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`), { code: 'local' });
    },
  });
}

// ---------- PIN pad ----------

/**
 * onPin(pin) resolves 'done' (success: close the lock), 'handled' (it already moved on),
 * or throws an ApiError-like error that is shown under the dots.
 */
function renderPin({ user = null, title, subtitle = '', message = '', back, leave, onPin }) {
  let digits = '';
  let busy = false;

  const view = swap(`
    <div class="pin">
      ${leave ? `<div class="pin__top"><button type="button" class="btn-text" data-back>${esc(leave.label)}</button></div>` : topBar()}
      <div class="pin__head">
        ${user ? avatar(user, 'lg') : ''}
        <h1 class="pin__title">${esc(title)}</h1>
        <p class="pin__for">${esc(subtitle)}</p>
      </div>
      <div class="dots" aria-hidden="true">${'<span class="dot"></span>'.repeat(PIN_LENGTH)}</div>
      <p class="pin__msg" role="status" aria-live="polite">${esc(message)}</p>
      <div class="keypad" role="group" aria-label="PIN keypad">
        ${KEYS.map(([d, l]) => `<button type="button" class="key" data-digit="${d}" aria-label="${d}"><span class="key__digit">${d}</span><span class="key__letters">${l}</span></button>`).join('')}
        <span></span>
        <button type="button" class="key" data-digit="0" aria-label="0"><span class="key__digit">0</span></button>
        <button type="button" class="key key--plain" data-delete aria-label="Delete">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 5.75h9.05a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H9.2a2 2 0 0 1-1.5-.68L3.75 12l3.95-5.57a2 2 0 0 1 1.5-.68Z"/><path d="m11.5 9.5 5 5m0-5-5 5"/></svg>
        </button>
      </div>
    </div>`);

  const dots = [...view.querySelectorAll('.dot')];
  const dotRow = view.querySelector('.dots');
  const msg = view.querySelector('.pin__msg');
  const pad = view.querySelector('.keypad');
  const paint = () => dots.forEach((d, i) => d.classList.toggle('is-filled', i < digits.length));
  const setDisabled = (on) => pad.querySelectorAll('button').forEach((b) => (b.disabled = on));

  const fail = (text) => {
    haptic('warning');
    dotRow.classList.remove('is-shaking');
    dotRow.getBoundingClientRect();
    dotRow.classList.add('is-shaking');
    setTimeout(() => {
      digits = '';
      paint();
    }, reducedMotion.matches ? 0 : 380);
    msg.textContent = text;
  };

  const startLockout = (seconds) => {
    setDisabled(true);
    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      msg.textContent = `Too many attempts. Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
      if (!left) {
        stopCountdown();
        setDisabled(false);
        msg.textContent = '';
      }
    };
    stopCountdown();
    countdown = setInterval(tick, 1000);
    tick();
  };

  const submit = async () => {
    busy = true;
    dotRow.classList.add('is-checking');
    try {
      const result = await onPin(digits);
      if (result === 'done') {
        haptic('success');
        dotRow.classList.add('is-success');
        await hideLock();
      }
    } catch (err) {
      if (err.code === 'locked') {
        fail('');
        startLockout(err.retryAfter || 300);
      } else if (err.code === 'auth') {
        fail(err.triesLeft ? `Wrong username or PIN. ${err.triesLeft} ${err.triesLeft === 1 ? 'try' : 'tries'} left.` : err.message);
      } else if (err.code === 'network') {
        fail('Can’t reach the Sheet. Check your connection.');
      } else fail(err.message);
    } finally {
      busy = false;
      dotRow.classList.remove('is-checking');
    }
  };

  const press = (d) => {
    if (busy || digits.length >= PIN_LENGTH) return;
    haptic('light');
    digits += d;
    paint();
    if (msg.textContent && !countdown) msg.textContent = '';
    if (digits.length === PIN_LENGTH) setTimeout(submit, 120);
  };
  const del = () => {
    if (busy || !digits) return;
    digits = digits.slice(0, -1);
    paint();
  };

  pad.addEventListener('click', (e) => {
    const key = e.target.closest('button');
    if (!key || key.disabled) return;
    if (key.dataset.digit) press(key.dataset.digit);
    else if ('delete' in key.dataset) del();
  });
  view.querySelector('[data-back]').addEventListener('click', () => (leave ? leave.fn() : back()));
  setKeys((e) => {
    if (/^\d$/.test(e.key) && !pad.querySelector('button').disabled) press(e.key);
    else if (e.key === 'Backspace') del();
    else if (e.key === 'Escape' && back) back();
  });
  pad.querySelector('[data-digit="1"]').focus({ preventScroll: true });
}
