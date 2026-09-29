// Reusable UI primitives: icons, logos, haptics, number animation, sheets, alerts, toasts.
import { getTeam } from './teams.js';

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const desktop = matchMedia('(min-width: 768px)');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- icons (SF Symbols–style line icons, 1.5px stroke) ----------

const ICONS = {
  dashboard:
    '<rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.75"/><rect x="13.75" y="3.75" width="6.5" height="6.5" rx="1.75"/><rect x="3.75" y="13.75" width="6.5" height="6.5" rx="1.75"/><rect x="13.75" y="13.75" width="6.5" height="6.5" rx="1.75"/>',
  log: '<circle cx="12" cy="12" r="8.75"/><path d="M12 8v8M8 12h8"/>',
  history: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.5V12l3 2"/>',
  settings:
    '<path d="M12.22 2.75h-.44a1.75 1.75 0 0 0-1.75 1.75v.16a1.75 1.75 0 0 1-.88 1.51l-.38.22a1.75 1.75 0 0 1-1.75 0l-.13-.07a1.75 1.75 0 0 0-2.39.64l-.22.38a1.75 1.75 0 0 0 .64 2.39l.13.09a1.75 1.75 0 0 1 .88 1.5v.45a1.75 1.75 0 0 1-.88 1.52l-.13.08a1.75 1.75 0 0 0-.64 2.39l.22.38a1.75 1.75 0 0 0 2.39.64l.13-.07a1.75 1.75 0 0 1 1.75 0l.38.22a1.75 1.75 0 0 1 .88 1.51v.16a1.75 1.75 0 0 0 1.75 1.75h.44a1.75 1.75 0 0 0 1.75-1.75v-.16a1.75 1.75 0 0 1 .88-1.51l.38-.22a1.75 1.75 0 0 1 1.75 0l.13.07a1.75 1.75 0 0 0 2.39-.64l.22-.39a1.75 1.75 0 0 0-.64-2.39l-.13-.07a1.75 1.75 0 0 1-.88-1.52v-.44a1.75 1.75 0 0 1 .88-1.52l.13-.08a1.75 1.75 0 0 0 .64-2.39l-.22-.38a1.75 1.75 0 0 0-2.39-.64l-.13.07a1.75 1.75 0 0 1-1.75 0l-.38-.22a1.75 1.75 0 0 1-.88-1.51V4.5a1.75 1.75 0 0 0-1.75-1.75z"/><circle cx="12" cy="12" r="2.75"/>',
  search: '<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.5 15.5 4.75 4.75"/>',
  trash:
    '<path d="M4.75 6.75h14.5M9.75 6.75V5a1.25 1.25 0 0 1 1.25-1.25h2A1.25 1.25 0 0 1 14.25 5v1.75M6.5 6.75l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1M10 10.5v6M14 10.5v6"/>',
  export:
    '<path d="M12 14.75v-11M8.25 7.5 12 3.75l3.75 3.75M8.5 10.25H6.75a1.5 1.5 0 0 0-1.5 1.5v7a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H15.5"/>',
  import:
    '<path d="M12 3.75v11M8.25 11 12 14.75 15.75 11M8.5 10.25H6.75a1.5 1.5 0 0 0-1.5 1.5v7a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H15.5"/>',
  basketball:
    '<circle cx="12" cy="12" r="8.75"/><path d="M12 3.25v17.5M3.25 12h17.5M5.8 5.8c1.7 1.7 2.7 3.8 2.7 6.2s-1 4.5-2.7 6.2M18.2 5.8c-1.7 1.7-2.7 3.8-2.7 6.2s1 4.5 2.7 6.2"/>',
  rematch:
    '<path d="M4.75 12a7.25 7.25 0 0 1 12.7-4.8M19.25 12a7.25 7.25 0 0 1-12.7 4.8"/><path d="M17.75 3.75v3.75H14M6.25 20.25V16.5H10"/>',
  chevron: '<path d="m9.5 5.75 6.25 6.25-6.25 6.25"/>',
  key: '<circle cx="8" cy="15.5" r="4.25"/><path d="m11 12.5 8.25-8.25M16.25 7.25l2.5 2.5M14 9.5l2 2"/>',
  more: '<circle cx="12" cy="12" r="8.75"/><circle cx="8.25" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15.75" cy="12" r="1" fill="currentColor" stroke="none"/>',
  block: '<circle cx="12" cy="12" r="8.75"/><path d="m5.8 5.8 12.4 12.4"/>',
  people: '<circle cx="9" cy="8.5" r="3.25"/><path d="M3.25 19.25c.6-3.1 2.9-5 5.75-5s5.15 1.9 5.75 5"/><circle cx="16.75" cy="9.25" r="2.5"/><path d="M15.5 14.4c.4-.1.8-.15 1.25-.15 2.2 0 3.95 1.5 4.5 4"/>',
  offline: '<path d="M2.5 8.8a14 14 0 0 1 19 0M5.75 12.3a9.3 9.3 0 0 1 12.5 0M9 15.7a4.6 4.6 0 0 1 6 0M12 19.25h.01M4 4l16 16"/>',
  alert: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.75v5M12 16.25h.01"/>',
  check: '<path d="m5.75 12.5 4 4 8.5-9"/>',
  clock: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.5V12l3 2"/>',
  refresh: '<path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13M19.25 4.75v4.5h-4.5"/>',
  clear: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m9.25 9.25 5.5 5.5m0-5.5-5.5 5.5" stroke="var(--icon-knockout)" stroke-width="1.75"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// ---------- team logos with graceful fallback ----------

/**
 * Logo tile. `alt` defaults to the team name; pass '' when the name is already present as text.
 * If the image is missing or fails, a circle with the abbreviation on the team colour is shown instead.
 */
export function logo(abbr, { size = 'md', alt, lazy = false } = {}) {
  const team = getTeam(abbr);
  if (!team) return `<span class="logo logo--${size} logo--empty" aria-hidden="true"></span>`;
  const label = alt ?? team.name;
  return `<span class="logo logo--${size}" style="--team:${team.color}" data-abbr="${team.abbr}"><img src="${team.logo}" alt="${esc(label)}" width="256" height="256" decoding="async"${lazy ? ' loading="lazy"' : ''} draggable="false"></span>`;
}

function fallbackLogo(img) {
  const tile = img.closest('.logo');
  if (!tile || tile.classList.contains('is-fallback')) return;
  const abbr = tile.dataset.abbr;
  const badge = document.createElement('span');
  badge.className = 'logo__fallback';
  badge.textContent = abbr;
  if (img.alt) {
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', img.alt);
  } else badge.setAttribute('aria-hidden', 'true');
  tile.classList.add('is-fallback');
  img.replaceWith(badge);
}

// `error` doesn't bubble, so listen in the capture phase for every logo on the page.
document.addEventListener('error', (e) => e.target.matches?.('.logo img') && fallbackLogo(e.target), true);

// ---------- haptics ----------

let hapticSwitch;
/** Best-effort haptic tick. Android: Vibration API. iOS 18+: toggling a native switch plays a system haptic. */
export function haptic(kind = 'light') {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // browsers block it before the first tap
    if (navigator.vibrate) {
      navigator.vibrate({ light: 8, medium: 14, success: [8, 50, 12], warning: [20, 60, 20] }[kind] ?? 8);
      return;
    }
    if (!matchMedia('(pointer: coarse)').matches) return;
    if (!hapticSwitch) {
      hapticSwitch = document.createElement('label');
      hapticSwitch.className = 'visually-hidden';
      hapticSwitch.setAttribute('aria-hidden', 'true');
      hapticSwitch.innerHTML = '<input type="checkbox" switch tabindex="-1">';
      document.body.append(hapticSwitch);
    }
    hapticSwitch.click();
  } catch {
    /* no haptics available */
  }
}

// ---------- numbers ----------

const MINUS = '−';
export function formatNumber(value, { decimals = 0, signed = false } = {}) {
  const abs = Math.abs(value).toFixed(decimals);
  if (!signed) return (value < 0 ? MINUS : '') + abs;
  if (Number(abs) === 0) return abs;
  return (value > 0 ? '+' : MINUS) + abs;
}

/** Animates every [data-to] element from its [data-from] value. */
export function animateNumbers(root) {
  const els = [...root.querySelectorAll('[data-to]')];
  const fmt = (el, v) => formatNumber(v, { decimals: +el.dataset.decimals || 0, signed: 'signed' in el.dataset });
  if (reducedMotion.matches) {
    els.forEach((el) => (el.textContent = fmt(el, +el.dataset.to)));
    return;
  }
  const start = performance.now();
  const duration = 800;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    for (const el of els) {
      const from = +el.dataset.from || 0;
      const to = +el.dataset.to;
      el.textContent = fmt(el, t === 1 ? to : from + (to - from) * ease(t));
    }
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- modal stack (sheets + alerts) ----------

const layer = () => document.getElementById('layer');
const app = () => document.getElementById('app');
const stack = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea, select, [tabindex]:not([tabindex="-1"])';

function syncInert() {
  app().inert = stack.length > 0;
  stack.forEach((entry, i) => (entry.root.inert = i < stack.length - 1));
  document.documentElement.classList.toggle('has-modal', stack.length > 0);
  const sheets = stack.filter((s) => s.kind === 'sheet');
  sheets.forEach((s, i) => s.root.classList.toggle('is-behind', i < sheets.length - 1));
}

function push(entry) {
  entry.returnFocus = document.activeElement;
  stack.push(entry);
  syncInert();
}

function pop(entry) {
  const i = stack.indexOf(entry);
  if (i !== -1) stack.splice(i, 1);
  syncInert();
  entry.returnFocus?.focus?.({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  const top = stack.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    top.dismiss();
  } else if (e.key === 'Tab') {
    const items = [...top.root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }
});

const afterTransition = (el, ms) =>
  new Promise((resolve) => {
    const done = () => (clearTimeout(timer), el.removeEventListener('transitionend', onEnd), resolve());
    const onEnd = (e) => e.target === el && done();
    const timer = setTimeout(done, ms);
    el.addEventListener('transitionend', onEnd);
  });

/**
 * Bottom sheet on phones, centred modal on wider screens.
 * `content` is an element containing `.sheet__header` and `.sheet__body`.
 */
export function openSheet({ content, labelledBy, large = false, onClose, initialFocus }) {
  current?.dismiss(); // a toast shouldn't float over the sheet
  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.innerHTML = `<div class="sheet-backdrop"></div>
    <div class="sheet${large ? ' sheet--large' : ''}" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}" tabindex="-1">
      <div class="sheet__grabber" aria-hidden="true"></div>
    </div>`;
  const sheet = root.querySelector('.sheet');
  const backdrop = root.querySelector('.sheet-backdrop');
  sheet.append(content);
  layer().append(root);

  let closed = false;
  const entry = { kind: 'sheet', root, dismiss: () => close() };
  push(entry);

  root.getBoundingClientRect(); // commit the start state so the open transition runs
  root.classList.add('is-open');
  const focusTarget = (desktop.matches && initialFocus && sheet.querySelector(initialFocus)) || sheet;
  focusTarget.focus({ preventScroll: true });

  async function close(result) {
    if (closed) return;
    closed = true;
    sheet.style.transform = '';
    sheet.style.transition = '';
    backdrop.style.opacity = '';
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    pop(entry);
    onClose?.(result);
    await afterTransition(sheet, 450);
    root.remove();
  }

  backdrop.addEventListener('click', () => close());
  enableDrag({ root, sheet, backdrop, close });
  return { close, root, sheet };
}

/** Drag-to-dismiss: from the grabber/header anywhere, or from the body when it's scrolled to the top. */
function enableDrag({ sheet, backdrop, close }) {
  let startY = 0, dy = 0, dragging = false, samples = [];
  const body = () => sheet.querySelector('.sheet__body');

  const begin = (y) => {
    startY = y;
    dy = 0;
    samples = [{ y, t: performance.now() }];
  };
  const move = (y) => {
    dy = y - startY;
    if (!dragging && dy > 6) {
      dragging = true;
      sheet.style.transition = 'none';
      backdrop.style.transition = 'none';
    }
    if (!dragging) return false;
    const offset = dy > 0 ? dy : dy / 6; // rubber-band upwards
    sheet.style.transform = `translate3d(0, ${offset}px, 0)`;
    backdrop.style.opacity = String(Math.max(0, 1 - dy / sheet.offsetHeight));
    samples.push({ y, t: performance.now() });
    if (samples.length > 5) samples.shift();
    return true;
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const first = samples[0], last = samples.at(-1);
    const velocity = (last.y - first.y) / Math.max(1, last.t - first.t); // px/ms
    sheet.style.transition = '';
    backdrop.style.transition = '';
    if (dy > sheet.offsetHeight * 0.28 || velocity > 0.6) close();
    else {
      sheet.style.transform = '';
      backdrop.style.opacity = '';
    }
  };

  // Grabber + header: pointer events (also works with a mouse)
  sheet.addEventListener('pointerdown', (e) => {
    if (desktop.matches || !e.target.closest('.sheet__header, .sheet__grabber')) return;
    if (e.target.closest('input, textarea')) return;
    begin(e.clientY);
    const onMove = (ev) => {
      if (move(ev.clientY)) sheet.setPointerCapture?.(e.pointerId);
    };
    const onUp = () => {
      const wasDragging = dragging;
      end();
      if (wasDragging) {
        const block = (ev) => ev.stopPropagation();
        sheet.addEventListener('click', block, { capture: true, once: true });
        setTimeout(() => sheet.removeEventListener('click', block, { capture: true }), 60);
      }
      sheet.removeEventListener('pointermove', onMove);
      sheet.removeEventListener('pointerup', onUp);
      sheet.removeEventListener('pointercancel', onUp);
    };
    sheet.addEventListener('pointermove', onMove);
    sheet.addEventListener('pointerup', onUp);
    sheet.addEventListener('pointercancel', onUp);
  });

  // Body: touch events so we can take over from native scrolling only at scrollTop 0
  let tracking = false;
  sheet.addEventListener(
    'touchstart',
    (e) => {
      const b = body();
      tracking = !desktop.matches && b?.contains(e.target) && b.scrollTop <= 0 && !e.target.closest('input, textarea');
      if (tracking) begin(e.touches[0].clientY);
    },
    { passive: true },
  );
  sheet.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking) return;
      const y = e.touches[0].clientY;
      if (!dragging && y < startY) return (tracking = false); // scrolling up: let the list scroll
      if (move(y) && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  sheet.addEventListener('touchend', () => tracking && (end(), (tracking = false)));
  sheet.addEventListener('touchcancel', () => tracking && (end(), (tracking = false)));
}

/** iOS-style alert. Resolves with the chosen action's `value` (cancel → null). */
export function alertDialog({ title, message = '', actions }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'alert-root';
    const stacked = actions.length > 2;
    root.innerHTML = `<div class="alert-backdrop"></div>
      <div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-title" aria-describedby="alert-msg">
        <div class="alert__text"><h2 id="alert-title">${esc(title)}</h2>${message ? `<p id="alert-msg">${esc(message)}</p>` : ''}</div>
        <div class="alert__actions${stacked ? ' is-stacked' : ''}">
          ${actions.map((a, i) => `<button type="button" class="alert__btn alert__btn--${a.style || 'default'}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
    layer().append(root);
    const cancel = actions.find((a) => a.style === 'cancel');
    const entry = { kind: 'alert', root, dismiss: () => finish(cancel ? cancel.value : null) };
    push(entry);
    root.getBoundingClientRect();
    root.classList.add('is-open');
    (root.querySelector('.alert__btn--cancel') || root.querySelector('.alert__btn')).focus();

    let done = false;
    async function finish(value) {
      if (done) return;
      done = true;
      root.classList.remove('is-open');
      pop(entry);
      resolve(value);
      await afterTransition(root.querySelector('.alert'), 300);
      root.remove();
    }
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.alert__btn');
      if (btn) finish(actions[+btn.dataset.i].value);
    });
  });
}

/**
 * Pop-up window: a centred card with a title and an × in the top-right, for read-only lists.
 * Closes on ×, the backdrop, or Escape.
 */
export function openPopup({ title, subtitle = '', body }) {
  current?.dismiss();
  const root = document.createElement('div');
  root.className = 'popup-root';
  root.innerHTML = `<div class="popup-backdrop"></div>
    <div class="popup" role="dialog" aria-modal="true" aria-labelledby="popup-title">
      <div class="popup__head">
        <div class="popup__titles"><h2 id="popup-title" class="popup__title">${esc(title)}</h2>${subtitle ? `<p class="popup__sub">${esc(subtitle)}</p>` : ''}</div>
        <button type="button" class="popup__close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
      </div>
      <div class="popup__body">${body}</div>
    </div>`;
  layer().append(root);
  let closed = false;
  const entry = { kind: 'popup', root, dismiss: () => close() };
  push(entry);
  root.getBoundingClientRect();
  root.classList.add('is-open');
  root.querySelector('.popup__close').focus({ preventScroll: true });
  async function close() {
    if (closed) return;
    closed = true;
    root.classList.remove('is-open');
    pop(entry);
    await afterTransition(root.querySelector('.popup'), 300);
    root.remove();
  }
  root.querySelector('.popup__close').addEventListener('click', close);
  root.querySelector('.popup-backdrop').addEventListener('click', close);
  return { close, root };
}

// ---------- toast ----------

let current = null;
export function toast(message, { action, duration = 5000 } = {}) {
  current?.dismiss();
  const region = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast__msg">${esc(message)}</span>${action ? `<button type="button" class="toast__action">${esc(action.label)}</button>` : ''}`;
  region.append(el);
  el.getBoundingClientRect();
  el.classList.add('is-visible');

  let timer = setTimeout(() => dismiss(), duration);
  const self = { dismiss };
  current = self;
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => (timer = setTimeout(() => dismiss(), 2500)));
  el.querySelector('.toast__action')?.addEventListener('click', () => {
    action.onClick();
    haptic('light');
    dismiss();
  });

  async function dismiss() {
    clearTimeout(timer);
    if (current === self) current = null;
    el.classList.remove('is-visible');
    await afterTransition(el, 400);
    el.remove();
  }
  return self;
}
