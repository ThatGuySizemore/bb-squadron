import { useEffect, useId, useRef } from "react";
import { OWNER_WORDS, type OwnerWord } from "../lib/owner-words.js";
import "./term.css";

export function isOwnerWord(text: string): text is OwnerWord {
  return Object.hasOwn(OWNER_WORDS, text);
}

/**
 * A label that may be an owner word. An owner word shows its glossary definition
 * on hover and keyboard focus; any other text renders as it is.
 * `nested` marks a label inside a button or link: the control keeps the only tab
 * stop, and its own keyboard focus shows the definition.
 */
export function Term({ text, nested = false }: { text: string; nested?: boolean }) {
  return isOwnerWord(text) ? <OwnerTerm word={text} nested={nested} /> : <>{text}</>;
}

const GAP = 6;
const EDGE = 8;
const HIDE_MS = 120;

function OwnerTerm({ word, nested }: { word: OwnerWord; nested: boolean }) {
  const id = useId();
  const term = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const hiding = useRef<number | null>(null);

  useEffect(() => {
    const anchor = term.current;
    const popover = tip.current;
    if (!anchor || !popover || typeof popover.showPopover !== "function") return;
    // Inside a control, the control takes focus and is described by the definition.
    const host = nested ? anchor.parentElement?.closest<HTMLElement>("button, a, summary") ?? anchor : anchor;
    const isOpen = () => popover.matches(":popover-open");
    const cancel = () => { if (hiding.current !== null) { window.clearTimeout(hiding.current); hiding.current = null; } };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    // The definition belongs to where the word sits; a scroll moves the word away from it.
    const hide = () => {
      cancel();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      if (isOpen()) popover.hidePopover();
    };
    const hideSoon = () => { cancel(); hiding.current = window.setTimeout(hide, HIDE_MS); };
    const show = () => {
      cancel();
      if (!isOpen()) {
        popover.showPopover();
        document.addEventListener("keydown", onKey);
        window.addEventListener("scroll", hide, true);
      }
      // Below the word, or above it near the bottom; always inside the window.
      const a = anchor.getBoundingClientRect();
      const t = popover.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const below = a.bottom + GAP;
      const top = below + t.height > height - EDGE && a.top - GAP - t.height >= EDGE ? a.top - GAP - t.height : below;
      popover.style.top = `${Math.round(top)}px`;
      popover.style.left = `${Math.round(Math.max(EDGE, Math.min(a.left, width - EDGE - t.width)))}px`;
    };
    const onFocus = () => { if (host.matches(":focus-visible")) show(); };
    const describedBy = host.getAttribute("aria-describedby");
    if (host !== anchor) host.setAttribute("aria-describedby", describedBy ? `${describedBy} ${id}` : id);
    anchor.addEventListener("pointerenter", show);
    anchor.addEventListener("pointerleave", hideSoon);
    host.addEventListener("focus", onFocus);
    host.addEventListener("blur", hide);
    return () => {
      hide();
      if (host !== anchor) {
        if (describedBy) host.setAttribute("aria-describedby", describedBy);
        else host.removeAttribute("aria-describedby");
      }
      anchor.removeEventListener("pointerenter", show);
      anchor.removeEventListener("pointerleave", hideSoon);
      host.removeEventListener("focus", onFocus);
      host.removeEventListener("blur", hide);
    };
  }, [id, nested]);

  return (
    <span ref={term} className="sq-term" data-term={word} tabIndex={nested ? undefined : 0} aria-describedby={nested ? undefined : id}>
      {word}
      {/* In the top layer, so a scrolling rail or a narrow panel never clips it. A click on it stays off the control it sits in. */}
      <span ref={tip} id={id} role="tooltip" popover="manual" className="sq-term-tip" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        {OWNER_WORDS[word]}
      </span>
    </span>
  );
}
