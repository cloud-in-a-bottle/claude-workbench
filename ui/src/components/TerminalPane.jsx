import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';

import * as api from '../api';
import { createLinkSupport } from '../links';
import { clearKeyTarget, ctrlArmed, isMobile, setCtrlArmed, setKeyTarget } from '../mobile';
import { filterOsc52Noise, handleOsc52 } from '../osc52';
import { forgetTab, state, theme } from '../store';
import { xtermTheme } from '../themes';
import { attachTouchScroll } from '../touchScroll';

const RECONNECT_POLL_MS = 2000;
// A connection on a flaky network (plane wifi, a phone between towers) usually dies without
// closing: packets just stop, the browser keeps reporting it open, keystrokes queue up behind it
// and nothing ever reconnects. So the pane pings, and treats silence as a dead connection. The
// server times out its end on the same silence (_CLIENT_SILENCE_TIMEOUT in tabs.py), a bit later.
const HEARTBEAT_MS = 10000;
const DEAD_AFTER_MS = 25000;
// After the network comes back or the page is shown again, how long a ping gets to be answered.
const PROBE_MS = 4000;
// A handshake still hanging after this long isn't going to finish.
const CONNECT_TIMEOUT_MS = 10000;
// How long the reconnect waits to hear whether its tab still exists.
const LIST_TIMEOUT_MS = 5000;
// xterm keeps 1000 lines by default, which a long claude session scrolls past in minutes — the
// scrollbar then stops well short of where the conversation actually started. Costs roughly
// cols * 12 bytes per line held, so this is a few MB per terminal once one is really full.
const SCROLLBACK_LINES = 10000;

// iTerm2's text settings, as far as a browser can follow them: Monaco at 17, natural spacing.
// Monaco is the one that matters -- it's on every Mac -- and the rest are for everyone else.
// No lineHeight: xterm sizes a cell from the font's own ascent plus descent, not from the font
// size, so its default of 1 is already iTerm2's vertical spacing of 100%.
const TERMINAL_FONT = {
  fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace',
  fontSize: 17,
};
// Small enough that a phone held upright still gets ~45 columns.
const MOBILE_FONT_SIZE = 12;

/** What each key on the phone's extra-keys bar sends. Arrows depend on the cursor-key mode the
 *  program has asked for, which is why they're a function of the terminal. */
const EXTRA_KEYS = {
  esc: () => '\x1b',
  tab: () => '\t',
  'shift-tab': () => '\x1b[Z',
  'ctrl-c': () => '\x03',
  up: (app) => (app ? '\x1bOA' : '\x1b[A'),
  down: (app) => (app ? '\x1bOB' : '\x1b[B'),
  right: (app) => (app ? '\x1bOC' : '\x1b[C'),
  left: (app) => (app ? '\x1bOD' : '\x1b[D'),
};

/** A typed character as Ctrl would send it: ^A..^Z and the handful of punctuation keys that have
 *  one. Anything else goes through unchanged. */
function withCtrl(data) {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : data;
}

function wsUrl(tabId, clientId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = `tab=${encodeURIComponent(tabId)}&client=${encodeURIComponent(clientId)}`;
  return `${proto}://${location.host}/terminal/ws?${query}`;
}

function newClientId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A control message (resize, ping) as the server reads it: 0x01 then JSON. */
function controlFrame(msg) {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const buf = new Uint8Array(1 + json.length);
  buf[0] = 0x01;
  buf.set(json, 1);
  return buf.buffer;
}

/** The image in a paste, if it carries one. A screenshot off the system clipboard arrives as an
 *  item; an image file copied out of a file manager arrives in `files` instead. */
function clipboardImage(clipboardData) {
  if (!clipboardData) return null;
  for (const file of clipboardData.files || []) {
    if (file.type.startsWith('image/')) return file;
  }
  for (const item of clipboardData.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** One terminal: an xterm instance bound to a server-side PTY over a websocket.
 *
 *  Deliberately imperative — xterm owns its own DOM and the websocket has a lifecycle of its own.
 *  Solid's job is to mount it, keep it in step with the colour scheme, and tear it down when the
 *  panel (or the whole workspace) goes away. Resizing is driven by dockview, which tells the panel
 *  its dimensions changed however that came about: a split, a drag, or the window itself. */
export function TerminalPane(props) {
  let host;
  let term;
  let fit;
  let socket = null;
  let reconnecting = false;
  let disposed = false;
  let lastDimensions = { cols: 80, rows: 24 };
  // Who this pane is to the server, so a reconnect after a silent drop can take the tab back from
  // its own dead connection rather than being told the tab is open somewhere else.
  const clientId = newClientId();
  let everConnected = false;
  let lastHeard = 0;
  let connectTimer = null;
  let probeTimer = null;
  let pollTimer = null;
  const openSockets = new WeakSet();
  const [busy, setBusy] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [linkHint, setLinkHint] = createSignal('');
  let noticeTimer = null;

  function sendResize() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const proposed = fit.proposeDimensions();
    if (proposed) lastDimensions = proposed;
    const { cols, rows } = proposed || lastDimensions;
    socket.send(controlFrame({ type: 'resize', cols, rows }));
  }

  function refit() {
    // A hidden panel has no size to measure; it keeps the dimensions it last had.
    if (disposed || !props.panelApi.isVisible) return;
    fit.fit();
    sendResize();
  }

  /** After a dropped connection, work out whether the terminal is still there before reattaching. */
  function pollReconnect() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (disposed || !reconnecting) return;
      let tabs;
      try {
        tabs = await api.listTabs(state.activeWorkspaceId, { timeoutMs: LIST_TIMEOUT_MS });
      } catch (_) {
        // The server may not be back yet -- or this request went down a pooled connection that
        // died along with the websocket, and would hang there. Either way, try the socket itself:
        // it gets a fresh connection, and if the tab really is gone it fails and lands back here.
      }
      if (disposed || !reconnecting) return;
      if (tabs && !tabs.some((t) => t.id === props.tab.id)) forgetTab(props.tab.id);
      else connect();
    }, RECONNECT_POLL_MS);
  }

  /** The connection is gone, whether it said so or we gave up on it: start getting it back. */
  function lost(ws) {
    if (socket !== ws || disposed) return;
    const wasOpen = openSockets.has(ws);
    socket = null;
    clearTimeout(connectTimer);
    clearTimeout(probeTimer);
    probeTimer = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    // A dead connection's close handshake can take minutes to give up, and its onclose with it.
    try {
      ws.close();
    } catch (_) {}
    if (busy() || reconnecting) return;
    reconnecting = true;
    // Once per outage, not once per failed attempt at ending it.
    if (wasOpen) term.write('\r\n\x1b[90m[reconnecting...]\x1b[0m\r\n');
    pollReconnect();
  }

  function ping() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(controlFrame({ type: 'ping' }));
    } catch (_) {}
  }

  /** Every few seconds: give up on a connection that has gone quiet, otherwise prod it. */
  function heartbeat() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastHeard > DEAD_AFTER_MS) lost(socket);
    else ping();
  }

  /** Something suggests the connection may have died -- the network changed, or the page was
   *  asleep -- so check now rather than waiting out the heartbeat. */
  function probe() {
    if (disposed) return;
    if (reconnecting) {
      connect(); // skip the rest of the poll wait; connect() checks the tab still exists on failure
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const ws = socket;
    const asked = Date.now();
    ping();
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (socket === ws && lastHeard < asked) lost(ws);
    }, PROBE_MS);
  }

  function connect() {
    if (disposed) return;
    clearTimeout(pollTimer);
    reconnecting = false;
    setBusy('');
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const ws = new WebSocket(wsUrl(props.tab.id, clientId));
    ws.binaryType = 'arraybuffer';
    socket = ws;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (socket === ws && ws.readyState === WebSocket.CONNECTING) lost(ws);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      openSockets.add(ws);
      clearTimeout(connectTimer);
      lastHeard = Date.now();
      // The server replays the tab's whole output buffer on every attach. Written on top of what
      // the terminal already shows, a reconnect would repeat the session in the scrollback.
      if (everConnected) term.reset();
      everConnected = true;
      // Always send: a hidden panel reuses the dimensions it last knew about.
      if (props.panelApi.isVisible) fit.fit();
      sendResize();
    };
    ws.onmessage = (ev) => {
      lastHeard = Date.now();
      if (!(ev.data instanceof ArrayBuffer)) {
        term.write(ev.data);
        return;
      }
      const bytes = new Uint8Array(ev.data);
      if (bytes[0] === 0x00) {
        const chunk = bytes.subarray(1);
        handleOsc52(chunk);
        term.write(filterOsc52Noise(chunk));
        return;
      }
      if (bytes[0] !== 0x01) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
        if (msg.type === 'busy') setBusy('This terminal is currently open in another browser tab.');
        else if (msg.type === 'kicked') setBusy('Another browser tab has taken over this terminal.');
        else if (msg.type === 'exit') term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
      } catch (_) {}
    };
    ws.onclose = () => lost(ws);
  }

  function send(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const enc = new TextEncoder().encode(data);
    const buf = new Uint8Array(1 + enc.length);
    buf[0] = 0x00;
    buf.set(enc, 1);
    socket.send(buf.buffer);
    // Typing into a dead connection is when anyone notices one, so check on it then too, rather
    // than leaving the keystrokes to vanish until the heartbeat gives up on it.
    if (!probeTimer) probe();
  }

  /** How the phone's extra-keys bar reaches this terminal while it has the keyboard. */
  const keyTarget = {
    sendKey: (name) => send(EXTRA_KEYS[name](term.modes.applicationCursorKeysMode)),
  };

  function copySelection() {
    const selection = term.getSelection();
    if (!selection) return false;
    navigator.clipboard.writeText(selection).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = selection;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      document.body.removeChild(ta);
    });
    return true;
  }

  function flashNotice(text, clearAfterMs) {
    clearTimeout(noticeTimer);
    setNotice(text);
    if (clearAfterMs) noticeTimer = setTimeout(() => setNotice(''), clearAfterMs);
  }

  /** Get a pasted image to the program in the terminal, which cannot reach the clipboard itself.
   *
   *  The clipboard the image is on belongs to the machine running the browser; the terminal is a
   *  PTY in a container that has no clipboard at all, which is why Claude Code's own paste says
   *  there's no image in it. So the bytes go up to the workbench, which writes them to a file, and
   *  the file's path is pasted in as text -- Claude Code turns a pasted image path back into an
   *  attachment. */
  async function pasteImage(blob) {
    flashNotice('Uploading image\u2026');
    try {
      const { path } = await api.uploadPastedImage(blob);
      if (disposed) return; // the panel was closed while the upload was in flight
      flashNotice('');
      term.paste(path);
      term.focus();
    } catch (err) {
      flashNotice(err.message, 6000);
    }
  }

  function onPaste(e) {
    const image = clipboardImage(e.clipboardData);
    if (!image) return; // an ordinary text paste; xterm's own handler has it
    e.preventDefault();
    e.stopPropagation();
    pasteImage(image);
  }

  onMount(() => {
    const links = createLinkSupport(host, setLinkHint);
    onCleanup(links.dispose);
    term = new Terminal({
      ...TERMINAL_FONT,
      fontSize: isMobile() ? MOBILE_FONT_SIZE : TERMINAL_FONT.fontSize,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: SCROLLBACK_LINES,
      theme: xtermTheme(theme()),
      linkHandler: links.linkHandler,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(links.addon);
    term.open(host);
    // A tap on a link opens it; anywhere else, it brings up the keyboard.
    const onTap = (x, y) => {
      const uri = links.linkAt(x, y);
      if (uri) links.open(uri);
      else term.focus();
    };
    onCleanup(attachTouchScroll(host, term, send, onTap));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && e.key === 'c' && copySelection()) return false;
      return true;
    });
    term.onData((data) => {
      if (ctrlArmed()) {
        setCtrlArmed(false);
        data = withCtrl(data);
      }
      send(data);
    });
    connect();
    const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    const onVisible = () => document.visibilityState === 'visible' && probe();
    window.addEventListener('online', probe);
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => {
      clearInterval(heartbeatTimer);
      window.removeEventListener('online', probe);
      document.removeEventListener('visibilitychange', onVisible);
    });

    host.addEventListener('paste', onPaste, true);
    onCleanup(() => host.removeEventListener('paste', onPaste, true));
    const claimKeys = () => setKeyTarget(keyTarget);
    term.textarea.addEventListener('focus', claimKeys);
    onCleanup(() => {
      term.textarea?.removeEventListener('focus', claimKeys);
      clearKeyTarget(keyTarget);
    });

    const sizeSub = props.panelApi.onDidDimensionsChange(() => refit());
    // Dockview detaches a hidden panel's DOM, so a panel coming back has to measure itself again.
    const visSub = props.panelApi.onDidVisibilityChange((e) => e.isVisible && queueMicrotask(refit));
    // Not on a phone, where focus raises the on-screen keyboard over half the terminal: there it
    // takes a tap on the terminal (see touchScroll.js).
    const autoFocus = () => !isMobile() && term.focus();
    const focusSub = props.panelApi.onDidActiveChange((e) => e.isActive && autoFocus());
    // Dockview activates a panel as it adds it, which is before this pane exists to hear about it.
    // So a terminal that arrives already active -- a new workspace, a new tab, the panel a restored
    // layout comes back on -- gets the keyboard here instead, and typing works without a click.
    if (props.panelApi.isActive) autoFocus();
    onCleanup(() => {
      sizeSub.dispose();
      visSub.dispose();
      focusSub.dispose();
    });
  });

  createEffect(() => {
    if (term) term.options.theme = xtermTheme(theme());
  });

  createEffect(() => {
    const size = isMobile() ? MOBILE_FONT_SIZE : TERMINAL_FONT.fontSize;
    if (!term || term.options.fontSize === size) return;
    term.options.fontSize = size;
    refit();
  });

  onCleanup(() => {
    disposed = true;
    reconnecting = false;
    clearTimeout(noticeTimer);
    clearTimeout(connectTimer);
    clearTimeout(probeTimer);
    clearTimeout(pollTimer);
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch (_) {}
      socket = null;
    }
    try {
      term.dispose();
    } catch (_) {}
  });

  return (
    <div class="terminal-panel">
      <div class="term" ref={host} />
      <Show when={notice() || linkHint()}>
        <div class="term-notice">{notice() || linkHint()}</div>
      </Show>
      <Show when={busy()}>
        <div class="busy-overlay">
          <div>{busy()}</div>
          <div class="busy-actions">
            <button class="busy-btn" type="button" onClick={() => forgetTab(props.tab.id)}>
              Close this panel
            </button>
            <button
              class="busy-btn"
              type="button"
              onClick={async () => {
                try {
                  await api.kickTab(props.tab.id);
                } catch (err) {
                  // Clearing the overlay first and connecting only on success left a blank panel
                  // whenever the kick failed: no overlay, no connection, and nothing saying why.
                  setBusy(`Couldn't disconnect the other browser: ${err.message}`);
                  return;
                }
                connect();
              }}
            >
              Disconnect the other browser
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
