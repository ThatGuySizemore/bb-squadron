// SIZE-953: the board page's picker, opening order, Doctor status, Set up and
// signal diagnostic, rendered outside BB through the app-runtime stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../lib/board-model.js";
import type { DoctorReport } from "../lib/doctor.js";

const base: Board = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false, lanes: [], ready: [], shaping: [], openIssues: [] };
const report = (fix: ("setup" | "settings")[], settingsExists = true): DoctorReport => ({
  ready: fix.length === 0,
  checks: [
    { id: "skills", name: "Matt's plugin", status: "pass", message: "Installed." },
    { id: "setup", name: "Matt's setup files", status: fix.includes("setup") ? "fix" : "pass", message: fix.includes("setup") ? "Press Set up to create docs/agents/domain.md with Matt's setup in a thread." : "Present." },
    { id: "settings", name: "Project settings", status: fix.includes("settings") ? "fix" : "pass", message: fix.includes("settings") ? "docs/agents/squadron.md is missing or unreadable." : "Ready." },
  ],
  configurationFiles: [{ id: "project-settings", name: "Project settings", path: "/repo/docs/agents/squadron.md", hostId: "h", exists: settingsExists }],
});

async function render(node: unknown): Promise<string> {
  await import("./fixtures/app-runtime.js");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
}

test("the board opens on the context project, then the last pick, then an open picker; an explicit pick wins", async () => {
  await import("./fixtures/app-runtime.js");
  const { currentProject } = await import("../board/ProjectPicker.js");
  assert.equal(currentProject({ picked: null, context: "proj-a", lastPick: "proj-b" }), "proj-a");
  assert.equal(currentProject({ picked: null, context: null, lastPick: "proj-b" }), "proj-b");
  assert.equal(currentProject({ picked: null, context: null, lastPick: null }), null, "nothing to open: the picker asks");
  assert.equal(currentProject({ picked: "proj-c", context: "proj-a", lastPick: "proj-b" }), "proj-c");
});

test("the picker lists every project with its tracker kind and Ready and Flying counts, marking the one shown", async () => {
  const { createElement } = await import("react");
  const { ProjectList } = await import("../board/ProjectPicker.js");
  const html = await render(createElement(ProjectList, {
    id: "picker", current: "proj-wordwell", onPick: () => undefined,
    projects: [{ id: "proj-squadron", name: "BB Squadron" }, { id: "proj-wordwell", name: "WordWell" }, { id: "proj-bbbot", name: "bb-bot" }],
    counts: { projects: [
      { id: "proj-squadron", tracker: "linear", ready: 2, flying: 0, note: null },
      { id: "proj-wordwell", tracker: "linear", ready: 1, flying: 1, note: null },
      { id: "proj-bbbot", tracker: "local-markdown", ready: null, flying: null, note: "Not read yet." },
    ] },
  }));
  for (const text of ["BB Squadron", "WordWell", "bb-bot", "Linear", "Local markdown", "2 ready", "0 flying", "1 flying", "Not read yet."]) {
    assert.ok(html.includes(text), `the picker shows ${text}`);
  }
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /aria-current="true"[^>]*>[\s\S]*?WordWell/);
  const loading = await render(createElement(ProjectList, { id: "picker", current: null, onPick: () => undefined,
    projects: [{ id: "proj-squadron", name: "BB Squadron" }], counts: null }));
  assert.ok(loading.includes("BB Squadron") && loading.includes("Counting"), "names show while counts load");
});

test("Doctor's status shows in the header without opening the panel", async () => {
  const { createElement } = await import("react");
  const { BoardView } = await import("../board/Board.js");
  const view = (doctor?: DoctorReport) => render(createElement(BoardView, { board: { ...base, ...(doctor ? { doctor } : {}) },
    demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
  const doctorButton = (html: string) => /<button[^>]*aria-controls[^>]*>(Doctor[\s\S]*?)<\/button>/.exec(html)?.[1].replace(/<[^>]+>/g, "");
  assert.equal(doctorButton(await view(report(["setup", "settings"], false))), "Doctor: 2 to fix");
  assert.equal(doctorButton(await view(report([]))), "Doctor: Ready");
  assert.equal(doctorButton(await view()), "Doctor", "no status before Doctor has run");
});

test("Set up appears on a project that lacks Matt's setup files or squadron.md, and not otherwise", async () => {
  const { createElement } = await import("react");
  const { BoardView, needsSetup } = await import("../board/Board.js");
  assert.equal(needsSetup({ ...base, doctor: report(["setup"]) }), true);
  assert.equal(needsSetup({ ...base, doctor: report(["settings"], false) }), true);
  assert.equal(needsSetup({ ...base, doctor: report(["settings"], true) }), false, "an existing but broken squadron.md is Doctor's fix, not Set up");
  assert.equal(needsSetup({ ...base, doctor: report([]) }), false);
  const html = await render(createElement(BoardView, { board: { ...base, doctor: report(["setup", "settings"], false) },
    demo: false, modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined, onSetUp: () => undefined }));
  assert.equal((html.match(/>Set up<\/button>/g) ?? []).length, 1, "one Set up button");
});

test("an invalid realtime signal's diagnostic is visible on the board", async () => {
  const { createElement } = await import("react");
  const { BoardView } = await import("../board/Board.js");
  const html = await render(createElement(BoardView, { board: base, demo: false, modeSwitch: null, dispatch: () => undefined,
    onPlan: () => undefined, diagnostic: "Squadron ignored a board-changed update in an unexpected shape." }));
  assert.match(html, /role="status"[^>]*>[^<]*Squadron ignored a board-changed update/);
});
