// SQD-202: what the owner reads, pulled out of rendered markup, and the
// retired words it must not contain.

/** Words GLOSSARY.md retired from anything the owner reads. A file name such as playbook.md is a path, not the word. */
export const RETIRED_TERMS = ["Frontier", "Lane state", "Status mapping", "Machine profile", "Playbook", "Chief"];

/** The retired words a piece of owner-facing text uses. */
export function retiredTerms(text: string): string[] {
  return RETIRED_TERMS.filter((term) => new RegExp(`\\b${term.replace(" ", "\\s+")}s?\\b(?!\\.md)`, "i").test(text));
}

export interface Element { tag: string; attrs: Record<string, string>; children: Node[]; parent: Element | null }
export interface Text { text: string; parent: Element }
export type Node = Element | Text;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, code: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    if (named[code.toLowerCase()]) return named[code.toLowerCase()];
    return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  });
}

/** A tree of React's static markup: quoted attributes, escaped text. */
export function parse(html: string): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [], parent: null };
  let open = root;
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    const [, closing, tag, attrText, selfClosing, text] = match;
    if (text !== undefined) { open.children.push({ text: decode(text), parent: open }); continue; }
    if (closing) {
      for (let node: Element | null = open; node; node = node.parent) {
        if (node.tag === tag) { open = node.parent ?? root; break; }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, name, value = ""] of attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[name] = decode(value);
    const element: Element = { tag, attrs, children: [], parent: open };
    open.children.push(element);
    if (!selfClosing && !VOID.has(tag)) open = element;
  }
  return root;
}

export function texts(node: Element): Text[] {
  return node.children.flatMap((child) => "text" in child ? [child] : texts(child));
}

export function elements(node: Element): Element[] {
  return node.children.flatMap((child) => "text" in child ? [] : [child, ...elements(child)]);
}

export function textOf(node: Element): string {
  return texts(node).map((text) => text.text).join("");
}

/** Everything the owner can read: text, plus the titles and labels a pointer or screen reader shows. */
export function readable(html: string): string[] {
  const root = parse(html);
  return [
    ...texts(root).map((text) => text.text),
    ...elements(root).flatMap((element) => ["title", "aria-label", "alt", "placeholder"].flatMap((name) => element.attrs[name] ?? [])),
  ].filter((text) => text.trim());
}
