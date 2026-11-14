// Renders the live BoardView outside BB, on the comp's emulated BB themes, at the
// full-page and side-panel widths. A stand-in for BB's plugin runtime supplies the
// SDK hooks; nothing reads or writes anywhere. See README.md beside this file.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { FIXTURES, pickerProjects } from "./fixtures.js";
// app.tsx loads these for the plugin.
import "../../board/board.css";

const providerIcon = ({ provider }: { provider: { id: string } }) =>
  React.createElement("svg", { viewBox: "0 0 6 6", width: 12, height: 12, "aria-hidden": true, shapeRendering: "crispEdges" },
    React.createElement("rect", { x: 1, y: 1, width: 4, height: 4, fill: provider.id === "codex" ? "currentColor" : "none", stroke: "currentColor", strokeWidth: 1 }));

const params = new URLSearchParams(location.search);
const fixture = FIXTURES.find((f) => f.name === params.get("fixture")) ?? FIXTURES[0]!;

Object.assign(globalThis, { __bbPluginRuntime: { react: React, pluginSdkApp: {
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: providerIcon,
  experimental_FileLink: ({ target, children }: { target: { path: string }; children: React.ReactNode }) => React.createElement("a", { href: "#", title: target.path }, children),
  useBbNavigate: () => ({ toThread: (id: string) => console.log("open thread", id), openUrl: (url: string) => { console.log("open", url); return true; } }),
  useBbContext: () => ({ projectId: fixture.name }),
  useRpc: () => ({ call: async (method: string) => {
    if (method === "board.projectCounts") return pickerProjects.counts;
    throw new Error(`The preview runs no ${method}.`);
  } }),
  useRealtime: () => undefined,
  experimental_useRpcQuery: () => ({ isFetching: false, error: null, data: fixture.board.doctor, refetch: async () => undefined }),
} } });

const theme = params.get("theme") === "light" ? "light" : "dark";
const width = params.get("width") === "narrow" ? "narrow" : "wide";
document.documentElement.className = `theme-${theme} width-${width}`;

const { BoardView } = await import("../../board/Board.js");
const { ProjectButton, ProjectList, pickerMeta } = await import("../../board/ProjectPicker.js");

function Preview() {
  const [pickerOpen, setPickerOpen] = React.useState(params.get("picker") === "open");
  const [landedNow, setLandedNow] = React.useState(false);
  // ?land=SIZE-947 flies that lane, then lands it after two seconds, to show the burst and the arrival.
  const land = params.get("land");
  React.useEffect(() => { if (land) { const t = setTimeout(() => setLandedNow(true), 2000); return () => clearTimeout(t); } }, []);
  const board = React.useMemo(() => !land ? fixture.board : { ...fixture.board, lanes: fixture.board.lanes.map((lane) => lane.specId !== land ? lane
    : landedNow ? { ...lane, state: "landed" as const, landedAt: Date.now(), tickets: lane.tickets.map((t) => ({ ...t, state: "done" as const })), needs: [] } : lane) }, [landedNow]);
  const flying = board.lanes.filter((lane) => lane.state !== "landed").length;
  return React.createElement(BoardView, {
    board, demo: false, modeSwitch: null, projectId: fixture.name, tracker: fixture.tracker, fleet: fixture.fleet,
    // The narrow width is the side panel: the comp's narrow layout, thread links opening in the main view.
    placement: width === "narrow" ? "panel" : "page",
    dispatch: (action: unknown) => console.log("dispatch", action), onPlan: (...args: unknown[]) => console.log("plan", ...args), onSetUp: () => console.log("set up"),
    projectButton: React.createElement(ProjectButton, { name: fixture.projectName, meta: pickerMeta(fixture.tracker?.kind, { ready: board.ready.length, flying }),
      open: pickerOpen, controls: "picker", onToggle: () => setPickerOpen((o) => !o) }),
    projectList: pickerOpen ? React.createElement(ProjectList, { id: "picker", projects: pickerProjects.projects, counts: pickerProjects.counts, current: fixture.name, onPick: () => setPickerOpen(false) }) : null,
  });
}

createRoot(document.getElementById("frame")!).render(React.createElement(Preview));
