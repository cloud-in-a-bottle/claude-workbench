// Swipe to scroll a terminal. xterm 6 scrolls with a wheel or a scrollbar but not a finger, so on
// a phone the scrollback -- most of a Claude conversation -- was out of reach.

/** How far a finger has to travel before the touch counts as a scroll rather than a tap, which
 *  must still reach xterm to focus it and bring up the keyboard. */
const SLOP_PX = 8;
/** Fling: how much of its velocity a released swipe keeps each frame, and when it stops. */
const FRICTION = 0.95;
const MIN_VELOCITY = 0.02; // px per ms

/** Make `host` (the element xterm is opened in) scroll `term` when swiped. Returns a disposer.
 *
 *  In the normal buffer that moves through scrollback. A full-screen program (vim, less) runs in the
 *  alternate buffer, which has none, so there it sends arrow keys instead -- what xterm does with a
 *  wheel in the same place. */
export function attachTouchScroll(host, term, send) {
  let startY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let scrolling = false;
  // Pixels moved that haven't added up to a whole line yet.
  let carry = 0;
  let fling = 0;

  const lineHeight = () => {
    const rows = host.querySelector('.xterm-rows');
    return rows && term.rows ? rows.getBoundingClientRect().height / term.rows || 18 : 18;
  };

  /** Scroll by a finger movement of `dy` pixels; positive is a swipe down, which shows older lines. */
  function scrollBy(dy) {
    carry += dy;
    const h = lineHeight();
    const lines = Math.trunc(carry / h);
    if (!lines) return;
    carry -= lines * h;
    if (term.buffer.active.type === 'alternate') {
      const up = lines > 0;
      const app = term.modes.applicationCursorKeysMode;
      const key = up ? (app ? '\x1bOA' : '\x1b[A') : app ? '\x1bOB' : '\x1b[B';
      send(key.repeat(Math.abs(lines)));
    } else {
      term.scrollLines(-lines);
    }
  }

  function onStart(e) {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(fling);
    startY = lastY = e.touches[0].clientY;
    lastTime = e.timeStamp;
    velocity = 0;
    carry = 0;
    scrolling = false;
  }

  function onMove(e) {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!scrolling && Math.abs(y - startY) < SLOP_PX) return;
    scrolling = true;
    // Ours from here on: the page has nothing to scroll, and xterm would read it as a selection.
    e.preventDefault();
    e.stopPropagation();
    const dt = Math.max(1, e.timeStamp - lastTime);
    velocity = 0.8 * ((y - lastY) / dt) + 0.2 * velocity;
    scrollBy(y - lastY);
    lastY = y;
    lastTime = e.timeStamp;
  }

  function onEnd(e) {
    if (!scrolling) return;
    // A scroll that ends is not a tap: don't let it place the cursor or raise the keyboard.
    e.preventDefault();
    e.stopPropagation();
    scrolling = false;
    let prev = performance.now();
    const step = (now) => {
      const dt = now - prev;
      prev = now;
      velocity *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(velocity) < MIN_VELOCITY) return;
      scrollBy(velocity * dt);
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  }

  // Capture phase and not passive, so a scroll is claimed before xterm's own handlers see it.
  const opts = { capture: true, passive: false };
  host.addEventListener('touchstart', onStart, opts);
  host.addEventListener('touchmove', onMove, opts);
  host.addEventListener('touchend', onEnd, opts);
  host.addEventListener('touchcancel', onEnd, opts);
  return () => {
    cancelAnimationFrame(fling);
    host.removeEventListener('touchstart', onStart, opts);
    host.removeEventListener('touchmove', onMove, opts);
    host.removeEventListener('touchend', onEnd, opts);
    host.removeEventListener('touchcancel', onEnd, opts);
  };
}
