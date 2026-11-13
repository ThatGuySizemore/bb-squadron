// BB Squadron: frontend entry. Compiled by `bb plugin build`; React and
// @get-bb/plugin-sdk/app come from the BB app at load time.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BoardPage } from "./board/Board";
import "./board/board.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Squadron",
    icon: "Plane",
    // Routed at /plugins/squadron/board.
    path: "board",
    component: BoardPage,
  });
});
