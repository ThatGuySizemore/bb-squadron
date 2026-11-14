// BB Squadron: frontend entry. Compiled by `bb plugin build`; React and
// @get-bb/plugin-sdk/app come from the BB app at load time.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BoardPage } from "./board/Board.js";
import { ConnectionSettings } from "./board/ConnectionSettings.js";
import { SidePanelBoard } from "./board/SidePanel.js";
import "./board/board.css";
import "./board/live.css";

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "linear-connection", title: "Linear connection", component: ConnectionSettings });
  app.slots.navPanel({
    id: "board",
    title: "Squadron",
    icon: "Plane",
    // Routed at /plugins/squadron/board.
    path: "board",
    component: BoardPage,
  });
  // The same board in a thread's side panel, opened from the panel's launcher.
  // experimental_tab is an experimental BB API; only this registration depends on it.
  app.slots.experimental_tab({
    id: "board",
    title: "Squadron",
    icon: "Plane",
    tooltip: "Watch this project's board beside the thread",
    context: { kind: "thread" },
    availability: "action",
    layout: "flush",
    component: SidePanelBoard,
  });
});
