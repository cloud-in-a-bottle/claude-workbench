// Swipe to scroll a terminal. xterm 6 scrolls with a wheel or a scrollbar but not a finger, so on
// a phone the scrollback -- most of a Claude conversation -- was out of reach.

/** How far a finger has to travel before the touch counts as a scroll rather than a tap. */
const SLOP_PX = 8;
/** Fling: how much of its velocity a released swipe keeps each frame, and when it stops. */
const FRICTION = 0.95;
const MIN_VELOCITY = 0.02; // px per ms

/** Make `host` (the element xterm is opened in) scroll `term` when swiped, and call `onTap` with
 *  the touch's client coordinates when it is tapped. Returns a disposer.
 *
 *  It does what a mouse wheel would. In the normal buffer that moves through scrollback. A program
 *  that has asked for mouse input -- Claude Code's full-screen view, say -- gets wheel events, and
 *  scrolls itself. A full-screen program that hasn't (less, a plain vim) runs in the alternate
 *  buffer, which has no scrollback, so it gets arrow keys.
 *
 *  Every touch has its default prevented from the start, so the browser never focuses xterm's
 *  textarea on its own -- left to it, a swipe that began on the textarea raised the keyboard. That
 *  also leaves a tap with no click for xterm to see, so what a tap does (follow a link, or focus
 *  the terminal) is `onTap`'s call. A tap that stops a fling just stops it. */
export function attachTouchScroll(host, term, send, onTap) {
  let startY = 0;
  // Where the finger is across, for the column a wheel event is reported at.
  let lastX = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let scrolling = false;
  // Pixels moved that haven't added up to a whole line yet.
  let carry = 0;
  let fling = 0;
  let flinging = false;
  // Set by a single-finger touchstart, so a lifted second finger isn't mistaken for a tap.
  let tracking = false;
  let stoppedFling = false;

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
    if (term.modes.mouseTrackingMode !== 'none') {
      wheel(lines);
    } else if (term.buffer.active.type === 'alternate') {
      const up = lines > 0;
      const app = term.modes.applicationCursorKeysMode;
      const key = up ? (app ? '\x1bOA' : '\x1b[A') : app ? '\x1bOB' : '\x1b[B';
      send(key.repeat(Math.abs(lines)));
    } else {
      term.scrollLines(-lines);
    }
  }

  /** Hand `lines` wheel notches to xterm at the finger's position (positive is towards older output,
   *  i.e. wheel up), and let it report them in whichever mouse protocol the program asked for. */
  function wheel(lines) {
    const rect = host.getBoundingClientRect();
    const target =
      document.elementFromPoint(lastX, Math.min(Math.max(lastY, rect.top + 1), rect.bottom - 1)) || host;
    if (!host.contains(target)) return;
    for (let i = 0; i < Math.abs(lines); i++) {
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: lines > 0 ? -1 : 1,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: lastX,
          clientY: lastY,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  function onStart(e) {
    e.preventDefault();
    tracking = e.touches.length === 1;
    if (!tracking) return;
    stoppedFling = flinging;
    cancelAnimationFrame(fling);
    flinging = false;
    startY = lastY = e.touches[0].clientY;
    lastX = e.touches[0].clientX;
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
    lastX = e.touches[0].clientX;
    scrollBy(y - lastY);
    lastY = y;
    lastTime = e.timeStamp;
  }

  function onEnd(e) {
    e.preventDefault();
    if (!tracking) return;
    tracking = false;
    if (!scrolling) {
      const touch = e.changedTouches[0];
      if (e.type === 'touchend' && !stoppedFling && touch) onTap(touch.clientX, touch.clientY);
      return;
    }
    e.stopPropagation();
    scrolling = false;
    let prev = performance.now();
    const step = (now) => {
      const dt = now - prev;
      prev = now;
      velocity *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(velocity) < MIN_VELOCITY) {
        flinging = false;
        return;
      }
      scrollBy(velocity * dt);
      fling = requestAnimationFrame(step);
    };
    flinging = true;
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
