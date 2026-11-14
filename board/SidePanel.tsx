// SIZE-959: the board as a tab in a thread's side panel (BB's experimental_tab,
// thread context). It opens on the thread's project, lays out narrow, and opens
// thread links in the main view beside it.
import { useEffect, useState } from "react";
import { useBbContext, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { LiveBoard } from "./Board.js";

interface ThreadReader {
  threads: { get(args: { threadId: string }): Promise<{ projectId?: string | null }> };
}

/** The thread's BB project, or null when it has none or can't be read; the picker's order takes over then. */
export async function threadProject(sdk: ThreadReader, threadId: string): Promise<string | null> {
  try {
    return (await sdk.threads.get({ threadId })).projectId ?? null;
  } catch {
    return null;
  }
}

export function SidePanelBoard({ threadId }: ExperimentalThreadTabProps) {
  const sdk = useSdk();
  const context = useBbContext();
  // BB's own selection already names this thread's project when the thread is the one in view.
  const known = context.threadId === threadId && context.projectId ? context.projectId : undefined;
  const [resolved, setResolved] = useState<{ threadId: string; projectId: string | null } | null>(null);
  useEffect(() => {
    if (known) return;
    let current = true;
    void threadProject(sdk, threadId).then((projectId) => { if (current) setResolved({ threadId, projectId }); });
    return () => { current = false; };
  }, [sdk, threadId, known]);
  const projectId = known ?? (resolved?.threadId === threadId ? resolved.projectId : undefined);
  if (projectId === undefined) {
    return (
      <div className="sq" data-layout="narrow">
        <div className="sq-page">
          <p className="sq-clear" role="status">Finding this thread's project.</p>
        </div>
      </div>
    );
  }
  return <LiveBoard key={threadId} modeSwitch={null} context={projectId} placement="panel" />;
}
