import { For } from 'solid-js';

import { ctrlArmed, pasteClipboard, sendKey, setCtrlArmed } from '../mobile';

// The keys a phone keyboard doesn't have and a terminal (Claude Code especially) needs: Esc to
// interrupt, shift-tab to cycle modes, arrows for menus and history.
const KEYS = [
  { name: 'esc', label: 'esc' },
  { name: 'tab', label: 'tab' },
  { name: 'shift-tab', label: '⇧tab' },
  { name: 'ctrl', label: 'ctrl' },
  { name: 'ctrl-c', label: '^C' },
  { name: 'left', label: '←' },
  { name: 'up', label: '↑' },
  { name: 'down', label: '↓' },
  { name: 'right', label: '→' },
  { name: 'paste', label: PasteIcon },
];

/** A clipboard, drawn rather than an emoji or a symbol the terminal font may not have. */
function PasteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-label="paste">
      <rect x="3" y="3" width="10" height="11.5" rx="1.5" />
      <rect x="5.5" y="1.5" width="5" height="3" rx="1" fill="var(--btn-bg)" />
    </svg>
  );
}

/** Act on the touch (or mouse button) going down, with its default prevented, so the tap never
 *  takes focus from the terminal -- which would drop the on-screen keyboard on every key. Bound
 *  directly rather than through Solid's delegation: that listens on the document, where Chrome
 *  makes touch listeners passive and preventDefault does nothing. */
function press(el, name) {
  if (name === 'paste') return pressPaste(el);
  const handler = (e) => {
    e.preventDefault();
    if (name === 'ctrl') setCtrlArmed(!ctrlArmed());
    else sendKey(name);
  };
  el.addEventListener('touchstart', handler, { passive: false });
  el.addEventListener('mousedown', handler);
}

/** The paste key acts on the touch coming *up* instead. Reading the clipboard needs user
 *  activation, and a touchstart doesn't grant it -- only touchend (or a click) does. The touchstart
 *  still has its default prevented, so the tap keeps the keyboard up like the other keys. */
function pressPaste(el) {
  const keepFocus = (e) => e.preventDefault();
  el.addEventListener('touchstart', keepFocus, { passive: false });
  el.addEventListener('mousedown', keepFocus);
  el.addEventListener('touchend', (e) => {
    e.preventDefault(); // no synthesized click, so the paste doesn't happen twice
    pasteClipboard();
  });
  el.addEventListener('click', pasteClipboard);
}

/** A row of extra keys under the terminal on a phone. */
export function ExtraKeys() {
  return (
    <div id="extra-keys">
      <For each={KEYS}>
        {(key) => (
          <button
            type="button"
            class="extra-key"
            classList={{ armed: key.name === 'ctrl' && ctrlArmed() }}
            ref={(el) => press(el, key.name)}
          >
            {typeof key.label === 'function' ? <key.label /> : key.label}
          </button>
        )}
      </For>
    </div>
  );
}
