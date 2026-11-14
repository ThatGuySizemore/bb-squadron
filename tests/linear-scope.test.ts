import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeIssueFilter, scopeLookup, resolveScope } from "../lib/linear-scope.js";

const uuid = "0f4b2a52-1d8e-4c55-9e1f-2a6a3c4d5e6f";

test("scope values look Linear up by name, key, URL or id", () => {
  const lookup = scopeLookup({
    team: "Sizemore", project: "https://linear.app/fixture/project/bb-squadron-0123456789ab/overview",
    initiative: uuid, label: "area/reader", view: "https://linear.app/fixture/view/agent-work-ba9876543210",
  });
  assert.deepEqual(lookup, {
    withTeam: true, team: { or: [{ key: { eqIgnoreCase: "Sizemore" } }, { name: { eqIgnoreCase: "Sizemore" } }] },
    withProject: true, project: { slugId: { eq: "0123456789ab" } },
    withInitiative: true, initiative: { id: { eq: uuid } },
    withLabel: true, label: { and: [
      { or: [{ name: { eqIgnoreCase: "area/reader" } }, { name: { eqIgnoreCase: "reader" }, parent: { name: { eqIgnoreCase: "area" } } }] },
      // A named team narrows its labels to that team's and the workspace's.
      { or: [{ team: { or: [{ key: { eqIgnoreCase: "Sizemore" } }, { name: { eqIgnoreCase: "Sizemore" } }] } }, { team: { null: true } }] },
    ] },
    withView: true, view: { slugId: { eq: "ba9876543210" } },
  });
  assert.deepEqual(scopeLookup({ team: "https://linear.app/fixture/team/SIZE/active" }).team, { key: { eqIgnoreCase: "SIZE" } });
  assert.deepEqual(scopeLookup({ project: "BB Squadron" }), {
    withTeam: false, team: null, withProject: true, project: { name: { eqIgnoreCase: "BB Squadron" } },
    withInitiative: false, initiative: null, withLabel: false, label: null, withView: false, view: null,
  });
});

test("each key must match exactly one Linear record, and the error names the key", () => {
  const one = { nodes: [{ id: "project-one", name: "BB Squadron" }] };
  assert.deepEqual(resolveScope({ project: "BB Squadron" }, { projects: one }), {
    ok: true, scope: { project: { id: "project-one", name: "BB Squadron" }, name: "BB Squadron" },
  });
  assert.deepEqual(resolveScope({ project: "Nope" }, { projects: { nodes: [] } }), {
    ok: false, message: "Scope Project \"Nope\" matches no Linear project. Fix it in docs/agents/squadron.md.",
  });
  assert.deepEqual(resolveScope({ label: "bug" }, { issueLabels: { nodes: [{ id: "a", name: "bug" }, { id: "b", name: "bug" }] } }), {
    ok: false, message: "Scope Label \"bug\" matches more than one Linear label. Add a Team, or use its id, in docs/agents/squadron.md.",
  });
  assert.deepEqual(resolveScope({ team: "SIZE", initiative: "WordWell", label: "ui", view: "Agent work" }, {
    teams: { nodes: [{ id: "team-one", name: "Sizemore", key: "SIZE" }] },
    initiatives: { nodes: [{ id: "init-one", name: "WordWell" }] },
    issueLabels: { nodes: [{ id: "label-ui", name: "ui" }] },
    customViews: { nodes: [{ id: "view-one", name: "Agent work" }] },
  }), { ok: true, scope: {
    team: { id: "team-one", name: "Sizemore" }, initiative: { id: "init-one", name: "WordWell" },
    label: { id: "label-ui", name: "ui" }, view: { id: "view-one", name: "Agent work" },
    name: "Sizemore · WordWell · ui · Agent work",
  } });
});

test("every key set narrows the issue filter", () => {
  const ref = (id: string) => ({ id, name: id });
  assert.deepEqual(scopeIssueFilter({ name: "", team: ref("t") }), { team: { id: { eq: "t" } } });
  assert.deepEqual(scopeIssueFilter({ name: "", project: ref("p") }), { project: { id: { eq: "p" } } });
  assert.deepEqual(scopeIssueFilter({ name: "", initiative: ref("i") }), { project: { initiatives: { some: { id: { eq: "i" } } } } });
  assert.deepEqual(scopeIssueFilter({ name: "", project: ref("p"), initiative: ref("i"), label: ref("l"), team: ref("t") }), {
    team: { id: { eq: "t" } }, project: { id: { eq: "p" }, initiatives: { some: { id: { eq: "i" } } } },
    labels: { some: { id: { eq: "l" } } },
  });
  // A view applies its own saved filter; the filter argument only adds the other keys.
  assert.deepEqual(scopeIssueFilter({ name: "", view: ref("v") }), {});
});
