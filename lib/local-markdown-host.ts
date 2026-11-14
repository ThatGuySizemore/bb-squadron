import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";
import { readGit } from "./repository-host.js";

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Read Matt's local convention from the project's main checkout, without writes. */
export async function readLocalMarkdown(input: {
  checkoutPath: string; bbProjectId: string; projectName: string; branch?: string;
}, signal?: AbortSignal): Promise<TrackerSnapshot> {
  const issues: TrackerIssue[] = [];
  const blockers = new Map<string, string[]>();
  const label = (name: string) => ({ id: name, name, color: "" });
  const git = (args: string[]) => readGit(input.checkoutPath, args, signal);
  const revision = input.branch ? (await git(["rev-parse", "--verify", "--end-of-options", `${input.branch}^{commit}`])).trim() : null;
  const branchUpdatedAt = revision ? (await git(["show", "-s", "--format=%cI", revision])).trim() : null;
  async function read(path: string, feature: string, number?: string) {
    const absolute = join(input.checkoutPath, path);
    const info = revision ? null : await lstat(absolute);
    if (info && !info.isFile()) return;
    const markdown = revision ? await git(["show", `${revision}:${path}`]) : await readFile(absolute, "utf8");
    // Matt's templates and bb-bot use both plain and bold metadata.
    const metadata = (key: string) => new RegExp(`^\\s*(?:\\*\\*)?${key}:(?:\\*\\*)?\\s*(.*?)\\s*$`, "im")
      .exec(markdown.split(/^## Comments\s*$/im)[0])?.[1]?.trim() ?? "";
    const statusName = metadata("Status") || "waiting";
    const status = statusName.toLowerCase();
    const type = ["done", "resolved", "closed"].includes(status) ? "completed"
      : ["in-progress", "claimed"].includes(status) ? "started" : "unstarted";
    const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    const title = heading?.replace(number ? /^\d+\s*:\s*/ : /^Spec:\s*/i, "") ?? (number ?? feature);
    const id = path;
    issues.push({ id, identifier: number ? `${feature}/${number}` : feature, title, description: markdown,
      url: pathToFileURL(absolute).href, updatedAt: branchUpdatedAt ?? info!.mtime.toISOString(), parentId: number ? `.scratch/${feature}/spec.md` : null,
      state: { id: status, name: statusName, type }, labels: status === "ready-for-agent" ? [label(status)] : [],
      assignees: [], inProject: true, path });
    const blocked = metadata("Blocked by");
    blockers.set(id, !blocked || /^(?:none\b|n\/a\b|[-—]\.?$)/i.test(blocked) ? []
      : blocked.split(",").map((value) => value.trim().replace(/^#/, "")));
  }
  if (revision) {
    // Enumerate committed regular files, including tickets absent from main. Never check out the branch.
    const paths = (await git(["ls-tree", "-rz", "--full-tree", revision, "--", ".scratch"]))
      .split("\0").flatMap((entry) => /^100(?:644|755) blob [a-f0-9]+\t(.+)$/.exec(entry)?.[1] ?? []);
    const specs = paths.filter((path) => /^\.scratch\/[^/]+\/spec\.md$/.test(path)).sort();
    for (const spec of specs) {
      const feature = spec.split("/")[1];
      await read(spec, feature);
      for (const path of paths.filter((path) => path.startsWith(`.scratch/${feature}/issues/`) && path.split("/").length === 4 && /^\d+-[^/]*\.md$/.test(path.split("/")[3] ?? ""))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
        await read(path, feature, /^(\d+)-/.exec(path.split("/")[3])![1]);
      }
    }
  } else {
  const scratch = join(input.checkoutPath, ".scratch");
  for (const feature of (await entries(scratch)).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = await entries(join(scratch, feature.name));
    if (!files.some((entry) => entry.isFile() && entry.name === "spec.md")) continue;
    await read(`.scratch/${feature.name}/spec.md`, feature.name);
    for (const ticket of (await entries(join(scratch, feature.name, "issues"))).filter((entry) => entry.isFile() && /^\d+-.*\.md$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
      await read(`.scratch/${feature.name}/issues/${ticket.name}`, feature.name, /^(\d+)-/.exec(ticket.name)![1]);
    }
  }
  }
  const relations = [...blockers].flatMap(([relatedIssueId, numbers]) => numbers.map((number) => {
    const feature = relatedIssueId.split("/")[1];
    const blocker = issues.find((issue) => issue.identifier === `${feature}/${number.padStart(2, "0")}`);
    if (!blocker) throw new Error("A local markdown blocker does not name a ticket.");
    return { id: `${blocker.id}:blocks:${relatedIssueId}`, type: "blocks" as const, issueId: blocker.id, relatedIssueId };
  }));
  return { kind: "local-markdown", bbProjectId: input.bbProjectId, project: { name: input.projectName }, issues, relations,
    labels: [...new Map(issues.flatMap((issue) => issue.labels).map((value) => [value.id, value])).values()],
    states: [...new Map(issues.map((issue) => [issue.state.id, issue.state])).values()], syncedAt: Date.now(), error: null };
}
