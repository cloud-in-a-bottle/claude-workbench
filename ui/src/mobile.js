import { createSignal } from 'solid-js';

// Narrow enough that a 220px rail beside the terminal leaves it unusable. Width rather than
// `pointer: coarse`, so a tablet gets the desktop layout and a narrowed desktop window gets this one.
const QUERY = '(max-width: 760px)';

const media = window.matchMedia(QUERY);
const [isMobile, setIsMobile] = createSignal(media.matches);
media.addEventListener('change', (e) => setIsMobile(e.matches));

/** On a phone the projects rail is a drawer over the terminal, closed until asked for. Not saved:
 *  every visit should open on the terminal. */
const [drawerOpen, setDrawerOpen] = createSignal(false);

/** On a phone the side panel takes the terminal's place rather than sitting beside it, so it only
 *  shows when tapped open, never because Claude pointed it somewhere. */
const [mobilePanelOpen, setMobilePanelOpen] = createSignal(false);

/** The Ctrl key on the extra-keys bar. Sticky: tap it, then the next letter typed is sent as a
 *  control character. */
const [ctrlArmed, setCtrlArmed] = createSignal(false);

export { isMobile, drawerOpen, setDrawerOpen, mobilePanelOpen, setMobilePanelOpen, ctrlArmed, setCtrlArmed };

/** The terminal the extra-keys bar types into: whichever one last had the keyboard. */
let target = null;

export function setKeyTarget(terminal) {
  target = terminal;
}

export function clearKeyTarget(terminal) {
  if (target === terminal) target = null;
}

export function sendKey(name) {
  target?.sendKey(name);
}

/** Size the page to the visual viewport. iOS Safari lays out behind the on-screen keyboard rather
 *  than above it, which would put the bottom of the terminal -- the prompt you are typing into --
 *  and the extra-keys bar out of sight. */
export function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    // Safari also scrolls the page to keep the focused field in view; the layout already does that.
    if (isMobile() && window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
