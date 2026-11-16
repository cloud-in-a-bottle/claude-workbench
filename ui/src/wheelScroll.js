// Trackpad scrolling for programs that scroll themselves -- Claude Code's full-screen view, or
// anything else in the alternate buffer.
//
// xterm 6 turns a pixel-mode wheel event (a trackpad) into wheel reports or arrow keys through
// `consumeWheelEvent`, which scales deltas under 50px by 0.3 to tame trackpads, drops that factor
// at 50px and up, and then sends at most one report per event however far it computed. So a slow
// swipe sends one report per three-odd lines of travel and barely moves, while a fast one sends a
// report on every event -- which Claude Code's wheel acceleration, built for a notched mouse,
// ramps up to six lines each. Between them, speed grew far faster than the fingers. Here pixel
// deltas are added up instead and every line-height of travel becomes one wheel notch, so the
// program scrolls in step with the fingers, the way the normal buffer's scrollback does.
//
// That only holds with Claude Code's acceleration off, which would ramp the denser stream of
// reports even harder, so the workbench defaults `wheelScrollAccelerationEnabled` off
// (claude-home/install_agent_hooks.py).

/** Make pixel-mode wheel events over `host` (the element xterm is opened in) reach `term`'s
 *  program as one wheel notch per line of travel. Line- and page-mode wheels (a mouse), the normal
 *  buffer's own scrollback, and ctrl-wheel (a pinch) are left to xterm. */
export function attachWheelScroll(host, term) {
  // The events dispatched below, which xterm should handle as it would any mouse wheel.
  const ours = new WeakSet();
  // Pixels scrolled that haven't added up to a whole line yet.
  let carry = 0;

  const lineHeight = () => {
    const rows = host.querySelector('.xterm-rows');
    return rows && term.rows ? rows.getBoundingClientRect().height / term.rows || 18 : 18;
  };

  term.attachCustomWheelEventHandler((e) => {
    if (ours.has(e)) return true;
    const program = term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type === 'alternate';
    if (!program || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || e.ctrlKey || e.shiftKey) {
      carry = 0;
      return true;
    }
    e.preventDefault();
    if (Math.sign(e.deltaY) !== Math.sign(carry)) carry = 0; // a reversal starts afresh
    carry += e.deltaY;
    const h = lineHeight();
    const lines = Math.trunc(carry / h);
    carry -= lines * h;
    for (let i = 0; i < Math.abs(lines); i++) {
      const notch = new WheelEvent('wheel', {
        deltaY: Math.sign(lines),
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: e.clientX,
        clientY: e.clientY,
        altKey: e.altKey,
        metaKey: e.metaKey,
        bubbles: true,
        cancelable: true,
      });
      ours.add(notch);
      e.target.dispatchEvent(notch);
    }
    return false;
  });
}
