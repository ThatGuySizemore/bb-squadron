import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Helper, helperContract } from "../lib/helper-contract.js";
import { Term } from "./Term.js";
import "./helper.css";

/** The same install-wide Helper from every project's header. */
export function HelperControl({ projectId, openThread }: { projectId: string | null; openThread: (threadId: string) => void }) {
  const rpc = useRpc<typeof helperContract>();
  const [helper, setHelper] = useState<Helper | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [threads, setThreads] = useState<Helper[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const listId = useId();
  const version = useRef(0);
  const active = useRef(false);
  const choices = useRef(0);
  useEffect(() => {
    let current = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      const request = ++version.current;
      try {
        const value = await rpc.call("helper.read", null);
        if (current && request === version.current && !active.current) { setHelper(value); setLoaded(true); setError(null); }
      } catch { if (current && request === version.current && !active.current) { setLoaded(false); setError("Couldn't read the Helper. Try again when its machine is online."); } }
    };
    void read();
    const interval = window.setInterval(() => void read(), 15_000);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => { current = false; version.current++; window.clearInterval(interval); window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read); };
  }, [rpc, projectId]);
  const close = useCallback(() => { setMenu(false); setChoosing(false); toggle.current?.focus(); }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (event.target && !root.current?.contains(event.target as Node)) { setMenu(false); setChoosing(false); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => { choices.current++; setMenu(false); setChoosing(false); setThreads(null); }, [projectId]);
  useLayoutEffect(() => {
    if (!menu) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect();
      const box = menuBox.current;
      if (!anchor || !box) return;
      const board = root.current?.closest(".sq")?.getBoundingClientRect();
      const left = Math.max(14, board?.left ?? 0);
      const right = Math.min(window.innerWidth - 14, board ? board.right - 14 : window.innerWidth - 14);
      box.style.left = `${Math.max(left, Math.min(anchor.left, right - box.getBoundingClientRect().width)) - anchor.left}px`;
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);
  const run = async (action: () => Promise<Helper>) => {
    if (active.current) return;
    active.current = true; version.current++; setBusy(true); setError(null);
    try {
      const selected = await action();
      setHelper(selected); setLoaded(true); setMenu(false); setChoosing(false);
      openThread(selected.threadId);
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn't open the Helper. Try again."); }
    finally { active.current = false; setBusy(false); }
  };
  const start = (fresh = false) => {
    if (!projectId) return;
    void run(() => rpc.call("helper.start", { projectId, ...(fresh ? { fresh: true } : {}) }));
  };
  const choose = async () => {
    if (!projectId || active.current) return;
    setChoosing(true); setThreads(null); setError(null);
    const request = ++choices.current;
    try { const list = await rpc.call("helper.threads", { projectId }); if (request === choices.current) setThreads(list); }
    catch { if (request === choices.current) setError("Couldn't read this project's threads. Close this menu and try again."); }
  };
  return <div className="sq-helper" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && menu) { event.stopPropagation(); close(); }
  }}>
    <button type="button" className="sq-btn" disabled={!loaded || !projectId || busy} aria-busy={busy} onClick={() => start()}>
      {!helper ? "Start " : null}<Term text="Helper" nested />
    </button>
    {helper ? <button type="button" className="sq-btn sq-helper-toggle" ref={toggle} aria-label="Helper options" aria-expanded={menu}
      aria-controls={menu ? listId : undefined} disabled={busy} onClick={() => { setMenu((value) => !value); setChoosing(false); }}>
      <svg aria-hidden="true" width="10" height="6" viewBox="0 0 10 6" shapeRendering="crispEdges">
        {[[0, 0], [2, 2], [4, 4], [6, 2], [8, 0]].map(([x, y]) => <rect key={x} x={x} y={y} width="2" height="2" />)}
      </svg>
    </button> : null}
    {helper && menu ? <div id={listId} ref={menuBox} className="sq-helper-menu" role="region" aria-label="Helper options">
      <button className="sq-helper-option" type="button" disabled={busy} onClick={() => start(true)}>Start new</button>
      <button className="sq-helper-option" type="button" disabled={busy} onClick={() => void choose()}>Use another thread…</button>
      {choosing ? <div className="sq-helper-threads" role="region" aria-label="Recent threads" aria-busy={threads === null}>
        {threads === null ? <p role="status">Reading threads…</p> : threads.length === 0 ? <p>No recent threads in this project.</p>
          : threads.map((thread) => <button type="button" className="sq-helper-option" key={thread.threadId} disabled={busy}
            aria-current={thread.threadId === helper.threadId} onClick={() => {
              if (projectId) void run(() => rpc.call("helper.use", { projectId, threadId: thread.threadId }));
            }}>{thread.title}</button>)}
      </div> : null}
    </div> : null}
    {error ? <span className="sq-helper-error" role="status">{error}</span> : null}
  </div>;
}
