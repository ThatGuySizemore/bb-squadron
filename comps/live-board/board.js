// SIZE-948 comp: draws the redesigned board from COMP_DATA, in a full-page
// and a side-panel layout. Buttons that would start or steer work only say
// what they would do; nothing here writes anywhere.
(() => {
  const D = window.COMP_DATA;
  const X = window.Dither;

  // ---------- 5x7 pixel cell font (lib/pixels.ts) ----------
  const G = {
    A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
    E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
    I: ["###", " # ", " # ", " # ", " # ", " # ", "###"],
    O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
    T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
    Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
    "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
    "1": [" # ", "## ", " # ", " # ", " # ", " # ", "###"],
    "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
    "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
    "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
    "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
    "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
    "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
    "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
    "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
    "-": ["   ", "   ", "   ", "###", "   ", "   ", "   "],
    " ": ["  ", "  ", "  ", "  ", "  ", "  ", "  "],
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function pixelText(text, cell = 2, gap = cell >= 3 ? 1 : 0, cls = "") {
    const cells = [];
    let x = 0;
    for (const ch of text.toUpperCase()) {
      const g = G[ch] || G[" "];
      g.forEach((row, y) => [...row].forEach((c, i) => c === "#" && cells.push([x + i, y])));
      x += g[0].length + 1;
    }
    const pitch = cell + gap, w = (x - 1) * pitch - gap, h = 7 * pitch - gap;
    const rects = cells.map(([cx, cy]) => `<rect x="${cx * pitch}" y="${cy * pitch}" width="${cell}" height="${cell}"/>`).join("");
    return `<span class="sq-pixel ${cls}"><svg aria-hidden="true" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg><span class="sr">${esc(text)}</span></span>`;
  }
  const chev = (cls = "sq-chev") =>
    `<svg class="${cls}" aria-hidden="true" viewBox="0 0 6 10" shape-rendering="crispEdges"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/><rect x="4" y="4" width="2" height="2"/><rect x="2" y="6" width="2" height="2"/><rect x="0" y="8" width="2" height="2"/></svg>`;
  const caret = `<svg class="sq-caret" aria-hidden="true" viewBox="0 0 10 6" shape-rendering="crispEdges"><rect x="0" y="0" width="2" height="2"/><rect x="2" y="2" width="2" height="2"/><rect x="4" y="4" width="2" height="2"/><rect x="6" y="2" width="2" height="2"/><rect x="8" y="0" width="2" height="2"/></svg>`;
  // Stand-in for BB's ProviderIcon, which the plugin renders for real.
  const family = `<svg class="sq-family" aria-hidden="true" viewBox="0 0 6 6" shape-rendering="crispEdges"><rect x="1" y="1" width="4" height="4"/></svg>`;

  function chip(routeKey, prefix) {
    const r = D.routes[routeKey];
    const text = r.text || `${r.model} ${r.effort}`;
    const title = r.text ? r.family : `${r.family} · ${r.model} · ${r.effort} effort`;
    return `<span class="sq-chip" title="${esc(title)}">${family}<span>${prefix ? `${esc(prefix)} · ` : ""}${esc(text)}</span></span>`;
  }

  const TICKET_LABEL = { waiting: "Waiting", working: "Working", branch: "In branch", done: "Done" };

  function columns(tickets) {
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const depth = new Map();
    const col = (t) => {
      if (depth.has(t.id)) return depth.get(t.id);
      const inLane = t.blockedBy.map((b) => byId.get(b)).filter(Boolean);
      const d = inLane.length ? 1 + Math.max(...inLane.map(col)) : 0;
      depth.set(t.id, d);
      return d;
    };
    const cols = [];
    for (const t of tickets) (cols[col(t)] ||= []).push(t);
    return cols;
  }

  // ---------- comp state ----------
  const params = new URLSearchParams(location.search);
  const state = {
    project: D.projects[params.get("project")] ? params.get("project") : "bb-squadron",
    moments: { "bb-squadron": params.get("moment") || "flying", "bb-bot": "now", "bb-bot-home": "now" },
    layout: ["wide", "panel", "both"].includes(params.get("layout")) ? params.get("layout") : (innerWidth >= 1500 ? "both" : "wide"),
    theme: params.get("theme") === "light" ? "light" : "dark",
    motion: params.get("motion") === "reduced" ? "reduced" : "live",
    doctorOpen: false,
    landing: false,
    leaving: false,
    fresh: null,
  };

  const project = () => D.projects[state.project];
  const momentOf = (id) => D.projects[id].moments[state.moments[id]] || Object.values(D.projects[id].moments)[0];
  const moment = () => momentOf(state.project);
  const fleet = () => Object.keys(D.projects).reduce((n, id) => n + momentOf(id).flying.length, 0);

  // ---------- board pieces ----------
  function header(layout) {
    const p = project(), m = moment();
    const doc = p.doctor;
    const flyingAll = fleet();
    return `
      <header class="sq-head">
        <div class="sq-brand">
          <canvas class="sq-formation" data-fx="formation" data-flying="${flyingAll}" role="img" aria-label="${flyingAll} ${flyingAll === 1 ? "lane" : "lanes"} flying across your projects"></canvas>
          <h1>Squadron</h1>
        </div>
        <div class="sq-picker">
          <button type="button" class="sq-picker-btn" aria-haspopup="listbox" aria-expanded="false" data-act="picker">
            <span class="sq-picker-name">${esc(p.name)}</span>
            <span class="sq-picker-meta">${esc(p.tracker === "None" ? "No tracker" : p.tracker)} · <span class="num">${m.counts.ready}</span> ready · <span class="num">${m.counts.flying}</span> flying</span>
            ${caret}
          </button>
          <ul class="sq-picker-list" role="listbox" aria-label="BB projects" tabindex="-1" hidden>
            ${D.picker.map((it) => {
              const known = D.projects[it.id];
              const c = known ? momentOf(it.id).counts : null;
              return `<li role="option" data-project="${it.id}" aria-selected="${it.id === state.project}" ${known ? "" : 'aria-disabled="true"'}>
                <i class="sq-pick-mark"></i>
                <span class="sq-pick-name">${esc(it.name)}</span>
                <span class="sq-pick-kind">${esc(it.tracker === "None" ? "No tracker · Set up" : it.tracker)}</span>
                <span class="sq-pick-counts">${c
                  ? `<span><b class="num">${c.ready}</b> ready</span><span><b class="num" ${c.flying ? 'data-on="sky"' : ""}>${c.flying}</b> flying</span>`
                  : `<span>not read in this comp</span>`}</span>
              </li>`;
            }).join("")}
          </ul>
        </div>
        <div class="sq-head-actions">
          <button type="button" class="sq-doctor" data-summary="${doc.summary}" data-act="doctor" aria-expanded="${state.doctorOpen}" aria-controls="doctor-${layout}" title="Doctor: ${esc(doc.label)}">
            <i class="sq-square" aria-hidden="true"></i><span>Doctor</span><span class="sq-doctor-word">${esc(doc.label)}</span>
          </button>
          <button type="button" class="sq-btn" data-tone="primary" data-act="say" data-say="New spec would start a planning thread from nothing: grill-with-docs, then to-spec and to-tickets, published to ${esc(p.tracker === "None" ? "the tracker Set up creates" : p.tracker)}.">New spec</button>
        </div>
      </header>
      <p class="sq-trackerline"><span class="sq-kind">${esc(p.tracker === "None" ? "No tracker" : p.tracker)}</span>${p.trackerLine.map((part) => typeof part === "string" ? esc(part) : `<strong>${esc(part.strong)}</strong>`).join("")}</p>`;
  }

  function pathStrip(layout) {
    const m = moment();
    const flyingCount = m.flying.length;
    const stations = [
      ["open", "Open issues", m.openIssues.length],
      ["shaping", "Shaping", m.shaping.length],
      ["ready", "Ready", m.ready.length],
      ["flying", "Flying", flyingCount],
      ["landed", "Landed", m.landed.length],
    ];
    const short = { "Open issues": "Open" };
    return `<nav class="sq-path" aria-label="The path">
      ${stations.map(([key, label, n]) => `<a class="sq-station" href="#${key}-${layout}" data-jump="${key}-${layout}" data-zero="${n === 0}" data-hot="${key === "flying" && n > 0}">
        <span class="sq-station-label">${esc(layout === "narrow" ? short[label] || label : label)}</span>
        <span class="sq-station-count">${n}</span>
        ${chev("sq-station-chev")}
      </a>`).join("")}
    </nav>`;
  }

  function needsYou(layout) {
    const m = moment();
    const items = m.needsYou;
    return `<section class="sq-section" aria-labelledby="needs-${layout}-h">
      <h2 class="sq-label" id="needs-${layout}-h">Needs you ${items.length ? `<span class="sq-count-amber num">${items.length}</span>` : ""}</h2>
      ${items.length ? `<div class="sq-needs">${items.map((it) => `
        <div class="sq-need">
          <canvas data-fx="need" aria-hidden="true"></canvas>
          <span class="sq-need-kind">${esc(it.kind)}</span>
          <span class="sq-need-num">${it.specId ? pixelText(it.specId, 2) : ""}</span>
          <span class="sq-need-text">${esc(it.text)}</span>
          <button type="button" class="sq-btn" data-tone="${it.kind === "Set up" ? "primary" : "amber"}" data-act="say" data-say="${esc(it.kind === "Set up"
            ? "Set up would start a thread that runs setup-matt-pocock-skills here, then writes docs/agents/squadron.md from the default template with you."
            : `Answer in thread would open ${it.thread} ${layout === "narrow" ? "in the main view" : "beside the board"}.`)}">${esc(it.action)}</button>
        </div>`).join("")}</div>` : `<p class="sq-empty"><span>Nothing waits on you.</span></p>`}
      ${doctorPanel(layout)}
    </section>`;
  }

  function doctorPanel(layout) {
    const d = project().doctor;
    const word = { pass: "Pass", fix: "Fix", skip: "Not needed" };
    return `<div class="sq-doctor-panel" id="doctor-${layout}" ${state.doctorOpen ? "" : "hidden"}>
      <h3>Doctor · ${esc(d.label)}</h3>
      ${d.checks.map((c) => `<div class="sq-check"><span class="sq-check-name">${esc(c.name)}</span><span class="sq-tag" data-status="${c.status}">${word[c.status]}</span><span class="sq-check-text">${esc(c.text)}</span></div>`).join("")}
    </div>`;
  }

  function peg(t, lane, layout) {
    const fx = t.state === "working" || t.state === "branch" || t.state === "done";
    const waitsOn = t.blockedBy.filter((b) => {
      const blocker = lane.tickets.find((x) => x.id === b);
      return !blocker || (blocker.state !== "branch" && blocker.state !== "done");
    });
    const label = `${t.id}, ${t.title}: ${t.state === "waiting" && waitsOn.length ? `waits on ${waitsOn.join(", ")}` : TICKET_LABEL[t.state]}`;
    const tag = t.thread ? "button" : "div";
    const attrs = t.thread
      ? `type="button" data-act="say" data-say="${esc(`Opens Worker ${t.id} ${layout === "narrow" ? "in the main view" : "beside the board"}.`)}" aria-label="${esc(label)}. Open thread."`
      : `aria-label="${esc(label)}"`;
    const canvas = fx ? `<canvas data-fx="peg" data-state="${t.state}" aria-hidden="true"></canvas>` : "";
    if (t.state === "branch" || t.state === "done") {
      return `<${tag} class="sq-peg" data-state="${t.state}" title="${esc(t.title)}" ${attrs}>${canvas}<span class="sq-peg-id">${esc(t.id)}</span><span class="sq-peg-state">${TICKET_LABEL[t.state]}</span></${tag}>`;
    }
    const after = t.state === "waiting" && waitsOn.length ? `<span class="sq-peg-after" title="${esc(`Waiting after ${waitsOn.join(", ")}`)}">after ${esc(waitsOn.join(", "))}</span>` : `<span class="sq-peg-state">${TICKET_LABEL[t.state]}</span>`;
    return `<${tag} class="sq-peg" data-state="${t.state}" ${attrs}>${canvas}
      <span class="sq-peg-top"><span class="sq-peg-id">${esc(t.id)}</span>${after}</span>
      <span class="sq-peg-title">${esc(t.title)}</span>
      ${t.state === "working" ? `<span class="sq-peg-foot">${chip(t.route)}<span class="sq-time num">${esc(t.minutes || "")}</span></span>` : ""}
    </${tag}>`;
  }

  function sortieLine(lane, layout, landing = false) {
    const done = lane.tickets.filter((t) => t.state === "branch" || t.state === "done").length;
    const working = lane.tickets.filter((t) => t.state === "working").length;
    const progress = `<div class="sq-progress" role="img" aria-label="${done} of ${lane.tickets.length} tickets in the branch, ${working} working">
      ${lane.tickets.map((t) => `<i data-state="${t.state}" title="${esc(`${t.id}: ${TICKET_LABEL[t.state]}`)}"></i>`).join("")}
      <span class="sq-progress-count num">${done}/${lane.tickets.length} in branch</span>
      ${working ? `<span class="sq-pace"><i aria-hidden="true"></i>${working} working</span>` : ""}
    </div>`;
    const tail = `<div class="sq-tail">
      ${pixelText(lane.specId, layout === "narrow" ? 3 : 4, 1, "sq-tail-number")}
      <h3 class="sq-line-title"><button type="button" class="sq-link" data-act="say" data-say="${esc(lane.url ? `Opens ${lane.specId} in Linear.` : `Opens ${lane.path}.`)}">${esc(lane.title)}</button></h3>
      <button type="button" class="sq-lead" data-act="say" data-say="${esc(`Opens the Lead thread ${lane.leadThread || ""} ${layout === "narrow" ? "in the main view" : "beside the board"}.`)}">${chip(lane.lead, "Lead")}</button>
      <div class="sq-tail-status"><i class="sq-state-square" aria-hidden="true"></i><span>${landing ? "Landed" : "Flying"}</span><span class="sq-time num">${esc(lane.minutes)}</span></div>
      ${lane.pr ? `<span class="sq-landing-note">${esc(lane.pr)}</span>` : ""}
      ${lane.outside ? `<span class="sq-outside">Started outside Squadron</span>` : ""}
      <span class="sq-branch">${esc(lane.branch)}</span>
      ${lane.landing ? `<span class="sq-landing-note">${esc(lane.landing)}</span>` : ""}
      ${lane.outside ? `<span class="sq-readonly">Read-only: Squadron didn't start this lane, so it has no Stop, Resume or Merge.</span>` : ""}
    </div>`;
    const burst = landing && !X.reduced ? `<canvas class="sq-burst" data-fx="burst" aria-hidden="true"></canvas>` : "";
    const air = (cls) => landing ? burst : `<canvas ${cls} data-fx="air" data-pace="${working}" aria-hidden="true"></canvas>`;

    if (layout === "narrow") {
      const active = lane.tickets.filter((t) => t.state === "working");
      return `<article class="sq-line" data-state="${landing ? "landing" : "flying"}" aria-label="${esc(`${lane.specId}, ${lane.title}: ${landing ? "Landed" : "Flying"}`)}">
        ${tail}
        ${progress}
        <div class="sq-air-band" aria-hidden="true">${air("")}</div>
        ${active.length ? `<div class="sq-active">${active.map((t) => peg(t, lane, layout)).join("")}</div>` : ""}
        <details class="sq-all"><summary>All ${lane.tickets.length} tickets</summary><ol>
          ${lane.tickets.map((t) => `<li data-state="${t.state}"><span class="sq-id">${esc(t.id)}</span><span>${esc(t.title)}</span><span data-st="${t.state}">${TICKET_LABEL[t.state]}</span></li>`).join("")}
        </ol></details>
      </article>`;
    }
    const cols = columns(lane.tickets);
    return `<article class="sq-line" data-state="${landing ? "landing" : "flying"}" aria-label="${esc(`${lane.specId}, ${lane.title}: ${landing ? "Landed" : "Flying"}`)}">
      ${tail}
      <div class="sq-track">
        ${progress}
        <div class="sq-rail">
          <div class="sq-columns">
            ${air('class="sq-air"')}
            ${cols.map((col, i) => `<div class="sq-column">${i ? chev() : ""}<div class="sq-column-stack">${col.map((t) => peg(t, lane, layout)).join("")}</div></div>`).join("")}
          </div>
        </div>
      </div>
    </article>`;
  }

  function empty(text, button) {
    return `<div class="sq-empty"><p>${text}</p>${button || ""}</div>`;
  }
  const say = (label, text, tone = "plain") => `<button type="button" class="sq-btn" data-tone="${tone}" data-act="say" data-say="${esc(text)}">${esc(label)}</button>`;
  const newSpec = () => say("New spec", "New spec would start a planning thread from nothing.", "plain");

  function section(key, layout, title, count, body, cls = "") {
    return `<section class="sq-section ${cls}" id="${key}-${layout}" aria-labelledby="${key}-${layout}-h">
      <h2 class="sq-label" id="${key}-${layout}-h">${esc(title)} <span class="sq-count num">${count || ""}</span></h2>
      ${body}
    </section>`;
  }

  function flying(layout) {
    const m = moment();
    const lanes = m.flying;
    const noTracker = project().tracker === "None";
    let body = "";
    if (state.landing && state.project === "bb-squadron") {
      body += `<div class="sq-line-wrap" data-leaving="${state.leaving}"><div>${sortieLine(D.landing939, layout, true)}</div></div>`;
    }
    body += lanes.map((l) => sortieLine(l, layout)).join("");
    if (!body) {
      body = empty(
        noTracker ? "Nothing is flying. Lanes fly here once this project has a tracker and a Ready spec to Start." : "Nothing is flying. A lane flies here when you Start a Ready spec.",
        m.ready[0] ? say(`Start ${m.ready[0].id}`, `Start would open a Lead for ${m.ready[0].id}.`, "primary") : "",
      );
    }
    return section("flying", layout, "Flying", lanes.length || "", body);
  }

  function ready(layout) {
    const m = moment();
    const doctorOk = project().doctor.summary === "pass";
    const body = m.ready.length ? `<ul class="sq-list">${m.ready.map((r) => {
      const open = r.tickets;
      const frontier = open.filter((t) => t.blockedBy.length === 0);
      const waiting = open.filter((t) => t.blockedBy.length > 0);
      const claude = open.filter((t) => t.route === "claude").length;
      return `<li class="sq-row">
        <span class="sq-plate">${pixelText(r.id, 2)}</span>
        <div class="sq-row-main">
          <button type="button" class="sq-link sq-row-title" data-act="say" data-say="Opens ${esc(r.id)} in Linear.">${esc(r.title)}</button>
          <div class="sq-row-meta"><span><b class="num">${open.length}</b> tickets</span><span>${claude} Claude · ${open.length - claude} Codex</span></div>
          <ul class="sq-waits">
            <li class="sq-frontier">Can start: ${frontier.map((t) => `<code>${esc(t.id)}</code>`).join(", ")}</li>
            <li><details><summary>${waiting.length} wait on blockers</summary>
              ${waiting.map((t) => `<div><code>${esc(t.id)}</code> after ${t.blockedBy.map((b) => `<code>${esc(b)}</code>`).join(", ")}</div>`).join("")}
            </details></li>
          </ul>
        </div>
        <div class="sq-row-actions">
          ${doctorOk ? say("Start", `Start would open a Lead for ${r.id} on its own integration branch.`, "primary") : `<span class="sq-why">Doctor: ${esc(project().doctor.label)}</span><button class="sq-btn" data-tone="primary" disabled>Start</button>`}
        </div>
      </li>`;
    }).join("")}</ul>` : empty("No spec is Ready. A spec is Ready when it carries <code>ready-for-agent</code> and has at least one open, unblocked ticket.");
    return section("ready", layout, "Ready", m.ready.length || "", body);
  }

  function shaping(layout) {
    const m = moment();
    const body = m.shaping.length ? `<ul class="sq-list">${m.shaping.map((s) => `<li class="sq-row">
        <span class="sq-plate">${pixelText(s.id, 2)}</span>
        <div class="sq-row-main">
          <button type="button" class="sq-link sq-row-title" data-act="say" data-say="Opens ${esc(s.id)} in Linear.">${esc(s.title)}</button>
          <div class="sq-row-meta"><span class="sq-missing">${esc(s.missing)}</span></div>
        </div>
        <div class="sq-row-actions">${say(s.action, `${s.action} would start a planning thread that runs to-tickets on ${s.id}.`, "primary")}</div>
      </li>`).join("")}</ul>` : empty("Nothing is being shaped. A spec shows here while its planning thread is open, or until it has both tickets and its ready label.", newSpec());
    return section("shaping", layout, "Shaping", m.shaping.length || "", body);
  }

  function openIssues(layout) {
    const m = moment();
    const noTracker = project().tracker === "None";
    const body = m.openIssues.length ? `<ul class="sq-list">${m.openIssues.map((o) => `<li class="sq-row">
        <span class="sq-id">${esc(o.id)}</span>
        <div class="sq-row-main">
          <button type="button" class="sq-link sq-row-title" data-act="say" data-say="Opens ${esc(o.id)} in Linear.">${esc(o.title)}</button>
          <div class="sq-row-meta">${o.labels.map((l) => `<span class="sq-tag">${esc(l)}</span>`).join("")}<span>opened ${esc(o.age)}</span></div>
        </div>
        <div class="sq-row-actions">${say("Plan", `Plan would start a planning thread that turns ${o.id} into a spec.`)}</div>
      </li>`).join("")}</ul>`
      : noTracker
        ? empty("Open issues show here once Squadron finds this project's tracker.", say("Set up", "Set up would start a thread that runs setup-matt-pocock-skills, then writes squadron.md with you.", "primary"))
        : empty(`No open issues. Anything in ${esc(project().tracker === "Linear" ? "the Linear project" : ".scratch/")} that isn't a spec or a ticket shows here, with Plan.`, newSpec());
    return section("open", layout, "Open issues", m.openIssues.length || "", body, "sq-open");
  }

  function landed(layout) {
    const m = moment();
    const rows = m.landed.filter((l) => !(state.landing && l.id === "SIZE-939"));
    const body = rows.length ? `<ul class="sq-list">${rows.map((l) => `<li class="sq-row" ${state.fresh === l.id ? 'data-fresh="true"' : ""}>
        <span class="sq-plate"><canvas data-fx="plate" aria-hidden="true"></canvas>${pixelText(l.id, 2)}</span>
        <div class="sq-row-main">
          <button type="button" class="sq-link sq-row-title" data-act="say" data-say="Opens ${esc(l.id)} in Linear.">${esc(l.title)}</button>
          <div class="sq-row-meta"><span>${esc(l.proof)}</span><span>landed ${esc(l.landedAt)}</span><span>flew ${esc(l.lane)}</span></div>
        </div>
        <span></span>
      </li>`).join("")}</ul>`
      : empty("Nothing has landed yet. A lane lands when its PR merges or, in a repo with no remote, when its integration branch merges into main.");
    return section("landed", layout, "Landed", rows.length || "", body, "sq-landed");
  }

  function board(layout) {
    return `<div class="sq" data-layout="${layout}" data-board="${layout}">
      ${header(layout)}
      ${pathStrip(layout)}
      ${needsYou(layout)}
      ${flying(layout)}
      ${ready(layout)}
      ${shaping(layout)}
      ${openIssues(layout)}
      ${landed(layout)}
    </div>`;
  }

  // ---------- comp chrome ----------
  function seg(name, options, current) {
    return `<div class="seg" role="group" aria-label="${esc(name)}">${options.map(([v, label]) => `<button type="button" data-set="${name}" data-value="${v}" aria-pressed="${v === current}">${esc(label)}</button>`).join("")}</div>`;
  }

  function chrome() {
    const sq = D.projects["bb-squadron"];
    return `
      <div class="comp-title"><strong>SIZE-948 comp · the live dithered board</strong><span>Proposed for Josh's approval · data read ${esc(D.snapshot)}</span></div>
      <div class="comp-group"><span>Project</span>${seg("project", Object.values(D.projects).map((p) => [p.id, p.name]), state.project)}</div>
      ${state.project === "bb-squadron" ? `<div class="comp-group"><span>Moment</span>${seg("moment", Object.entries(sq.moments).map(([k, m]) => [k, m.label]), state.moments["bb-squadron"])}</div>` : ""}
      <div class="comp-group"><span>Layout</span>${seg("layout", [["wide", "Full page"], ["panel", "Side panel"], ["both", "Both"]], state.layout)}</div>
      <div class="comp-group"><span>Theme</span>${seg("theme", [["dark", "Dark"], ["light", "Light"]], state.theme)}</div>
      <div class="comp-group"><span>Motion</span>${seg("motion", [["live", "Live"], ["reduced", "Reduced"]], state.motion)}</div>
      <button type="button" class="sq-btn" data-act="land" ${state.landing ? "disabled" : ""}>Replay SIZE-939's landing</button>
      <p class="comp-note">${moment().note ? `<b>${esc(moment().label)}:</b> ${esc(moment().note)} ` : ""}Buttons say what they would do; nothing here writes anywhere. The bar is the comp's, not the board's.</p>`;
  }

  // ---------- mounting ----------
  const root = document.getElementById("comp");
  const bar = document.getElementById("comp-bar");
  const stage = document.getElementById("stage");

  function mountFx(scope) {
    X.release(scope);
    for (const c of scope.querySelectorAll("canvas[data-fx]")) {
      const fx = c.dataset.fx;
      if (fx === "formation") {
        const n = Number(c.dataset.flying);
        X.surface(c, X.painters.formation({ flying: n, el: c }), { animated: n > 0, stillAt: 0.8 });
      } else if (fx === "air") {
        const pace = Number(c.dataset.pace);
        X.surface(c, X.painters.airstream({ pace }), { animated: pace > 0, stillAt: 2.4 });
      } else if (fx === "need") {
        X.surface(c, X.painters.needsYou(), { animated: true, stillAt: 0.9 });
      } else if (fx === "plate") {
        X.surface(c, X.painters.plate({ colour: "green", level: 0.2 }));
      } else if (fx === "peg") {
        const st = c.dataset.state;
        if (st === "working") X.surface(c, X.painters.pegFill({ colour: "sky", base: 0.07, amp: 0.3, speed: 9, edge: "sky" }), { animated: true, stillAt: 1.2 });
        else X.surface(c, X.painters.pegFill({ colour: "green", base: st === "done" ? 0.24 : 0.17 }));
      } else if (fx === "burst") {
        X.surface(c, X.painters.burst({}), { animated: true, until: 1.6 });
      }
    }
  }

  function render() {
    document.documentElement.className = `theme-${state.theme}${state.motion === "reduced" ? " motion-reduced" : ""}`;
    X.setReduced(state.motion === "reduced" ? true : null);
    bar.innerHTML = chrome();
    const wide = state.layout !== "panel" ? `<div class="frame frame-wide">${board("wide")}</div>` : "";
    const panel = state.layout !== "wide" ? `<aside class="frame frame-panel" aria-label="Thread side panel">
        <div class="panel-tabs"><span class="tab" aria-current="page">Squadron</span><span class="thread">Worker SIZE-948 · side panel</span></div>
        ${board("narrow")}
      </aside>` : "";
    stage.dataset.layout = state.layout;
    stage.innerHTML = wide + panel;
    mountFx(root);
    for (const rail of stage.querySelectorAll(".sq-rail")) {
      const check = () => (rail.dataset.overflow = String(rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 4));
      check();
      rail.addEventListener("scroll", check, { passive: true });
      new ResizeObserver(check).observe(rail);
    }
    const q = new URLSearchParams({ project: state.project, layout: state.layout, theme: state.theme, motion: state.motion, ...(state.project === "bb-squadron" ? { moment: state.moments["bb-squadron"] } : {}) });
    history.replaceState(null, "", `?${q}`);
  }

  // ---------- toast ----------
  const toast = document.getElementById("toast");
  let toastTimer = 0;
  function sayToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 3600);
  }

  // ---------- landing replay ----------
  function land() {
    state.project = "bb-squadron";
    state.landing = true;
    state.leaving = false;
    state.fresh = null;
    render();
    stage.querySelector(".sq-line[data-state='landing']")?.scrollIntoView({ block: "center", behavior: X.reduced ? "auto" : "smooth" });
    const hold = X.reduced ? 1400 : 2200;
    setTimeout(() => {
      for (const w of stage.querySelectorAll(".sq-line-wrap")) w.dataset.leaving = "true";
      setTimeout(() => {
        state.landing = false;
        state.fresh = "SIZE-939";
        render();
        setTimeout(() => (state.fresh = null), 900);
      }, X.reduced ? 0 : 440);
    }, hold);
  }

  // ---------- events ----------
  function closePickers(except) {
    for (const list of document.querySelectorAll(".sq-picker-list")) {
      if (list === except) continue;
      list.hidden = true;
      list.previousElementSibling.setAttribute("aria-expanded", "false");
    }
  }
  function openPicker(btn) {
    const list = btn.nextElementSibling;
    closePickers(list);
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      const opts = [...list.querySelectorAll("li")];
      opts.forEach((o) => o.classList.toggle("active", o.getAttribute("aria-selected") === "true"));
      list.focus();
    }
  }
  function choose(id) {
    if (!D.projects[id]) return;
    state.project = id;
    state.doctorOpen = false;
    render();
    stage.querySelector(".sq-picker-btn")?.focus();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-set], [data-act], [data-jump], li[data-project]");
    if (!t) { if (!e.target.closest(".sq-picker")) closePickers(); return; }
    if (t.dataset.set) {
      const { set, value } = t.dataset;
      if (set === "moment") state.moments["bb-squadron"] = value;
      else state[set] = value;
      if (set === "project") state.doctorOpen = false;
      render();
    } else if (t.dataset.jump) {
      e.preventDefault();
      document.getElementById(t.dataset.jump)?.scrollIntoView({ behavior: X.reduced ? "auto" : "smooth", block: "start" });
    } else if (t.matches("li[data-project]")) {
      if (t.getAttribute("aria-disabled") === "true") sayToast(`${t.querySelector(".sq-pick-name").textContent} isn't part of this comp.`);
      else choose(t.dataset.project);
    } else if (t.dataset.act === "picker") {
      openPicker(t);
    } else if (t.dataset.act === "doctor") {
      state.doctorOpen = !state.doctorOpen;
      for (const p of document.querySelectorAll(".sq-doctor-panel")) p.hidden = !state.doctorOpen;
      for (const b of document.querySelectorAll(".sq-doctor")) b.setAttribute("aria-expanded", String(state.doctorOpen));
    } else if (t.dataset.act === "say") {
      sayToast(t.dataset.say);
    } else if (t.dataset.act === "land") {
      land();
    }
  });

  document.addEventListener("keydown", (e) => {
    const list = e.target.closest?.(".sq-picker-list");
    if (!list) return;
    const opts = [...list.querySelectorAll("li")];
    let i = opts.findIndex((o) => o.classList.contains("active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      i = (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, k) => o.classList.toggle("active", k === i));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      opts[i]?.click();
    } else if (e.key === "Escape") {
      closePickers();
      list.previousElementSibling.focus();
    }
  });

  render();
  window.__comp = { state, render, land };
})();
