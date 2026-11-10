import { DockviewSolid } from '@arminmajerie/dockview-solid';
import '@arminmajerie/dockview-solid/styles/dockview.css';
import { For, Show, createEffect, on, onCleanup, untrack } from 'solid-js';

import * as api from '../api';
import { closeTab, editorRequests, newTab, state, takeFocusTab, workspaceTabs } from '../store';
import { EditorPane } from './EditorPane';
import { TerminalPane } from './TerminalPane';

// A dockview theme is just a class name holding its CSS variables. Ours maps them onto the
// workbench palette in styles/dockview.css, so the layout follows the colour scheme picker without
// swapping themes here.
const WORKBENCH_THEME = { name: 'workbench', className: 'wb-dockview', dndPanelOverlay: 'group' };

const layoutKey = (workspaceId) => `workbench.layout.${workspaceId}`;
const SAVE_DEBOUNCE_MS = 400;

// Editor panels are keyed by the workspace they show, which both keeps them out of the terminal
// reconcile below and means a workspace can only ever have the one.
const EDITOR_PREFIX = 'editor:';
// dockview detaches a hidden panel's DOM by default, and re-attaching an <iframe> anywhere else in
// the document reloads it — so every switch between the terminal tab and the editor tab silently
// restarted VS Code, losing the cursor, unsaved buffers and any terminal running inside it. The
// 'always' renderer keeps the panel in one stable overlay container instead, which is what this
// option exists for. Terminals don't need it: xterm re-measures itself when it comes back.
const EDITOR_RENDERER = 'always';
const editorPanelId = (workspaceId) => EDITOR_PREFIX + workspaceId;
const isEditorPanel = (panelId) => panelId.startsWith(EDITOR_PREFIX);

/** The terminal area: one layout per workspace open in the page, stacked on top of each other,
 *  with only the active one showing.
 *
 *  The others stay mounted, terminals attached, so switching back to one is instant rather than a
 *  reconnect and a replay of every terminal's output. They're hidden with `visibility` rather than
 *  `display` so they keep their size: a terminal measured at 0x0 would shrink its program to two
 *  columns, and claude would redraw for that. Rendered in the order they were opened, never moved:
 *  moving an editor's <iframe> in the document reloads it. */
export function TerminalLayout() {
  // Keys of a store object come back in insertion order, which is opening order.
  const open = () => Object.keys(state.workspaceTabs);
  return (
    <div id="terminal-layout">
      <For each={open()}>
        {(workspaceId) => (
          <div
            class="wb-workspace-layout"
            classList={{ 'wb-background': workspaceId !== state.activeWorkspaceId }}
          >
            <WorkspaceLayout workspaceId={workspaceId} />
          </div>
        )}
      </For>
      <Show when={!(state.activeWorkspaceId in state.workspaceTabs)}>
        <div class="wb-workspace-layout dv-watermark">
          <Show when={!state.activeWorkspaceId}>
            <p>
              {state.projects.length
                ? 'Pick a workspace on the left, or create one with + next to a project.'
                : 'Add a project with + in the sidebar, then create a workspace in it.'}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** One workspace's dockview layout, whose panels are its terminals (and its editor).
 *
 *  The store stays the source of truth for *which* terminals exist; dockview owns where they sit.
 *  An effect reconciles the two, and the arrangement is saved per workspace so a reload comes back
 *  to the same split. */
function WorkspaceLayout(props) {
  const workspaceId = props.workspaceId;
  const isActive = () => state.activeWorkspaceId === workspaceId;
  let dock;
  let saveTimer;
  // The layout as of its last change, waiting out the debounce to be written. Serialised when it
  // changes rather than when the timer fires, so it can still be written once dockview is gone.
  let pendingLayout = null;
  // Set while a workspace's saved layout is still waiting on its terminals to arrive. The
  // reconcile below sweeps panels the store doesn't know about, so restoring before the tabs land
  // would throw the layout straight back away.
  let awaitingTabs = true;
  // Set just before a new tab reaches the store, so the reconcile that follows can put its panel
  // in the group whose + was clicked rather than the default one.
  let pendingPlacement = null;
  // Panels we remove ourselves; their terminals are already gone, so closing must not kill twice.
  const removingSilently = new Set();

  function writeLayout() {
    clearTimeout(saveTimer);
    if (pendingLayout === null) return;
    try {
      localStorage.setItem(layoutKey(workspaceId), pendingLayout);
    } catch (_) {
      /* a layout is not worth failing over */
    }
    pendingLayout = null;
  }

  function saveLayout() {
    // Before its terminals arrive the dock is empty; saving then would write that over the layout
    // we are about to restore.
    if (!dock || awaitingTabs) return;
    try {
      pendingLayout = JSON.stringify(dock.toJSON());
    } catch (_) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeLayout, SAVE_DEBOUNCE_MS);
  }

  /** Put back the arrangement this workspace was left in, if it has one. */
  function restoreLayout() {
    try {
      const saved = localStorage.getItem(layoutKey(workspaceId));
      if (saved) dock.fromJSON(JSON.parse(saved));
    } catch (_) {
      // A layout that won't load isn't worth keeping.
      localStorage.removeItem(layoutKey(workspaceId));
    }
  }

  function removeSilently(panel) {
    removingSilently.add(panel.id);
    dock.removePanel(panel);
  }

  function addPanel(tab, position) {
    dock.addPanel({
      id: tab.id,
      component: 'terminal',
      title: tab.label,
      params: { tabId: tab.id },
      ...(position ? { position } : {}),
    });
  }

  /** Bring dockview's panels in line with the workspace's tabs. */
  function reconcile() {
    const tabs = workspaceTabs(workspaceId).map((t) => ({ id: t.id, label: t.label }));
    if (!dock) return;

    if (awaitingTabs) {
      // A workspace with no terminals yet is about to be given one. Lay nothing out until then.
      if (tabs.length === 0) return;
      awaitingTabs = false;
      restoreLayout();
    }

    // Panels for terminals that are gone — killed elsewhere, or not restored after a restart.
    // Editor panels answer to nothing in the store, so they are not swept up here.
    for (const panel of [...dock.panels]) {
      if (isEditorPanel(panel.id)) {
        // A layout saved before EDITOR_RENDERER existed brings its editor back on the default one.
        if (panel.api.renderer !== EDITOR_RENDERER) panel.api.setRenderer(EDITOR_RENDERER);
        continue;
      }
      if (!tabs.some((t) => t.id === panel.id)) removeSilently(panel);
    }
    for (const tab of tabs) {
      const existing = dock.getPanel(tab.id);
      if (existing) {
        if (existing.title !== tab.label) existing.api.setTitle(tab.label);
        continue;
      }
      const placement =
        pendingPlacement?.tabId === tab.id ? { referenceGroup: pendingPlacement.group } : undefined;
      if (placement) pendingPlacement = null;
      addPanel(tab, placement);
    }

    // A deep link (?tab=) or a reattached terminal asks to be brought to the front. Untracked:
    // taking it clears it, and this effect has no business re-running over that.
    const focusId = untrack(() => takeFocusTab(tabs));
    if (focusId) dock.getPanel(focusId)?.api.setActive();
  }

  /** Open a terminal, in `group` when one is given. */
  function addTerminal(group) {
    return newTab((created) => {
      if (group) pendingPlacement = { tabId: created.id, group };
    }, workspaceId);
  }

  /** Show this workspace's editor, bringing the existing panel forward if it's already open. */
  function addEditor() {
    if (!dock) return;
    const existing = dock.getPanel(editorPanelId(workspaceId));
    if (existing) {
      existing.api.setActive();
      return;
    }
    dock.addPanel({
      id: editorPanelId(workspaceId),
      component: 'editor',
      title: 'editor',
      renderer: EDITOR_RENDERER,
      params: { workspaceId },
    });
  }

  function onReady(event) {
    dock = event.api;
    event.api.onDidLayoutChange(saveLayout);
    event.api.onDidRemovePanel((panel) => {
      if (removingSilently.delete(panel.id)) return;
      // The workspace itself is leaving the page -- pushed out of the open ones, archived, deleted
      // -- and dockview is being torn down with it. Its terminals carry on without a page.
      if (!(workspaceId in state.workspaceTabs)) return;
      if (isEditorPanel(panel.id)) {
        // Closing the panel is as explicit as it gets, so the instance goes too rather than
        // holding its memory until the idle timeout notices. Reopening takes a few seconds and
        // comes back to the same files: the editor's state lives in its user-data-dir.
        api.stopEditor(panel.id.slice(EDITOR_PREFIX.length)).catch(() => {});
        return;
      }
      // Closing a panel closes the terminal behind it: the process is killed and the tab leaves
      // the store. A Claude session survives it — the conversation is pinned to a session id, so a
      // new tab in the same workspace can resume it.
      closeTab(panel.id, true).catch(() => {});
    });
    reconcile();
  }

  createEffect(reconcile);
  // defer: the count is non-zero only once something has actually asked.
  // Only the layout on screen answers: the top bar's request is for the workspace it shows.
  createEffect(on(editorRequests, () => isActive() && addEditor(), { defer: true }));

  onCleanup(() => {
    writeLayout();
    // DockviewSolid disposes the dockview in its own cleanup; doing it here too would tear down
    // the panel portals twice.
    dock = undefined;
  });

  function TerminalPanel(panelProps) {
    const tabId = panelProps.params.tabId;
    const tab = () => workspaceTabs(workspaceId).find((t) => t.id === tabId);
    return (
      <Show when={tab()}>
        <TerminalPane tab={tab()} panelApi={panelProps.api} />
      </Show>
    );
  }

  function EditorPanel(panelProps) {
    return <EditorPane workspaceId={panelProps.params.workspaceId} />;
  }

  function GroupActions(props) {
    return (
      <div class="dv-group-actions">
        <button type="button" title="New terminal in this group" onClick={() => addTerminal(props.group)}>
          +
        </button>
      </div>
    );
  }

  function Watermark() {
    return (
      <div class="dv-watermark">
        <p>
          Nothing open here.{' '}
          <button class="wb-btn" type="button" onClick={() => addTerminal()}>
            Open a terminal
          </button>{' '}
          <button class="wb-btn" type="button" onClick={addEditor}>
            Open the editor
          </button>
        </p>
      </div>
    );
  }

  return (
    <DockviewSolid
      theme={WORKBENCH_THEME}
      components={{ terminal: TerminalPanel, editor: EditorPanel }}
      rightHeaderActionsComponent={GroupActions}
      watermarkComponent={Watermark}
      onReady={onReady}
    />
  );
}
