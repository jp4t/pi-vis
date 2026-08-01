import TurndownService from "turndown";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});

// Disable markdown-metacharacter escaping — the transcript is a copy-for-answer
// surface, not a round-trip store.  Users paste answers into docs and chats;
// seeing \_escaped\_ prose is worse than the rare case where literal text
// happens to look like markdown.
turndownService.escape = (str: string): string => str;

// Custom rule for pi-vis code blocks rendered by Shiki / Markdown.
// The CodeBlock component wraps output in an element with class "code-block"
// and a data-language attribute (e.g. data-language="typescript").
// This rule captures that wrapper and emits a fenced code block with the
// correct language annotation, stripping Shiki's syntax-highlight <span>s.
turndownService.addRule("codeBlock", {
  filter: (node) => {
    return (
      (node.nodeName === "DIV" || node.nodeName === "PRE") && node.classList.contains("code-block")
    );
  },
  replacement: (_content, node) => {
    const lang = node.getAttribute("data-language") || "";
    // For the Shiki-highlighted variant the code text lives inside a
    // nested <pre><code>; for the plain pre fallback it is the element's
    // own textContent.  Using textContent on the appropriate child strips
    // all Shiki <span> cruft.
    const codeEl = node.nodeName === "PRE" ? node : node.querySelector("pre");
    const code = (codeEl?.textContent ?? node.textContent ?? "").trimEnd();
    const fence = lang && lang !== "text" ? `\`\`\`${lang}` : "```";
    // Surround with \n\n so that turndown's join logic (max of trailing /
    // leading newlines from adjacent blocks) produces the correct separator
    // even between two back-to-back code blocks.  The outer newlines are
    // trimmed by postProcess, so they never leak into the final output.
    return `\n\n${fence}\n${code}\n\`\`\`\n\n`;
  },
});

/**
 * Convert an HTML string or DOM Node to Markdown.
 */
export function htmlToMarkdown(html: string | DocumentFragment): string {
  return turndownService.turndown(html);
}

function closestElement(node: Node, selector: string): Element | null {
  const element = node.nodeType === node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest(selector) ?? null;
}

function selectedTextContent(range: Range, root: Element): string {
  const text = root.textContent ?? "";
  const prefixLength = (container: Node, offset: number): number => {
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(container, offset);
    return (prefix.cloneContents().textContent ?? "").length;
  };
  return text.slice(
    prefixLength(range.startContainer, range.startOffset),
    prefixLength(range.endContainer, range.endOffset),
  );
}

/**
 * Convert a transcript selection to clipboard Markdown while retaining the
 * semantic container that Range.cloneContents() drops when both selection
 * endpoints live inside that container.
 *
 * User messages are authored plain text, so their literal Range text is the
 * clipboard source of truth (including newlines represented only through
 * `white-space: pre-wrap`). Fenced code needs a synthetic copy of its original
 * wrapper so the code-block Turndown rule still supplies fences and language
 * metadata when the selection contains no surrounding prose.
 */
export function transcriptSelectionToMarkdown(range: Range): string {
  const commonAncestor = range.commonAncestorContainer;
  const userContent = closestElement(
    commonAncestor,
    ".transcript-block--user .transcript-block__content",
  );
  if (userContent) {
    return selectedTextContent(range, userContent);
  }

  const codeBlock = closestElement(commonAncestor, ".code-block");
  if (codeBlock) {
    const selectedCodeBlock = codeBlock.cloneNode(false) as Element;
    const selectedCode = selectedTextContent(range, codeBlock);
    if (selectedCodeBlock.nodeName === "PRE") {
      selectedCodeBlock.textContent = selectedCode;
    } else {
      const pre = codeBlock.ownerDocument.createElement("pre");
      const code = codeBlock.ownerDocument.createElement("code");
      code.textContent = selectedCode;
      pre.append(code);
      selectedCodeBlock.append(pre);
    }
    const fragment = codeBlock.ownerDocument.createDocumentFragment();
    fragment.append(selectedCodeBlock);
    return htmlToMarkdown(fragment);
  }

  return htmlToMarkdown(range.cloneContents());
}
