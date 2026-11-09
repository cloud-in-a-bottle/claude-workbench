import { Show, createEffect, onMount } from 'solid-js';

import { ExtraKeys } from './components/ExtraKeys';
import { Sidebar } from './components/Sidebar';
import { SidePanel } from './components/SidePanel';
import { TerminalLayout } from './components/TerminalLayout';
import { TopBar } from './components/TopBar';
import { drawerOpen, isMobile, mobilePanelOpen, setDrawerOpen, trackViewport } from './mobile';
import { enabled as sidePanelEnabled, watchPanelSettings } from './sidePanel';
import { init, sidebarHidden, state } from './store';

export function App() {
  onMount(() => {
    init().catch((err) => console.error('could not load the workbench', err));
    watchPanelSettings();
    trackViewport();
  });

  createEffect(() => document.body.classList.toggle('sidebar-hidden', sidebarHidden()));
  createEffect(() => document.body.classList.toggle('mobile', isMobile()));
  createEffect(() => document.body.classList.toggle('drawer-open', isMobile() && drawerOpen()));
  createEffect(() => document.body.classList.toggle('mobile-panel', isMobile() && mobilePanelOpen()));
  // Nothing to look at on a phone until a workspace is picked, so start on the list of them.
  createEffect(() => {
    if (isMobile() && state.ready && !state.activeWorkspaceId) setDrawerOpen(true);
  });

  return (
    <>
      <Sidebar />
      <div id="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
      <div id="main">
        <TopBar />
        <div id="sp-split">
          <div id="sp-left">
            <TerminalLayout />
            <Show when={isMobile() && state.activeWorkspaceId}>
              <ExtraKeys />
            </Show>
          </div>
          <Show when={sidePanelEnabled()}>
            <SidePanel />
          </Show>
        </div>
      </div>
    </>
  );
}
