/**
 * Owner-facing hover text. Keep each definition identical to GLOSSARY.md.
 * No server or UI dependencies: app/board code and tests can import this module.
 */
export const OWNER_WORDS = Object.freeze({
  Board: "The Squadron page where you plan work, start it and see how it is going.",
  Spec: "A plan whose tickets are its sub-issues.",
  Ticket: "One piece of a spec.",
  "Work item": "An issue that stands alone: no parent spec, no tickets of its own.",
  Ready: "A spec with a ticket that can start now, or a work item ready to start.",
  Shaping: "A spec that still needs planning or has no ticket that can start now.",
  Lane: "Work on one spec or work item, from Start to a merged pull request.",
  Flying: "A spec or work item whose lane is underway.",
  Landed: "A spec or work item whose work has merged into the main branch, with no open tickets left. A lane that merged only part of its spec stays Flying; held tickets do not count as open.",
  Held: "A ticket set aside until its hold is cleared.",
  "Needs you": "Questions, setup problems and work that needs your approval.",
  Helper: "The optional agent thread you talk to about your project and ask to act for you.",
  "House rules": "Your private rules for how work is done across all your projects.",
  Scope: "The Linear issues a project's board reads, as chosen in its settings.",
  Autopilot: "The option for starting ready lanes automatically.",
} as const);

export type OwnerWord = keyof typeof OWNER_WORDS;
