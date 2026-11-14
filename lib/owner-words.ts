/**
 * Owner-facing hover text. Keep each definition identical to GLOSSARY.md.
 * No server or UI dependencies: app/board code and tests can import this module.
 */
export const OWNER_WORDS = Object.freeze({
  Board: "The Squadron page where you plan work, start it and see how it is going.",
  Spec: "A plan for one feature, split into tickets.",
  Ticket: "One piece of a spec that a worker can finish in one sitting.",
  Ready: "A spec with at least one ticket that can start now.",
  Shaping: "A spec that still needs planning or has no ticket that can start now.",
  Lane: "Work on one spec, from Start to a merged pull request.",
  Flying: "A spec whose lane is underway.",
  Landed: "A spec whose work has merged into the main branch.",
  Held: "A ticket set aside until its hold is cleared.",
  "Needs you": "Questions, setup problems and work that needs your approval.",
  Helper: "The optional agent thread you talk to about your project and ask to act for you.",
  "House rules": "Your private rules for how work is done across all your projects.",
  Scope: "The Linear issues a project's board reads, as chosen in its settings.",
  Autopilot: "The option for starting ready lanes automatically.",
} as const);

export type OwnerWord = keyof typeof OWNER_WORDS;
