// Codex installs Matt's skills as a plugin that BB's skill catalogue doesn't
// list (the package ships no .codex-plugin/). Doctor's host falls back to
// Codex's own config and plugin cache. Pure parsing lives here.

export const MATT_CODEX_PLUGIN = { marketplace: "mattpocock", name: "mattpocock-skills" } as const;

/** A TOML table header's key path, with quotes and spacing removed. */
function tablePath(header: string): string[] {
  return [...header.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.\s]+)\s*(?:\.|$)/g)].map((part) => part[1].replace(/^["']|["']$/g, ""));
}

/** Whether `[plugins."<name>@<marketplace>"]` in Codex's config.toml has `enabled = true`. */
export function codexPluginEnabled(configToml: string, plugin: { marketplace: string; name: string } = MATT_CODEX_PLUGIN): boolean {
  const id = `${plugin.name}@${plugin.marketplace}`;
  let inTable = false;
  for (const line of configToml.split(/\r?\n/)) {
    const header = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const path = tablePath(header[1]);
      inTable = path.length === 2 && path[0] === "plugins" && path[1] === id;
      continue;
    }
    const enabled = inTable && /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (enabled) return enabled[1] === "true";
  }
  return false;
}

/** The highest dotted version, compared number by number. */
export function newestVersion(versions: readonly string[]): string | null {
  const parts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  return [...versions].sort((a, b) => {
    const [left, right] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0);
    return 0;
  })[0] ?? null;
}
