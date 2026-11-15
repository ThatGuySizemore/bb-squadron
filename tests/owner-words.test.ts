import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OWNER_WORDS } from "../lib/owner-words.js";

function glossaryOwnerWords(): Record<string, string> {
  const glossary = readFileSync("GLOSSARY.md", "utf8");
  const section = /^## Owner words\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(glossary)?.[1];
  assert.ok(section, "GLOSSARY.md has an Owner words section");
  const entries = [...section.matchAll(/^\*\*([^*]+)\*\*: (.+)$/gm)];
  assert.equal(new Set(entries.map((entry) => entry[1])).size, entries.length, "owner words are unique");
  return Object.fromEntries(entries.map((entry) => [entry[1], entry[2]]));
}

test("the glossary gives every agreed owner word a one-line definition", () => {
  assert.deepEqual(Object.keys(glossaryOwnerWords()).sort(), [
    "Board", "Spec", "Ticket", "Work item", "Ready", "Shaping", "Lane", "Flying", "Landed",
    "Held", "Needs you", "Helper", "House rules", "Scope", "Autopilot",
  ].sort());
});

test("board hover definitions match the glossary's owner words exactly", () => {
  assert.deepEqual(OWNER_WORDS, glossaryOwnerWords());
});
