import { For } from 'solid-js';

import { ctrlArmed, sendKey, setCtrlArmed } from '../mobile';

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
];

/** Act on the touch (or mouse button) going down, with its default prevented, so the tap never
 *  takes focus from the terminal -- which would drop the on-screen keyboard on every key. Bound
 *  directly rather than through Solid's delegation: that listens on the document, where Chrome
 *  makes touch listeners passive and preventDefault does nothing. */
function press(el, name) {
  const handler = (e) => {
    e.preventDefault();
    if (name === 'ctrl') setCtrlArmed(!ctrlArmed());
    else sendKey(name);
  };
  el.addEventListener('touchstart', handler, { passive: false });
  el.addEventListener('mousedown', handler);
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
            {key.label}
          </button>
        )}
      </For>
    </div>
  );
}
