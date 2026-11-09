import { For, Show, createSignal } from 'solid-js';

import { isMobile, setDrawerOpen } from '../mobile';
import {
  archiveWorkspace,
  deleteProject,
  deleteWorkspace,
  moveProject,
  moveWorkspace,
  openWorkspace,
  state,
  toggleSidebar,
  unarchiveWorkspace,
} from '../store';
import { ConfirmDialog } from './ConfirmDialog';
import { Menu } from './Menu';
import { ProjectDialog } from './ProjectDialog';
import { SettingsDialog } from './SettingsDialog';
import { WorkspaceDialog } from './WorkspaceDialog';
import { WorkspaceAgentDot, WorkspaceStatusDot, WorkspaceSync } from './WorkspaceStatus';

const COLLAPSED_KEY = 'workbench.collapsedProjects';

/** The collapse key for a project's archived section. A project id can't contain `/`, so this can
 *  never collide with a project's own key. */
const archivedKey = (projectId) => `${projectId}/archived`;

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch (_) {
    return new Set();
  }
}

/** The projects → workspaces rail. A project is a git repo, or a folder project with none; a
 *  workspace is one copy of it. */
export function Sidebar() {
  const [dialog, setDialog] = createSignal(null);
  const [menu, setMenu] = createSignal(null);
  const [collapsed, setCollapsed] = createSignal(loadCollapsed());
  /** Whatever the last archive/unarchive said, when it failed. Those close and reopen real
   *  processes, so a silent failure would leave the rail disagreeing with the container. */
  const [failure, setFailure] = createSignal('');

  function toggleSection(key) {
    const next = new Set(collapsed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  }

  /** What is being dragged — `{ kind: 'project', id }` or `{ kind: 'workspace', id, projectId,
   *  archived }` — and where it would land: `{ id, after }`, beside the row with that id. */
  const [dragging, setDragging] = createSignal(null);
  const [dropAt, setDropAt] = createSignal(null);

  /** Drag-and-drop handlers for one row. `item` is what the row would drag, and a drop is only
   *  accepted from a drag that `accepts` — a project onto a project, a workspace onto another of
   *  the same project and section. Moving a workspace to another project would mean moving its
   *  directory, which a drag is far too casual a gesture for. */
  function dragHandlers(item, accepts, move) {
    const over = (e) => {
      const drag = dragging();
      if (!drag || !accepts(drag)) return;
      e.preventDefault();
      // Handled here, so a workspace row doesn't also light up the project it sits in.
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const current = dropAt();
      if (current?.id !== item.id || current.after !== after) setDropAt({ id: item.id, after });
    };
    return {
      draggable: true,
      onDragStart: (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        // Firefox won't start a drag that carries no data.
        e.dataTransfer.setData('text/plain', item.id);
        setDragging(item);
      },
      onDragEnd: () => {
        setDragging(null);
        setDropAt(null);
      },
      onDragOver: over,
      onDragEnter: over,
      onDrop: (e) => {
        const drag = dragging();
        const at = dropAt();
        if (!drag || !accepts(drag) || !at) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(null);
        setDropAt(null);
        if (drag.id !== at.id) run(() => move(drag, at))();
      },
    };
  }

  const dropClass = (id) => ({
    'drop-before': dropAt()?.id === id && !dropAt().after,
    'drop-after': dropAt()?.id === id && dropAt().after,
    dragging: dragging()?.id === id,
  });

  function projectDrag(project) {
    return dragHandlers(
      { kind: 'project', id: project.id },
      (drag) => drag.kind === 'project',
      (drag, at) => moveProject(drag.id, at.id, at.after),
    );
  }

  function workspaceDrag(project, workspace) {
    return dragHandlers(
      { kind: 'workspace', id: workspace.id, projectId: project.id, archived: workspace.archived },
      (drag) => drag.kind === 'workspace' && drag.projectId === project.id && drag.archived === workspace.archived,
      (drag, at) => moveWorkspace(project.id, drag.id, at.id, at.after),
    );
  }

  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  const run = (fn) => () => {
    setFailure('');
    fn().catch((err) => setFailure(err.message));
  };

  /** Pick a workspace. On a phone that also puts the drawer away, since the terminal is what you
   *  picked it to see. */
  function pick(fn) {
    setDrawerOpen(false);
    fn();
  }

  /** The rail's own hide button: on a phone it closes the drawer, which is all the hiding there is. */
  function hideRail() {
    if (isMobile()) setDrawerOpen(false);
    else toggleSidebar();
  }

  /** The workspace menu from its ⋯ button, for touch screens, which have no right click. */
  function openWorkspaceMenuFrom(e, project, workspace) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openWorkspaceMenu({ preventDefault() {}, clientX: rect.left, clientY: rect.bottom }, project, workspace);
  }

  /** The right-click menu on a workspace row. Archiving is only offered here: it isn't a thing you
   *  reach for often, and a row button for it would sit next to delete, which is not. */
  function openWorkspaceMenu(e, project, workspace) {
    e.preventDefault();
    const items = workspace.archived
      ? [
          {
            label: 'Unarchive',
            description: 'Reopen its terminals, resuming each Claude session',
            action: run(() => unarchiveWorkspace(workspace.id)),
          },
        ]
      : [
          {
            label: 'Archive',
            description: 'Close its terminals, Claude sessions and editor',
            action: run(() => archiveWorkspace(workspace.id)),
          },
        ];
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        ...items,
        null,
        {
          label: 'Delete…',
          description: 'Delete the directory and everything in it',
          danger: true,
          action: () => setDialog({ kind: 'delete-workspace', project, workspace }),
        },
      ],
    });
  }

  const liveWorkspaces = (project) => project.workspaces.filter((w) => !w.archived);
  const archivedWorkspaces = (project) => project.workspaces.filter((w) => w.archived);

  return (
    <>
      <aside id="sidebar">
        <div id="sidebar-head">
          <span id="sidebar-title">Projects</span>
          <button id="add-project" type="button" title="Add a project" onClick={() => setDialog({ kind: 'project' })}>
            +
          </button>
          <button
            id="workbench-settings"
            type="button"
            title="Settings: billing and Claude auth"
            onClick={() => setDialog({ kind: 'settings' })}
          >
            &#9881;
          </button>
          <button id="sidebar-collapse" type="button" title="Hide the sidebar" onClick={hideRail}>
            &#8676;
          </button>
        </div>
        <div id="project-list">
          <Show when={state.projects.length} fallback={<p class="sidebar-empty">No projects yet. Add one with +.</p>}>
            <For each={state.projects}>
              {(project) => (
                <div class="project" classList={dropClass(project.id)} {...projectDrag(project)}>
                  <div class="project-row" onClick={() => toggleSection(project.id)} title={project.repo_url || 'Folder project: workspaces start empty'}>
                    <span class="project-caret">{collapsed().has(project.id) ? '▶' : '▼'}</span>
                    <span class="project-name">{project.name}</span>
                    <button
                      class="row-btn"
                      type="button"
                      title="New workspace"
                      onClick={stop(() => setDialog({ kind: 'workspace', project }))}
                    >
                      +
                    </button>
                    <button
                      class="row-btn"
                      type="button"
                      title="Configure project"
                      onClick={stop(() => setDialog({ kind: 'project', project }))}
                    >
                      &#9881;
                    </button>
                    <button
                      class="row-btn danger"
                      type="button"
                      title="Remove project"
                      onClick={stop(() => setDialog({ kind: 'delete-project', project }))}
                    >
                      &times;
                    </button>
                  </div>
                  <Show when={!collapsed().has(project.id)}>
                    <Show
                      when={liveWorkspaces(project).length || archivedWorkspaces(project).length}
                      fallback={<div class="project-empty">no workspaces</div>}
                    >
                      <For each={liveWorkspaces(project)}>
                        {(workspace) => (
                          <div
                            class="workspace-row"
                            classList={{ active: workspace.id === state.activeWorkspaceId, ...dropClass(workspace.id) }}
                            {...workspaceDrag(project, workspace)}
                            onClick={() => pick(() => openWorkspace(workspace.id))}
                            onContextMenu={(e) => openWorkspaceMenu(e, project, workspace)}
                          >
                            {/* The dot carries the path and the rest of the git status in its
                                hover card, which is why the row has no title of its own. */}
                            <WorkspaceStatusDot workspace={workspace} />
                            <span class="workspace-name">{workspace.name}</span>
                            <WorkspaceAgentDot workspace={workspace} />
                            <WorkspaceSync workspace={workspace} />
                            <button
                              class="row-btn more"
                              type="button"
                              title="More"
                              onClick={(e) => openWorkspaceMenuFrom(e, project, workspace)}
                            >
                              &#8943;
                            </button>
                            <button
                              class="row-btn danger ws-delete"
                              type="button"
                              title="Delete workspace"
                              onClick={stop(() => setDialog({ kind: 'delete-workspace', project, workspace }))}
                            >
                              &times;
                            </button>
                          </div>
                        )}
                      </For>
                      <Show when={archivedWorkspaces(project).length}>
                        <div class="archived-head" onClick={() => toggleSection(archivedKey(project.id))}>
                          <span class="project-caret">
                            {collapsed().has(archivedKey(project.id)) ? '▶' : '▼'}
                          </span>
                          <span>Archived ({archivedWorkspaces(project).length})</span>
                        </div>
                        <Show when={!collapsed().has(archivedKey(project.id))}>
                          <For each={archivedWorkspaces(project)}>
                            {(workspace) => (
                              <div
                                class="workspace-row archived"
                                classList={dropClass(workspace.id)}
                                {...workspaceDrag(project, workspace)}
                                title="Archived — nothing is running. Click to bring it back."
                                onClick={() => pick(run(() => unarchiveWorkspace(workspace.id)))}
                                onContextMenu={(e) => openWorkspaceMenu(e, project, workspace)}
                              >
                                {/* No status or agent dots: both are polled, and an archived
                                    workspace is left out of those polls on purpose. */}
                                <span class="workspace-name">{workspace.name}</span>
                                <button
                                  class="row-btn more"
                                  type="button"
                                  title="More"
                                  onClick={(e) => openWorkspaceMenuFrom(e, project, workspace)}
                                >
                                  &#8943;
                                </button>
                                <button
                                  class="row-btn danger ws-delete"
                                  type="button"
                                  title="Delete workspace"
                                  onClick={stop(() => setDialog({ kind: 'delete-workspace', project, workspace }))}
                                >
                                  &times;
                                </button>
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={failure()}>
            <p class="sidebar-error" onClick={() => setFailure('')} title="Dismiss">
              {failure()}
            </p>
          </Show>
        </div>
      </aside>

      <Show when={menu()}>
        <Menu at={menu().at} items={menu().items} onClose={() => setMenu(null)} />
      </Show>
      <Show when={dialog()?.kind === 'project'}>
        <ProjectDialog project={dialog().project} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.kind === 'settings'}>
        <SettingsDialog onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.kind === 'workspace'}>
        <WorkspaceDialog project={dialog().project} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.kind === 'delete-workspace'}>
        <ConfirmDialog
          title={`Delete workspace "${dialog().workspace.name}"?`}
          message={`This deletes ${dialog().workspace.path} and everything in it, and closes its terminals. It cannot be undone.`}
          submitLabel="Delete"
          onConfirm={() => deleteWorkspace(dialog().workspace.id)}
          onClose={() => setDialog(null)}
        />
      </Show>
      <Show when={dialog()?.kind === 'delete-project'}>
        <ConfirmDialog
          title={`Remove project "${dialog().project.name}"?`}
          message={`This forgets the project${dialog().project.repo_url ? ' and deletes its local mirror' : ''}. Delete its workspaces first if it still has any.`}
          submitLabel="Remove"
          onConfirm={() => deleteProject(dialog().project.id)}
          onClose={() => setDialog(null)}
        />
      </Show>
    </>
  );
}
