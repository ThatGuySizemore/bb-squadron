// SIZE-948 comp data. Every value below was read on 14 Nov 2026, 00:58 CST,
// from the source named beside it. Nothing here is synthetic except where a
// line says "illustrative". The board in the comp derives nothing on its own:
// it draws these snapshots.
window.COMP_DATA = (() => {
  const connectTickets = (states) => [
    // Linear: SIZE-947's sub-issues and their "blocks" relations.
    { id: "SIZE-948", title: "Comp: the live dithered board", blockedBy: [], route: "claude", ...states["SIZE-948"] },
    { id: "SIZE-949", title: "Tracker seam and detection", blockedBy: [], route: "codex", ...states["SIZE-949"] },
    { id: "SIZE-950", title: "Local markdown tracker", blockedBy: ["SIZE-949"], route: "codex" },
    { id: "SIZE-951", title: "GitHub tracker", blockedBy: ["SIZE-949"], route: "codex" },
    { id: "SIZE-952", title: "Open issues, Shaping and New spec", blockedBy: ["SIZE-949"], route: "claude" },
    { id: "SIZE-953", title: "Project picker, Set up and Doctor status", blockedBy: ["SIZE-949"], route: "claude" },
    { id: "SIZE-954", title: "Glossary and Squadron docs", blockedBy: ["SIZE-949"], route: "codex" },
    { id: "SIZE-956", title: "Dither renderer", blockedBy: ["SIZE-948"], route: "claude" },
    { id: "SIZE-955", title: "Lanes in every tracker", blockedBy: ["SIZE-950", "SIZE-951"], route: "codex" },
    { id: "SIZE-957", title: "Outside lanes", blockedBy: ["SIZE-955"], route: "claude" },
    { id: "SIZE-958", title: "Restyle the board to the comp", blockedBy: ["SIZE-948", "SIZE-952", "SIZE-953", "SIZE-956", "SIZE-957"], route: "claude" },
    { id: "SIZE-959", title: "Squadron in a thread's side panel", blockedBy: ["SIZE-958"], route: "claude" },
  ].map((t) => ({ state: "waiting", ...t }));

  const ROUTES = {
    // docs/agents/squadron.md routes: `ui` -> Claude, default -> GPT.
    claude: { family: "Claude Code", model: "opus-5.5", effort: "high" },
    codex: { family: "Codex", model: "gpt-6.1-sol", effort: "high" },
    // BB reports a thread's provider; the comp didn't read the Leads' models.
    "codex-lead": { family: "Codex", text: "Codex" },
    "claude-lead": { family: "Claude Code", text: "Claude Code" },
    // bb-bot's Lead builds tickets with its own subagents, not child threads.
    subagent: { family: "Claude Code", text: "Lead's subagent" },
  };

  const SPEC_947 = {
    id: "SIZE-947",
    title: "Squadron connects nothing to something: any tracker, every project, the whole path",
    url: "https://linear.app/sizemore/issue/SIZE-947",
  };

  const landed = [
    // Linear completedAt; git log on main.
    { id: "SIZE-939", title: "Slim Squadron: the board and lanes on Matt's skills", landedAt: "00:18", lane: "1 h 28 m", proof: "PR #3 merged", url: "https://linear.app/sizemore/issue/SIZE-939" },
    { id: "SIZE-871", title: "Spec A: the Squadron board reads Linear", landedAt: "13 Nov, 18:42", lane: "3 h 51 m", proof: "62afb50 on main", url: "https://linear.app/sizemore/issue/SIZE-871" },
  ];

  // The one landing the comp can replay: SIZE-939's seven tickets, all in
  // the branch when PR #3 merged (Linear completedAt 06:18Z for each).
  const landing939 = {
    specId: "SIZE-939",
    title: "Slim Squadron: the board and lanes on Matt's skills",
    lead: "codex-lead",
    minutes: "1 h 28 m",
    branch: "slim",
    pr: "PR #3 · merged",
    tickets: [
      { id: "SIZE-940", title: "Strip the write machinery", blockedBy: [] },
      { id: "SIZE-941", title: "Project settings, Doctor and owner files", blockedBy: ["SIZE-940"] },
      { id: "SIZE-942", title: "Plan wraps Matt's skills", blockedBy: ["SIZE-940"] },
      { id: "SIZE-943", title: "Start a lane", blockedBy: ["SIZE-941"] },
      { id: "SIZE-944", title: "Lane detail: workers, tickets and PR", blockedBy: ["SIZE-943"] },
      { id: "SIZE-945", title: "Stop, Resume and Needs you", blockedBy: ["SIZE-943"] },
      { id: "SIZE-946", title: "Merge and accept:owner", blockedBy: ["SIZE-945"] },
    ].map((t) => ({ ...t, state: "done", route: "codex" })),
  };

  // bb-bot: .scratch/bb-bot/issues/*.md "Blocked by:" lines on main; states from
  // the Lead's "Merge ticket NN" commits on integration/bb-bot and its thread
  // (07, 20 and 21 building). Its Status lines still read ready-for-agent on
  // both branches, so a Status-line reader would show every ticket Waiting.
  const bbBotTicket = (n, title, blockedBy, state = "waiting") => ({
    id: String(n).padStart(2, "0"), title, blockedBy: blockedBy.map((b) => String(b).padStart(2, "0")), state, route: "subagent",
  });
  const bbBotTickets = [
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
  ];

  const doctorLinear = {
    summary: "pass",
    label: "Start ready",
    tracker: { kind: "Linear", why: "issue-tracker.md names the Linear project BB Squadron" },
    checks: [
      { name: "Tracker", status: "pass", text: "Linear, because docs/agents/issue-tracker.md names the Linear project BB Squadron." },
      { name: "Matt's setup files", status: "pass", text: "issue-tracker.md, triage-labels.md and domain.md are in docs/agents/." },
      { name: "Project settings", status: "pass", text: "docs/agents/squadron.md has every section, including the Status mapping Linear needs." },
      { name: "Linear key", status: "pass", text: "Set in BB's secret settings (illustrative: the comp didn't run Doctor)." },
      { name: "GitHub login", status: "pass", text: "gh is signed in for github.com, this repo's host (illustrative)." },
    ],
  };

  const projects = {
    "bb-squadron": {
      id: "bb-squadron",
      name: "BB Squadron",
      tracker: "Linear",
      trackerLine: [{ strong: "Sizemore · BB Squadron" }, " in Linear", " · read 12 s ago"],
      moments: {
        published: {
          label: "00:42 · SIZE-947 published",
          note: "SIZE-947 has its ready label but no tickets yet; SIZE-904 and SIZE-931 are still open.",
          needsYou: [],
          openIssues: [
            { id: "SIZE-904", title: "Doctor and settings: check gh for the repo's host, require Matt's setup docs, match route labels without case", labels: ["needs-triage"], age: "13 Nov, 15:50", url: "https://linear.app/sizemore/issue/SIZE-904" },
            { id: "SIZE-931", title: "Board: show Ready-row blockers, surface bad signals, show Doctor status, drop the re-parent path", labels: ["needs-triage"], age: "13 Nov, 18:38", url: "https://linear.app/sizemore/issue/SIZE-931" },
          ],
          shaping: [
            { ...SPEC_947, missing: "Ready label, but no tickets yet", action: "Plan tickets" },
          ],
          ready: [],
          flying: [],
          landed,
          counts: { ready: 0, flying: 0 },
        },
        ready: {
          label: "00:45 · SIZE-947 Ready",
          note: "Twelve tickets published under SIZE-947; SIZE-948 and SIZE-949 can start.",
          needsYou: [],
          openIssues: [],
          shaping: [],
          ready: [
            { ...SPEC_947, tickets: connectTickets({}), routes: ROUTES },
          ],
          flying: [],
          landed,
          counts: { ready: 1, flying: 0 },
        },
        flying: {
          label: "Now · SIZE-947 flying",
          note: "The Connect Lead started by hand, so the board shows it as an outside lane.",
          needsYou: [
            // The Lead asks the owner to approve this comp in its thread (lead brief, step 3).
            { kind: "Question", specId: "SIZE-947", text: "Lead · Connect asks you to approve the comp on SIZE-948.", action: "Answer in thread", thread: "thr_3r2xjejz9k" },
          ],
          openIssues: [],
          shaping: [],
          ready: [],
          flying: [
            {
              specId: "SIZE-947",
              title: SPEC_947.title,
              url: SPEC_947.url,
              outside: true,
              lead: "codex-lead",
              leadThread: "thr_3r2xjejz9k",
              minutes: "7 m",
              branch: "connect",
              pr: null,
              landing: "Lands by PR into main",
              tickets: connectTickets({
                "SIZE-948": { state: "working", minutes: "5 m", thread: "thr_z6izzrgzw5" },
                "SIZE-949": { state: "working", minutes: "5 m", thread: "thr_hfhuvu63rq" },
              }),
            },
          ],
          landed,
          counts: { ready: 0, flying: 1 },
        },
      },
      defaultMoment: "flying",
      doctor: doctorLinear,
    },
    "bb-bot": {
      id: "bb-bot",
      name: "bb-bot",
      tracker: "Local markdown",
      trackerLine: [{ strong: ".scratch/" }, " on main", " · Flying lanes read from their integration branch", " · read 4 s ago"],
      moments: {
        now: {
          label: "Now",
          needsYou: [],
          openIssues: [],
          shaping: [],
          ready: [],
          flying: [
            {
              specId: "BB-BOT",
              title: "bb Bot",
              path: ".scratch/bb-bot/spec.md",
              outside: true,
              lead: "claude-lead",
              leadThread: "thr_6irpp3hp8d",
              minutes: "1 h 23 m",
              branch: "integration/bb-bot",
              pr: null,
              landing: "No remote · lands when integration/bb-bot merges into main",
              tickets: bbBotTickets,
            },
          ],
          landed: [],
          counts: { ready: 0, flying: 1 },
        },
      },
      defaultMoment: "now",
      doctor: {
        summary: "fix",
        label: "1 to fix before Start",
        tracker: { kind: "Local markdown", why: "issue-tracker.md says issues live in .scratch/" },
        checks: [
          { name: "Tracker", status: "pass", text: "Local markdown, because docs/agents/issue-tracker.md says issues live in .scratch/." },
          { name: "Matt's setup files", status: "pass", text: "issue-tracker.md, triage-labels.md and domain.md are in docs/agents/." },
          { name: "Project settings", status: "fix", text: "docs/agents/squadron.md is missing. The board still shows everything; only Start needs it." },
          { name: "Linear key", status: "skip", text: "Not needed: this repo's tracker is local markdown." },
          { name: "GitHub login", status: "skip", text: "Not needed: this repo has no git remote." },
        ],
      },
    },
    "bb-bot-home": {
      id: "bb-bot-home",
      name: "bb Bot",
      tracker: "None",
      trackerLine: [{ strong: "No tracker found" }, ": docs/agents/issue-tracker.md is missing"],
      moments: {
        now: {
          label: "Now",
          needsYou: [
            { kind: "Set up", specId: null, text: "This project has no tracker yet. Set up runs Matt's setup with you, then writes docs/agents/squadron.md.", action: "Set up" },
          ],
          openIssues: [],
          shaping: [],
          ready: [],
          flying: [],
          landed: [],
          counts: { ready: 0, flying: 0 },
        },
      },
      defaultMoment: "now",
      empty: true,
      doctor: {
        summary: "setup",
        label: "Needs Set up",
        tracker: { kind: "None", why: "no docs/agents/issue-tracker.md" },
        checks: [
          { name: "Tracker", status: "fix", text: "None found: docs/agents/issue-tracker.md is missing." },
          { name: "Matt's setup files", status: "fix", text: "docs/agents/ doesn't exist. Set up runs setup-matt-pocock-skills." },
          { name: "Project settings", status: "fix", text: "docs/agents/squadron.md is missing. Set up writes it from the default template with you." },
          { name: "Git", status: "fix", text: "~/dev/bb Bot isn't a git repository." },
        ],
      },
    },
  };

  // `bb project list`: every BB project. Counts for projects outside the comp aren't read.
  const picker = [
    { id: "bb-squadron", name: "BB Squadron", tracker: "Linear" },
    { id: "bb-bot", name: "bb-bot", tracker: "Local markdown" },
    { id: "bb-bot-home", name: "bb Bot", tracker: "None" },
    { id: "wordwell", name: "WordWell", tracker: "Linear", outside: true },
    { id: "squadron", name: "squadron", tracker: "Not read", outside: true },
  ];

  return { projects, picker, routes: ROUTES, landing939, snapshot: "14 Nov 2026, 00:58 CST" };
})();
