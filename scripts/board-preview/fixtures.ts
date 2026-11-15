// Boards for the preview: the approved comp's real snapshots (comps/live-board/data.js,
// read 14 Nov 2026) as live Board models, plus one board of the states the comp
// doesn't show. Times are relative to when the preview opens.
import type { Board, Lane, Route, Ticket } from "../../lib/board-model.js";
import type { DoctorReport } from "../../lib/doctor.js";
import type { TrackerInfo } from "../../board/Board.js";
import type { ProjectCounts } from "../../lib/board-contract.js";

const MIN = 60_000;
const now = Date.now();
const claude: Route = { family: "claude", model: "claude-opus-5-5", effort: "high" };
const codex: Route = { family: "gpt", model: "gpt-6.1-sol", effort: "high" };

const ticket = (id: string, title: string, blockedBy: string[], route: Route, state: Ticket["state"] = "blocked", extra: Partial<Ticket> = {}): Ticket =>
  ({ id, title, blockedBy, route, state, minutes: 0, ...extra });

const connect = (states: Partial<Record<string, Partial<Ticket>>>): Ticket[] => [
  ticket("SIZE-948", "Comp: the live dithered board", [], claude),
  ticket("SIZE-949", "Tracker seam and detection", [], codex),
  ticket("SIZE-950", "Local markdown tracker", ["SIZE-949"], codex),
  ticket("SIZE-951", "GitHub tracker", ["SIZE-949"], codex),
  ticket("SIZE-952", "Open issues, Shaping and New spec", ["SIZE-949"], claude),
  ticket("SIZE-953", "Project picker, Set up and Doctor status", ["SIZE-949"], claude),
  ticket("SIZE-954", "Glossary and Squadron docs", ["SIZE-949"], codex),
  ticket("SIZE-956", "Dither renderer", ["SIZE-948"], claude),
  ticket("SIZE-955", "Lanes in every tracker", ["SIZE-950", "SIZE-951"], codex),
  ticket("SIZE-957", "Outside lanes", ["SIZE-955"], claude),
  ticket("SIZE-958", "Restyle the board to the comp", ["SIZE-948", "SIZE-952", "SIZE-953", "SIZE-956", "SIZE-957"], claude),
  ticket("SIZE-959", "Squadron in a thread's side panel", ["SIZE-958"], claude),
].map((t) => ({ ...t, ...states[t.id] }));

const SPEC_947 = { id: "SIZE-947", title: "Squadron connects nothing to something: any tracker, every project, the whole path", url: "https://linear.app/sizemore/issue/SIZE-947" };

const landed: Lane[] = [
  { specId: "SIZE-939", title: "Slim Squadron: the board and lanes on Matt's skills", lead: codex, leadThreadId: "thr_landed939", branch: "slim",
    state: "landed", minutes: 88, acceptOwner: false, url: "https://linear.app/sizemore/issue/SIZE-939", landedAt: now - 40 * MIN,
    pr: { number: 3, checks: "passing", url: "https://github.com/example/bb-squadron/pull/3", state: "merged" },
    tickets: ["SIZE-940", "SIZE-941", "SIZE-942", "SIZE-943", "SIZE-944", "SIZE-945", "SIZE-946"].map((id) => ticket(id, id, [], codex, "done")) },
  { specId: "SIZE-871", title: "Spec A: the Squadron board reads Linear", lead: codex, leadThreadId: "thr_landed871", branch: "spec-a",
    state: "landed", minutes: 231, acceptOwner: false, url: "https://linear.app/sizemore/issue/SIZE-871", landedAt: now - 6 * 60 * MIN - 16 * MIN,
    tickets: [] },
];

const check = (id: DoctorReport["checks"][number]["id"], name: string, status: "pass" | "fix", message: string) => ({ id, name, status, message });
const file = (exists: boolean): DoctorReport["configurationFiles"][number] =>
  ({ id: "project-settings", name: "Project settings", path: "docs/agents/squadron.md", hostId: "host", exists });

const doctorPass: DoctorReport = { ready: true, configurationFiles: [file(true)], checks: [
  check("tracker", "Tracker: Linear", "pass", "docs/agents/issue-tracker.md declares Linear as the issue tracker."),
  check("setup", "Matt's setup files", "pass", "Issue tracker, triage labels and domain docs are present."),
  check("settings", "Project settings", "pass", "Quick check, stop list, time limits, routes and final review and status mapping are ready."),
  check("linear", "Linear key", "pass", "Linear is connected."),
  check("github", "GitHub login", "pass", "gh is signed in for github.com."),
] };

const linear = (project: string): Board["tracker"] => ({ state: "current", message: "", syncedAt: now - 12_000, project });
const base = { tick: 0, laneCapacity: 0, workersPerLane: 0, autoStart: false } as const;

export interface Fixture {
  name: string;
  board: Board;
  tracker?: TrackerInfo;
  projectName: string;
}

const counts: ProjectCounts = { projects: [
  { id: "squadron", tracker: "linear", ready: 0, flying: 1, note: null },
  { id: "bb-bot", tracker: "local-markdown", ready: 0, flying: 1, note: null },
  { id: "bb-bot-home", tracker: null, ready: null, flying: null, note: "No docs/agents/issue-tracker.md." },
  { id: "wordwell", tracker: "linear", ready: null, flying: null, note: "Not read in this preview." },
] };
export const pickerProjects = { counts, projects: [
  { id: "squadron", name: "BB Squadron" }, { id: "bb-bot", name: "bb-bot" }, { id: "bb-bot-home", name: "bb Bot" }, { id: "wordwell", name: "WordWell" },
] };

const squadronFlying: Fixture = {
  name: "squadron", projectName: "BB Squadron", tracker: { kind: "linear" },
  board: { ...base, doctor: doctorPass, tracker: linear("Sizemore · BB Squadron"), ready: [], shaping: [], openIssues: [], lanes: [
    { specId: SPEC_947.id, title: SPEC_947.title, url: SPEC_947.url, outside: true, lead: codex, leadThreadId: "thr_3r2xjejz9k", branch: "connect",
      state: "flying", minutes: 7, acceptOwner: false,
      needs: [{ threadId: "thr_3r2xjejz9k", kind: "waiting", text: "Lead · Connect asks you to approve the comp on SIZE-948." }],
      tickets: connect({ "SIZE-948": { state: "working", minutes: 5, threadId: "thr_z6izzrgzw5" }, "SIZE-949": { state: "working", minutes: 5, threadId: "thr_hfhuvu63rq" } }) },
    ...landed,
  ] },
};

const squadronReady: Fixture = {
  name: "squadron-ready", projectName: "BB Squadron", tracker: { kind: "linear" },
  board: { ...base, doctor: doctorPass, tracker: linear("Sizemore · BB Squadron"), shaping: [], openIssues: [], lanes: landed,
    ready: [{ ...SPEC_947, ticketCount: 12, routes: [claude, codex], blockedBy: [], acceptOwner: false, startReason: null,
      waiting: connect({}).filter((t) => t.blockedBy.length).map(({ id, title, blockedBy }) => ({ id, title, blockedBy })) }] },
};

const squadronPublished: Fixture = {
  name: "squadron-published", projectName: "BB Squadron", tracker: { kind: "linear" },
  board: { ...base, doctor: doctorPass, tracker: linear("Sizemore · BB Squadron"), ready: [], lanes: landed,
    shaping: [{ ...SPEC_947, ticketCount: 0, missing: "Ready label, but no tickets yet", action: "tickets" }],
    openIssues: [
      { id: "SIZE-904", title: "Doctor and settings: check gh for the repo's host, require Matt's setup docs, match route labels without case", labels: ["needs-triage"], url: "https://linear.app/sizemore/issue/SIZE-904", priority: 3 },
      { id: "SIZE-931", title: "Board: show Ready-row blockers, surface bad signals, show Doctor status, drop the re-parent path", labels: ["needs-triage"], url: "https://linear.app/sizemore/issue/SIZE-931", priority: 0 },
    ] },
};

const bbBotTicket = (n: number, title: string, blockedBy: number[], state: Ticket["state"] = "blocked") =>
  ticket(String(n).padStart(2, "0"), title, blockedBy.map((b) => String(b).padStart(2, "0")), claude, state,
    state === "working" ? { minutes: 23, threadId: `thr_bbbot_${n}` } : {});
const bbBot: Fixture = {
  name: "bb-bot", projectName: "bb-bot", tracker: { kind: "local-markdown" },
  board: { ...base, ready: [], shaping: [], openIssues: [],
    doctor: { ready: false, configurationFiles: [file(false)], checks: [
      check("tracker", "Tracker: Local markdown", "pass", "docs/agents/issue-tracker.md declares Local markdown as the issue tracker."),
      check("setup", "Matt's setup files", "pass", "Issue tracker, triage labels and domain docs are present."),
      check("settings", "Project settings", "fix", "Create docs/agents/squadron.md with Quick check, Stop list, Time limits, Routes and Final review sections."),
    ] },
    lanes: [{ specId: "BB-BOT", title: "bb Bot", outside: true, lead: claude, leadThreadId: "thr_6irpp3hp8d", branch: "integration/bb-bot",
      state: "flying", minutes: 83, acceptOwner: false, tickets: [
        bbBotTicket(1, "Walking skeleton: starter bot with its home thread", [], "branch"),
        bbBotTicket(2, "Personality reaches the agent", [1], "branch"),
        bbBotTicket(3, "Conversational setup", [2], "branch"),
        bbBotTicket(4, "Built-in notes memory provider", [2], "branch"),
        bbBotTicket(5, "Automatic conversation saving", [4], "branch"),
        bbBotTicket(6, "More bots, archive and restore", [3], "branch"),
        bbBotTicket(7, "Bot settings screen", [6], "working"),
        bbBotTicket(8, "A live sidebar", [1], "branch"),
        bbBotTicket(9, "Delegation", [2], "branch"),
        bbBotTicket(10, "Worker results and management", [8, 9], "branch"),
        bbBotTicket(11, "Hindsight memory provider", [4], "branch"),
        bbBotTicket(12, "Switch Josh's setup over", [5, 11]),
        bbBotTicket(13, "Thread header", [8], "branch"),
        bbBotTicket(14, "Avatar comes alive: idle life", [13], "branch"),
        bbBotTicket(15, "Avatar reacts to what's happening", [14, 10], "branch"),
        bbBotTicket(16, "Notifications and quiet hours", [10, 7]),
        bbBotTicket(17, "Routines", [16]),
        bbBotTicket(18, "Triggers", [17]),
        bbBotTicket(19, "Bot-to-bot messages", [6], "branch"),
        bbBotTicket(20, "Collapsed exchanges and @-mentions", [19], "working"),
        bbBotTicket(21, "Optional avatar row at the top", [15], "working"),
        bbBotTicket(22, "Retire Bots Sidebar", [21]),
      ] }] },
};

const empty: Fixture = {
  name: "empty", projectName: "bb Bot", tracker: { kind: null, note: "No docs/agents/issue-tracker.md." },
  board: { ...base, ready: [], shaping: [], openIssues: [], lanes: [],
    doctor: { ready: false, configurationFiles: [file(false)], checks: [
      check("tracker", "Tracker", "fix", "Couldn't determine the tracker from docs/agents/issue-tracker.md. Set ## Tracker in docs/agents/squadron.md to Linear, GitHub or Local markdown."),
      check("setup", "Matt's setup files", "fix", "Press Set up to create docs/agents/issue-tracker.md, docs/agents/triage-labels.md, docs/agents/domain.md with Matt's setup in a thread."),
      check("settings", "Project settings", "fix", "Create docs/agents/squadron.md with Quick check, Stop list, Time limits, Routes and Final review sections."),
    ] } },
};

/** The live states the comp's snapshots don't show: stopped, owner merge, a question, review, a failure, a PR, held tickets. Synthetic. */
const states: Fixture = {
  name: "states", projectName: "Fixture project", tracker: { kind: "github" },
  board: { ...base, doctor: { ...doctorPass, checks: doctorPass.checks.map((c) => c.id === "github" ? { ...c, status: "fix" as const, message: "Run gh auth login for github.com." } : c), ready: false },
    lanes: [
      { specId: "FIX-10", title: "A lane with an open PR and a question", lead: claude, leadThreadId: "thr_a", branch: "fix-10", state: "pr-open", minutes: 64, acceptOwner: false,
        pr: { number: 42, checks: "pending", url: "https://github.com/example/r/pull/42", state: "open" },
        tickets: [ticket("FIX-11", "Read the thing", [], codex, "done"), ticket("FIX-12", "Ask the owner", ["FIX-11"], claude, "question", { threadId: "thr_q", question: "Which label routes to Claude?", minutes: 12 }),
          ticket("FIX-13", "Review the slice", ["FIX-11"], codex, "review", { threadId: "thr_r", minutes: 4 }), ticket("FIX-14", "Ready to go", ["FIX-11"], codex, "ready"),
          ticket("FIX-15", "Held for the owner's call", [], codex, "held")],
        unmatchedThreads: [{ threadId: "thr_x", title: "Scratch notes" }] },
      { specId: "FIX-20", title: "A stopped lane whose worker failed", lead: codex, leadThreadId: "thr_b", branch: "fix-20", state: "stopped", stopped: true, minutes: 31, acceptOwner: false,
        stopReason: "The Lead stopped after two strikes.", tickets: [ticket("FIX-21", "Break it", [], codex, "failed", { threadId: "thr_f", failure: "Tests failed twice.", minutes: 18 })] },
      { specId: "FIX-30", title: "An accept:owner lane waiting on your merge", lead: claude, leadThreadId: "thr_c", branch: "fix-30", state: "merge-waits", minutes: 140, acceptOwner: true,
        pr: { number: 43, checks: "passing", url: "https://github.com/example/r/pull/43", state: "open" },
        tickets: [ticket("FIX-31", "Done one", [], claude, "branch"), ticket("FIX-32", "Done two", ["FIX-31"], claude, "branch")] },
    ],
    ready: [{ id: "FIX-40", title: "A Ready spec Doctor holds back", ticketCount: 4, routes: [claude], blockedBy: [], acceptOwner: true, startReason: "Doctor: 1 to fix before Start.",
      waiting: [{ id: "FIX-42", title: "Waits", blockedBy: ["FIX-41", "OUT-9"] }], held: [{ id: "FIX-43", title: "Needs info from the owner" }] }],
    shaping: [{ id: "FIX-50", title: "A spec with an open planning thread", ticketCount: 2, missing: "Planning thread still open", action: "resume" }],
    openIssues: [{ id: "#77", title: "An urgent idea under a parent", labels: ["enhancement"], under: "Under #70 · Board polish", priority: 1 }],
  },
};

/** Synthetic reader states for SQD-215 visual checks, never live thread data. */
const liveSteps: Fixture = {
  name: "live-steps", projectName: "Synthetic live steps", tracker: { kind: "github" }, fleet: 1,
  board: { ...base, ready: [], shaping: [], openIssues: [], lanes: [{
    specId: "FIX-1", title: "Synthetic live activity", lead: codex, leadThreadId: "lead", branch: "fixture/live-steps",
    state: "flying", minutes: 12, acceptOwner: false, workingThreads: 2,
    liveStep: { status: "active", step: "Waiting on worker", since: now - 4 * MIN },
    tickets: [
      ticket("FIX-2", "Read the confirmed testing decisions", [], codex, "working", { threadId: "worker",
        liveStep: { status: "active", step: "Checking the confirmed testing decisions before running the…", since: now - 2 * MIN } }),
      ticket("FIX-3", "Run the focused checks", [], codex, "failed", { threadId: "error",
        liveStep: { status: "error", step: "Running npm test", since: now - MIN } }),
      ticket("FIX-4", "An agent with no timeline", [], codex, "question", { threadId: "empty" }),
      ticket("FIX-5", "Review the current branch", [], claude, "review", { threadId: "review",
        liveStep: { status: "waiting-for-host", step: "Reading file", since: now - 3 * MIN } }),
    ],
  }] },
};

/** Synthetic queue, including a blocker before the next eligible spec. */
const queue: Fixture = {
  name: "queue", projectName: "Synthetic queue", tracker: { kind: "linear" },
  board: { ...base, doctor: doctorPass, tracker: linear("Synthetic queue"), lanes: [], shaping: [], openIssues: [],
    ready: [
      { id: "FIX-1", title: "A spec waiting for its dependency", ticketCount: 2, routes: [codex], blockedBy: ["FIX-9"], acceptOwner: false,
        startReason: "Waits on FIX-9", waitingFor: [{ id: "FIX-9", title: "Dependency", url: "https://example.invalid/FIX-9", outside: false }] },
      { id: "FIX-5", title: "The next eligible spec in the owner's queue", ticketCount: 3, routes: [codex], blockedBy: [], acceptOwner: false, startReason: null },
    ] },
};

const workItems: Fixture = {
  name: "work-items", projectName: "Synthetic work item lanes", tracker: { kind: "linear" },
  board: { ...base, laneCapacity: 3, tracker: linear("Synthetic work item lanes"), ready: [], shaping: [], openIssues: [], lanes: [
    { specId: "FIX-9", kind: "work-item", title: "Keep the work item's live step visible while its checks run", lead: codex,
      leadThreadId: "work-item", branch: "work/fix-9", state: "flying", minutes: 12, acceptOwner: false, tickets: [], workingThreads: 1,
      liveStep: { status: "active", step: "Running npm test", since: now - MIN } },
    { specId: "FIX-10", kind: "work-item", title: "A stopped work item ready to Resume", lead: codex, leadThreadId: "stopped-item",
      branch: "work/fix-10", state: "stopped", stopped: true, minutes: 21, acceptOwner: false, tickets: [] },
    { specId: "FIX-20", title: "A spec with completed tickets included in its total", totalTicketCount: 5, lead: claude,
      leadThreadId: "spec", branch: "spec/fix-20", state: "flying", minutes: 18, acceptOwner: false, workingThreads: 1,
      tickets: [ticket("FIX-21", "Build the compact row", [], codex, "working")],
      liveStep: { status: "active", step: "Waiting on worker", since: now - MIN } },
  ] },
};

export const FIXTURES: Fixture[] = [squadronFlying, squadronReady, squadronPublished, bbBot, empty, states, liveSteps, queue, workItems];
