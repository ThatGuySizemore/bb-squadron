import type { MirrorCatalog } from "./linear-mirror-contract.js";

/** A suggestion only. Ambiguous catalog matches leave the owner's picker alone. */
export function suggestLinearBinding(markdown: string, catalog: MirrorCatalog): { teamId: string; projectId: string } | null {
  const text = markdown.replace(/\*\*|`/g, "");
  const prose = /\bteam\s+([^,\n]+),\s*project\s+([^\n]+?)(?:\.|\n|$)/i.exec(text);
  const teamName = prose?.[1].trim() ?? /^\s*-?\s*(?:Workspace\/)?team:\s*([^/\n.]+)/im.exec(text)?.[1].trim();
  const projectName = prose?.[2].trim() ?? /^\s*-?\s*Project:\s*(.+?)(?:\.\s*)?$/im.exec(text)?.[1].trim();
  const projectId = /^\s*-?\s*Project UUID:\s*([a-f0-9-]{36})\b/im.exec(text)?.[1];
  if (!projectName && !projectId) return null;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const teams = teamName ? catalog.teams.filter((team) => same(team.name, teamName) || same(team.key, teamName)) : catalog.teams;
  const matches = catalog.projects.filter((project) => projectId ? project.id === projectId : same(project.name, projectName!))
    .flatMap((project) => teams.filter((team) => project.teamIds.includes(team.id)).map((team) => ({ teamId: team.id, projectId: project.id })));
  return matches.length === 1 ? matches[0] : null;
}
