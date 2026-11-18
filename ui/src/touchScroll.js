// Touch on a terminal: swipe to scroll, tap to focus, long-press to select and copy. xterm 6
// scrolls with a wheel or a scrollbar but not a finger, and selects with a mouse but not a finger,
// so on a phone the scrollback -- most of a Claude conversation -- and copying were out of reach.

/** How far a finger has to travel before the touch counts as a scroll rather than a tap. */
const SLOP_PX = 8;
/** How long a finger has to rest, within the slop, for the touch to start a selection. */
const LONG_PRESS_MS = 450;
/** Fling: how much of its velocity a released swipe keeps each frame, and when it stops. */
const FRICTION = 0.95;
const MIN_VELOCITY = 0.02; // px per ms

/** Make `host` (the element xterm is opened in) handle touch for `term`. Returns a disposer.
 *
 *  A swipe does what a mouse wheel would. In the normal buffer that moves through scrollback. A
 *  program that has asked for mouse input -- Claude Code's full-screen view, say -- gets wheel
 *  events, and scrolls itself. A full-screen program that hasn't (less, a plain vim) runs in the
 *  alternate buffer, which has no scrollback, so it gets arrow keys.
 *
 *  A long press selects the word under the finger; dragging on from there extends the selection,
 *  and lifting the finger hands the selected text to `onCopy`. The selection is xterm's own, made
 *  with term.select(), so it works even while the program has the mouse.
 *
 *  Every touch has its default prevented from the start, so the browser never focuses xterm's
 *  textarea on its own -- left to it, a swipe that began on the textarea raised the keyboard. That
 *  also leaves a tap with no click for xterm to see, so what a tap does (follow a link, or focus
 *  the terminal) is `onTap`'s call, with the touch's client coordinates. A tap that stops a fling
 *  just stops it.
 *
 *  Whether a touch was a tap is decided from where it started and ended, not from the touchmoves in
 *  between: Chrome on Android holds touchmoves back inside its own slop and coalesces the rest to
 *  frames, so a quick flick can end without the page having seen it move at all -- and was taken
 *  for a tap, raising the keyboard mid-scroll. */
export function attachTouchScroll(host, term, send, onTap, onCopy) {
  let startX = 0;
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
  let pressTimer = 0;
  // While selecting: the buffer cell (as a linear index, row * cols + col) the long press landed
  // on, and the extent of the word there, which the selection always keeps covering.
  let selecting = false;
  let anchor = null;

  const lineHeight = () => {
    const rows = host.querySelector('.xterm-rows');
    return rows && term.rows ? rows.getBoundingClientRect().height / term.rows || 18 : 18;
  };

  /** The buffer cell under a point, as a linear index into the buffer (row * cols + col). */
  function cellAt(x, y) {
    const screen = host.querySelector('.xterm-screen') || host;
    const rect = screen.getBoundingClientRect();
    const col = Math.min(term.cols - 1, Math.max(0, Math.floor(((x - rect.left) / rect.width) * term.cols)));
    const row = Math.min(term.rows - 1, Math.max(0, Math.floor(((y - rect.top) / rect.height) * term.rows)));
    return (term.buffer.active.viewportY + row) * term.cols + col;
  }

  /** The run of non-blank characters around a cell, as [start, end) linear indices. A blank cell
   *  is a word of its own. */
  function wordAt(index) {
    const row = Math.floor(index / term.cols);
    const col = index % term.cols;
    const text = term.buffer.active.getLine(row)?.translateToString(false) || '';
    const blank = (c) => /\s/.test(text[c] || ' ');
    if (blank(col)) return [index, index + 1];
    let from = col;
    let to = col + 1;
    while (from > 0 && !blank(from - 1)) from--;
    while (to < term.cols && !blank(to)) to++;
    return [row * term.cols + from, row * term.cols + to];
  }

  function selectRange(from, to) {
    const cols = term.cols;
    term.select(from % cols, Math.floor(from / cols), to - from);
  }

  function startSelection() {
    pressTimer = 0;
    if (!tracking || scrolling) return;
    selecting = true;
    anchor = wordAt(cellAt(lastX, lastY));
    selectRange(anchor[0], anchor[1]);
    navigator.vibrate?.(10);
  }

  function extendSelection(x, y) {
    const cell = cellAt(x, y);
    selectRange(Math.min(anchor[0], cell), Math.max(anchor[1], cell + 1));
  }

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

  const moved = (x, y) => Math.hypot(x - startX, y - startY) >= SLOP_PX;

  function onStart(e) {
    e.preventDefault();
    clearTimeout(pressTimer);
    pressTimer = 0;
    selecting = false;
    tracking = e.touches.length === 1;
    if (!tracking) return;
    stoppedFling = flinging;
    cancelAnimationFrame(fling);
    flinging = false;
    startX = lastX = e.touches[0].clientX;
    startY = lastY = e.touches[0].clientY;
    lastTime = e.timeStamp;
    velocity = 0;
    carry = 0;
    scrolling = false;
    if (!stoppedFling) pressTimer = setTimeout(startSelection, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (e.touches.length !== 1 || !tracking) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    if (selecting) {
      e.preventDefault();
      e.stopPropagation();
      lastX = x;
      lastY = y;
      extendSelection(x, y);
      return;
    }
    if (!scrolling && !moved(x, y)) return;
    if (!scrolling) {
      clearTimeout(pressTimer);
      pressTimer = 0;
      scrolling = true;
    }
    // Ours from here on: the page has nothing to scroll, and xterm would read it as a selection.
    e.preventDefault();
    e.stopPropagation();
    const dt = Math.max(1, e.timeStamp - lastTime);
    velocity = 0.8 * ((y - lastY) / dt) + 0.2 * velocity;
    lastX = x;
    scrollBy(y - lastY);
    lastY = y;
    lastTime = e.timeStamp;
  }

  function onEnd(e) {
    e.preventDefault();
    clearTimeout(pressTimer);
    pressTimer = 0;
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    if (selecting) {
      selecting = false;
      e.stopPropagation();
      // Copied here, inside the touchend: writing the clipboard needs the user's gesture.
      if (e.type === 'touchend') {
        const text = term.getSelection();
        if (text) onCopy?.(text);
      }
      return;
    }
    if (!scrolling) {
      // A flick whose moves never reached the page: not a tap, and nothing to fling either.
      if (touch && moved(touch.clientX, touch.clientY)) {
        e.stopPropagation();
        scrollBy(touch.clientY - lastY);
        return;
      }
      if (e.type === 'touchend' && !stoppedFling && touch) {
        term.clearSelection();
        onTap(touch.clientX, touch.clientY);
      }
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

  /** Chrome on Android fires contextmenu when a finger rests for half a second, however much of the
   *  touch has had its default prevented. xterm takes that for a right-click: it moves its textarea
   *  under the finger and focuses it, which raises the keyboard -- at the start of any swipe that
   *  began with a pause, and under every long-press selection. Swallowed before xterm sees it. A
   *  real right-click (a mouse, a desktop) still gets through. */
  let lastTouch = -Infinity;
  function onContextMenu(e) {
    if (e.pointerType === 'touch' || tracking || e.timeStamp - lastTouch < 1000) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  const noteTouch = (e) => {
    lastTouch = e.timeStamp;
  };

  // Capture phase and not passive, so a scroll is claimed before xterm's own handlers see it.
  const opts = { capture: true, passive: false };
  host.addEventListener('contextmenu', onContextMenu, true);
  host.addEventListener('touchend', noteTouch, true);
  host.addEventListener('touchstart', onStart, opts);
  host.addEventListener('touchmove', onMove, opts);
  host.addEventListener('touchend', onEnd, opts);
  host.addEventListener('touchcancel', onEnd, opts);
  return () => {
    clearTimeout(pressTimer);
    cancelAnimationFrame(fling);
    host.removeEventListener('touchstart', onStart, opts);
    host.removeEventListener('touchmove', onMove, opts);
    host.removeEventListener('touchend', onEnd, opts);
    host.removeEventListener('touchcancel', onEnd, opts);
    host.removeEventListener('contextmenu', onContextMenu, true);
    host.removeEventListener('touchend', noteTouch, true);
  };
}
