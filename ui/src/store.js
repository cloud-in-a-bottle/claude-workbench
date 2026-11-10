import { batch, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';

import * as api from './api';
import { DEFAULT_THEME, THEMES } from './themes';

const bootstrap = window.__WORKBENCH__ || {};

const LAST_WORKSPACE_KEY = 'workbench.workspace';
/** How many workspaces stay open in the page, the active one included. A workspace that's open
 *  keeps its terminals attached in the background, so switching back to it is instant instead of
 *  reconnecting every terminal and replaying its whole output. Past this many, the one used least
 *  recently is closed (its terminals keep running on the server; only the page lets go). */
const MAX_OPEN_WORKSPACES = 5;
const SIDEBAR_HIDDEN_KEY = 'workbench.sidebarHidden';

/** How often the sidebar re-reads git status. Unhurried on purpose: the server coalesces bursts,
 *  but this is still `git` on a one-core container shared with the Claude sessions. */
const STATUS_POLL_MS = 10000;

/** Agent state costs a few small file reads rather than a `git` process, and "is it working right
 *  now" is only worth showing if it keeps up, so it gets its own faster poll. */
const AGENT_POLL_MS = 3000;

const [state, setState] = createStore({
  projects: [],
  /** Terminals of each workspace open in the page, keyed by workspace id. A workspace is in here
   *  only once its terminals have been listed. Which of them is visible, and how they're arranged,
   *  is dockview's business, not the store's. */
  workspaceTabs: {},
  /** Workspaces open in the page, most recently used first, at most MAX_OPEN_WORKSPACES. Each has
   *  its own layout mounted; all but the active one are hidden. */
  openWorkspaces: [],
  activeWorkspaceId: '',
  /** A terminal the layout should bring to the front once its panel exists. Cleared when used. */
  focusTabId: '',
  /** Git status of every workspace, keyed by workspace id — what the sidebar's dots read. Filled
   *  by a poll, so a workspace is missing from it until the first one lands. */
  status: {},
  /** What Claude is doing, keyed by workspace id. Only workspaces with a live session appear. */
  agents: {},
  /** Workbench settings — the billing default and what each mode has credentials for. Null until
   *  the first load lands, which is the settings page's "checking…" state. */
  settings: null,
  ready: false,
});

const [theme, setThemeSignal] = createSignal(THEMES[bootstrap.theme] ? bootstrap.theme : DEFAULT_THEME);
/** Bumped when something asks for an editor panel. The layout owns dockview, so it does the
 *  opening; this is how the top bar reaches it without a reference to the dock. */
const [editorRequests, setEditorRequests] = createSignal(0);
const [sidebarHidden, setSidebarHiddenSignal] = createSignal(localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1');

/** Guards against a slow workspace load landing after the user has moved on to another one. */
let switchToken = 0;

export { state, theme, sidebarHidden, editorRequests };

export function requestEditor() {
  setEditorRequests((n) => n + 1);
}

export function toggleSidebar() {
  const hidden = !sidebarHidden();
  setSidebarHiddenSignal(hidden);
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
}

export function applyTheme(name) {
  if (!THEMES[name]) return;
  setThemeSignal(name);
  document.documentElement.setAttribute('data-theme', name);
  api.saveUiSettings({ theme: name }).catch(() => {
    // Already applied locally; it just won't outlive this page.
    console.warn('could not save the colour scheme');
  });
}

export function activeWorkspace() {
  for (const project of state.projects) {
    const found = project.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (found) return { project, workspace: found };
  }
  return null;
}

/** The terminals of a workspace open in the page; empty for one that isn't (yet). */
export function workspaceTabs(workspaceId) {
  return state.workspaceTabs[workspaceId] || [];
}

export function activeTabs() {
  return workspaceTabs(state.activeWorkspaceId);
}

/** The terminal waiting to be brought to the front, if it is one of `tabs`. Cleared when taken. */
export function takeFocusTab(tabs) {
  const id = state.focusTabId;
  if (!id || !tabs.some((t) => t.id === id)) return '';
  setState('focusTabId', '');
  return id;
}

/** Put a workspace's terminals in the page and make it the most recent, closing whichever open
 *  workspace falls off the end. Keyed by id, so terminals already on the page keep their panes. */
function showWorkspaceTabs(workspaceId, tabs) {
  const open = [workspaceId, ...state.openWorkspaces.filter((id) => id !== workspaceId)];
  const evicted = open.slice(MAX_OPEN_WORKSPACES);
  batch(() => {
    setState('openWorkspaces', open.slice(0, MAX_OPEN_WORKSPACES));
    setState('workspaceTabs', workspaceId, reconcile(tabs, { key: 'id' }));
    for (const id of evicted) setState('workspaceTabs', produce((all) => delete all[id]));
  });
}

/** Take a workspace out of the page altogether: it was archived, deleted, or pushed out. */
function dropWorkspace(workspaceId) {
  batch(() => {
    setState('openWorkspaces', (open) => open.filter((id) => id !== workspaceId));
    setState('workspaceTabs', produce((all) => delete all[workspaceId]));
  });
}

/** Apply `change` to the tab list of whichever open workspace has terminal `tabId`. */
function updateTabsHolding(tabId, change) {
  for (const [workspaceId, tabs] of Object.entries(state.workspaceTabs)) {
    if (tabs.some((t) => t.id === tabId)) setState('workspaceTabs', workspaceId, change);
  }
}

export async function refreshProjects() {
  setState('projects', await api.listProjects());
}

/** Re-read the settings, including a fresh `claude auth status` probe in the container. */
export async function refreshSettings() {
  setState('settings', await api.getSettings());
}

/** Change the billing mode new workspaces get. Existing workspaces keep what they were made with,
 *  so this never moves work in progress onto another account. */
export async function saveDefaultBilling(mode) {
  setState('settings', await api.saveSettings({ default_billing: mode }));
}

/** Change how many days an archived workspace is kept before it is deleted; 0 keeps it forever. */
export async function saveArchiveRetention(days) {
  setState('settings', await api.saveSettings({ archive_retention_days: days }));
}

export async function refreshStatus() {
  const statuses = await api.listWorkspaceStatus();
  setState('status', Object.fromEntries(statuses.map((s) => [s.workspace_id, s])));
}

export function workspaceStatus(workspaceId) {
  return state.status[workspaceId];
}

export async function refreshAgents() {
  const agents = await api.listWorkspaceAgents();
  setState('agents', Object.fromEntries(agents.map((a) => [a.workspace_id, a])));
}

export function workspaceAgent(workspaceId) {
  return state.agents[workspaceId];
}

/** Ask for fresh statuses without waiting on them: a failed refresh only means the dots stay as
 *  they are until the next poll, which is not worth interrupting anyone over. Worth saying once,
 *  though -- a rail full of grey dots is otherwise a mystery with nothing in the console. */
let statusFailureReported = false;
function refreshStatusSoon() {
  refreshStatus().catch((err) => {
    if (statusFailureReported) return;
    statusFailureReported = true;
    console.warn('could not read workspace status; the sidebar dots may be stale', err);
  });
}

/** Keep the status dots current, and only while the page is actually being looked at. A failed
 *  poll leaves the last statuses on screen rather than blanking them; the next tick tries again. */
function watchStatus() {
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    refreshStatusSoon();
    refreshAgents().catch(() => {});
  };
  const agentTick = () => {
    if (document.visibilityState === 'visible') refreshAgents().catch(() => {});
  };
  setInterval(tick, STATUS_POLL_MS);
  setInterval(agentTick, AGENT_POLL_MS);
  // A tab left in the background misses ticks, so catch up the moment it comes back.
  document.addEventListener('visibilitychange', tick);
  tick();
}

function rememberWorkspace(workspaceId) {
  localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
  const url = new URL(location.href);
  url.searchParams.set('workspace', workspaceId);
  url.searchParams.delete('tab');
  history.replaceState({}, '', url);
}

/** Show a workspace: swap in its terminals, opening one if it has none yet. */
export async function openWorkspace(workspaceId) {
  if (workspaceId === state.activeWorkspaceId) return;
  const token = ++switchToken;
  const alreadyOpen = workspaceId in state.workspaceTabs;

  batch(() => {
    setState('activeWorkspaceId', workspaceId);
    // Still open in the background: show it as it is right away, and catch up with the server
    // below (a terminal opened or closed from another browser meanwhile).
    if (alreadyOpen) showWorkspaceTabs(workspaceId, state.workspaceTabs[workspaceId]);
  });
  rememberWorkspace(workspaceId);

  let tabs;
  try {
    tabs = await api.listTabs(workspaceId);
  } catch (err) {
    if (alreadyOpen) return; // what's on screen is still the best we know
    throw err;
  }
  if (token !== switchToken) return;
  if (tabs.length === 0) {
    tabs = [await api.createTab(workspaceId)];
    if (token !== switchToken) return;
  }
  showWorkspaceTabs(workspaceId, tabs);
}

/** Open a terminal in the active workspace. `beforeCommit` runs with the new tab before it reaches
 *  the store, which is the layout's chance to say where its panel should go. */
export async function newTab(beforeCommit, workspaceId = state.activeWorkspaceId) {
  if (!workspaceId) return null;
  const tab = await api.createTab(workspaceId);
  if (!(workspaceId in state.workspaceTabs)) return tab; // closed in the page meanwhile
  beforeCommit?.(tab);
  setState('workspaceTabs', workspaceId, (tabs) => [...tabs, tab]);
  return tab;
}

/** Drop a terminal from the page. `destroy` also kills the process behind it. */
export async function closeTab(tabId, destroy) {
  forgetTab(tabId);
  if (destroy) await api.deleteTab(tabId);
}

/** Put a still-running terminal the browser had let go of back on the page. */
export function adoptTab(tab) {
  const workspaceId = tab.workspace_id;
  if (!(workspaceId in state.workspaceTabs)) return;
  batch(() => {
    setState('workspaceTabs', workspaceId, (tabs) => [...tabs, tab]);
    setState('focusTabId', tab.id);
  });
}

/** Remove a terminal the server no longer has (its process died, or it was killed elsewhere). */
export function forgetTab(tabId) {
  updateTabsHolding(tabId, (tabs) => tabs.filter((t) => t.id !== tabId));
}

export async function createProject(repoUrl, name, setup, defaultBranch) {
  const project = await api.createProject(repoUrl, name, setup, defaultBranch);
  await refreshProjects();
  return project;
}

export async function updateProject(projectId, patch) {
  await api.updateProject(projectId, patch);
  await refreshProjects();
}

export async function deleteProject(projectId) {
  await api.deleteProject(projectId);
  await refreshProjects();
}

/** `items` with the one whose key is `moved` taken out and put back just before or after `target`. */
function reordered(items, key, moved, target, after) {
  const item = items.find((x) => key(x) === moved);
  const rest = items.filter((x) => key(x) !== moved);
  const at = rest.findIndex((x) => key(x) === target);
  if (!item || at < 0) return null;
  rest.splice(after ? at + 1 : at, 0, item);
  return rest;
}

/** Shown in the new order straight away, then saved; a refused save re-reads the real order, so
 *  the rail never keeps showing an order the server doesn't have. */
async function saveOrder(show, save) {
  show();
  try {
    await save();
  } catch (err) {
    await refreshProjects();
    throw err;
  }
}

/** Move a project to just before or after another one in the sidebar. */
export async function moveProject(projectId, targetId, after) {
  const next = reordered(state.projects, (p) => p.id, projectId, targetId, after);
  if (!next) return;
  await saveOrder(() => setState('projects', next), () => api.reorderProjects(next.map((p) => p.id)));
}

/** Move a workspace to just before or after another of the same project. The order saved covers
 *  live and archived workspaces together, but a move only ever lands next to one from its own
 *  section, so each section keeps its own relative order. */
export async function moveWorkspace(projectId, workspaceId, targetId, after) {
  const index = state.projects.findIndex((p) => p.id === projectId);
  if (index < 0) return;
  const workspaces = reordered(state.projects[index].workspaces, (w) => w.id, workspaceId, targetId, after);
  if (!workspaces) return;
  await saveOrder(
    () => setState('projects', index, 'workspaces', workspaces),
    () => api.reorderWorkspaces(projectId, workspaces.map((w) => w.name)),
  );
}

export async function createWorkspace(projectId, name, ref, billing) {
  const workspace = await api.createWorkspace(projectId, name, ref, billing);
  await refreshProjects();
  refreshStatusSoon();
  // Creating it already opened its first terminal; adopt that rather than asking for another.
  ++switchToken;
  batch(() => {
    setState('activeWorkspaceId', workspace.id);
    showWorkspaceTabs(workspace.id, [workspace.tab]);
  });
  rememberWorkspace(workspace.id);
  return workspace;
}

/** Stop showing a workspace, because it is going away or being put away. It may be open in the
 *  background without being the one on screen, so it is closed in the page either way. */
function closeWorkspace(workspaceId) {
  batch(() => {
    dropWorkspace(workspaceId);
    if (workspaceId !== state.activeWorkspaceId) return;
    ++switchToken;
    setState('activeWorkspaceId', '');
    localStorage.removeItem(LAST_WORKSPACE_KEY);
  });
}

export async function deleteWorkspace(workspaceId) {
  await api.deleteWorkspace(workspaceId);
  closeWorkspace(workspaceId);
  localStorage.removeItem(`workbench.layout.${workspaceId}`);
  await refreshProjects();
  refreshStatusSoon();
}

/** Close everything a workspace is running and move it to the project's archived section. The
 *  dock layout is deliberately kept: unarchiving reopens the same terminals, and they should come
 *  back arranged the way they were left. */
export async function archiveWorkspace(workspaceId) {
  await api.archiveWorkspace(workspaceId);
  closeWorkspace(workspaceId);
  await refreshProjects();
}

/** Bring an archived workspace back and open it. The terminals the server reopened come straight
 *  from the response, so this doesn't race a `listTabs` against processes that are still starting. */
export async function unarchiveWorkspace(workspaceId) {
  const workspace = await api.unarchiveWorkspace(workspaceId);
  await refreshProjects();
  refreshStatusSoon();
  ++switchToken;
  batch(() => {
    setState('activeWorkspaceId', workspaceId);
    showWorkspaceTabs(workspaceId, workspace.tabs);
  });
  rememberWorkspace(workspaceId);
  // An archived workspace with nothing saved in it (archived while it had no terminals) comes back
  // with none, so give it the Claude tab that opening any empty workspace gets.
  if (workspace.tabs.length === 0) {
    const tab = await api.createTab(workspaceId);
    if (workspaceId in state.workspaceTabs) setState('workspaceTabs', workspaceId, [tab]);
  }
}

export async function init() {
  await refreshProjects();
  // Before the restore below, not after it. Nothing about the sidebar's dots depends on which
  // workspace is being reopened, while the restore spawns terminals and is the likeliest step
  // here to fail or to take its time -- and when it did, the poll never started at all and every
  // dot in the rail stayed grey until someone reloaded the page.
  watchStatus();
  const params = new URLSearchParams(location.search);
  // Archived ones are excluded: reopening one on a page load would start the very processes
  // archiving it closed, without anyone asking for that.
  const known = new Set(
    state.projects.flatMap((p) => p.workspaces.filter((w) => !w.archived).map((w) => w.id)),
  );
  const wanted = [params.get('workspace'), localStorage.getItem(LAST_WORKSPACE_KEY)].find(
    (id) => id && known.has(id),
  );
  const wantedTab = params.get('tab');
  if (wanted) {
    await openWorkspace(wanted);
    if (wantedTab && activeTabs().some((t) => t.id === wantedTab)) setState('focusTabId', wantedTab);
  }
  setState('ready', true);
  // Not awaited: it shells out to `claude auth status`, and nothing on screen at this point is
  // waiting on the answer. The dialogs that need it re-read it when they open.
  refreshSettings().catch(() => console.warn('could not load the workbench settings'));
}
