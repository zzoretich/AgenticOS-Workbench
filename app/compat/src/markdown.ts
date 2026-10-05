// MarkdownRenderer: markdown-it with Obsidian's [[wiki-links]] and task checkboxes, sanitized by DOMPurify before it
// touches the DOM. Raw HTML in notes is escaped rather than rendered: notifications carry text from the web.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { Component } from "./events";

interface LinkHost { workspace: { openLinkText(link: string, source: string, newLeaf?: boolean): Promise<void> } }
let host: LinkHost | null = null;
/** The host app that internal links open through; set once at boot. */
export function setMarkdownHost(app: LinkHost): void { host = app; }

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src;
  const embed = src.charCodeAt(state.pos) === 0x21; // "!"
  const start = embed ? state.pos + 1 : state.pos;
  if (src.slice(start, start + 2) !== "[[") return false;
  const end = src.indexOf("]]", start + 2);
  if (end < 0) return false;
  if (!silent) {
    const [target, alias] = src.slice(start + 2, end).split("|");
    const tok = state.push("wikilink", "", 0);
    tok.meta = { target: target.trim(), alias: (alias ?? "").trim(), embed };
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, idx) => {
  const { target, alias } = tokens[idx].meta as { target: string; alias: string };
  const label = alias || target.replace(/#\^?/, " › ");
  return `<a class="internal-link" data-href="${md.utils.escapeHtml(target)}" href="#">${md.utils.escapeHtml(label)}</a>`;
};

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function taskify(root: DocumentFragment): void {
  for (const li of Array.from(root.querySelectorAll("li"))) {
    const first = li.firstChild?.nodeType === Node.TEXT_NODE ? li.firstChild : li.firstElementChild?.tagName === "P" ? li.firstElementChild.firstChild : null;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\[( |x|X)\]\s/.exec(first.textContent ?? "");
    if (!m) continue;
    first.textContent = (first.textContent ?? "").slice(m[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.checked = m[1] !== " ";
    box.className = "task-list-item-checkbox";
    first.parentNode?.insertBefore(box, first);
    li.classList.add("task-list-item");
    if (box.checked) li.classList.add("is-checked");
  }
}

/** Obsidian treats a Markdown link with no scheme (`[Title](brain/memory/x.md)`) as a link into the vault. */
function markVaultLinks(root: DocumentFragment): void {
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (a.classList.contains("internal-link") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    let target = href;
    try { target = decodeURIComponent(href); } catch { /* keep it as written */ }
    a.classList.add("internal-link");
    a.setAttribute("data-href", target);
    a.setAttribute("href", "#");
  }
}

function wireLinks(root: HTMLElement, sourcePath: string): void {
  root.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest("a");
    if (!a || !root.contains(a)) return;
    ev.preventDefault();
    if (a.classList.contains("internal-link")) {
      const target = a.getAttribute("data-href") ?? "";
      void host?.workspace.openLinkText(target, sourcePath, ev.metaKey || ev.ctrlKey);
      return;
    }
    const href = a.getAttribute("href") ?? "";
    // The main process decides what may open externally (an https allow-list); window.open is how we ask it.
    if (/^https?:\/\//i.test(href)) window.open(href);
  });
}

function renderInto(markdown: string, el: HTMLElement, sourcePath: string): void {
  const html = md.render(stripFrontmatter(markdown ?? ""));
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  taskify(frag);
  markVaultLinks(frag);
  el.classList.add("markdown-rendered");
  el.appendChild(frag);
  if (!(el as HTMLElement & { __aosLinks?: boolean }).__aosLinks) {
    (el as HTMLElement & { __aosLinks?: boolean }).__aosLinks = true;
    wireLinks(el, sourcePath);
  }
}

export class MarkdownRenderer extends Component {
  static async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, _component?: Component): Promise<void> {
    renderInto(markdown, el, sourcePath);
  }

  static async render(_app: unknown, markdown: string, el: HTMLElement, sourcePath: string, _component?: Component): Promise<void> {
    renderInto(markdown, el, sourcePath);
  }
}
