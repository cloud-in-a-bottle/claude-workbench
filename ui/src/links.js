import { WebLinksAddon } from '@xterm/addon-web-links';

/** Cmd on macOS, Ctrl everywhere else -- on a Mac ctrl-click is a right-click, so it can't be the
 *  one that follows links. */
const IS_MAC = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const MODIFIER_LABEL = IS_MAC ? '⌘' : 'Ctrl';

const modifierHeld = (event) => (IS_MAC ? event.metaKey : event.ctrlKey);

/** Only ever follow http(s). The text of a link is chosen by whatever program is running in the
 *  terminal, so `javascript:` would otherwise hand it a way to run script in the workbench page. */
const followable = (uri) => /^https?:\/\//i.test(uri);

/** Link support for one terminal: URLs printed as plain text and OSC 8 hyperlinks both open in a new
 *  browser tab on modifier-click, the way iTerm2 and VS Code do it. A plain click is left alone,
 *  because in a terminal you click to place the cursor and drag to select.
 *
 *  Nothing about the modifier is discoverable on its own, so `showHint` is called with a line to
 *  display while a link is under the pointer: it names the key and shows where the link actually
 *  goes, which for an OSC 8 hyperlink is not what the text says.
 *
 *  `host` only takes a class while the modifier is down, for the cursor styling in layout.css. */
export function createLinkSupport(host, showHint) {
  /** The followable link under the pointer, as xterm last reported it. */
  let current = null;
  /** Set while `linkAt` is asking xterm, so its question doesn't flash a hint. */
  let probing = false;

  function hover(event, uri) {
    if (!followable(uri)) return;
    current = uri;
    if (!probing) showHint(`${MODIFIER_LABEL}-click to open ${uri}`);
  }

  function leave() {
    current = null;
    showHint('');
  }

  /** The link at a point on the screen, if there is one -- for a tap, which has no hover and no
   *  modifier. xterm only finds links under a mouse, so this shows it one: a mousemove there, read
   *  back through `hover`, then a mouseleave so the next question starts clean. Both of xterm's
   *  link sources (OSC 8 and the web-links addon) answer synchronously. */
  function linkAt(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target || !host.contains(target)) return null;
    probing = true;
    try {
      current = null;
      target.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }));
      return current;
    } finally {
      // mouseleave doesn't bubble, and the linkifier listens on one of these two.
      for (const el of host.querySelectorAll('.xterm, .xterm-screen')) {
        el.dispatchEvent(new MouseEvent('mouseleave', { clientX, clientY }));
      }
      probing = false;
    }
  }

  /** Open a link the user picked. Same rule as a click: only http(s). */
  function open(uri) {
    if (followable(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
  }

  function activate(event, uri) {
    if (modifierHeld(event)) open(uri);
  }

  const trackModifier = (e) => host.classList.toggle('link-modifier', modifierHeld(e));
  // Cmd-tabbing away never delivers the keyup, which would otherwise leave the class stuck on.
  const clearModifier = () => host.classList.remove('link-modifier');
  window.addEventListener('keydown', trackModifier);
  window.addEventListener('keyup', trackModifier);
  window.addEventListener('blur', clearModifier);

  return {
    // OSC 8 hyperlinks. xterm matches these itself, since the program marked them up explicitly.
    linkHandler: { activate, hover, leave },
    // Bare URLs, which the addon finds by scanning the buffer -- including ones wrapped over lines.
    addon: new WebLinksAddon(activate, { hover, leave }),
    linkAt,
    open,
    dispose() {
      window.removeEventListener('keydown', trackModifier);
      window.removeEventListener('keyup', trackModifier);
      window.removeEventListener('blur', clearModifier);
      showHint('');
    },
  };
}
