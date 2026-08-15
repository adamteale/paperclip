/**
 * Deterministic reference inheritance for machine decomposition paths.
 *
 * When a case (or issue) is decomposed into children, external references
 * present in the parent text but absent from the child text — Figma links,
 * Open Design projects, Jira tickets, any http(s) URL — are appended to the
 * child, so downstream stages never lose sight of the sources. This keeps
 * design/implement tasks anchored to the artifacts the request referenced
 * without relying on the decomposing agent to copy links through.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** Extract deduplicated URLs from free text, preserving order of appearance.
 * Markdown link targets `[label](https://…)` are captured (the pattern stops
 * at the closing paren), as are bare URLs. Trailing sentence punctuation is
 * trimmed. */
export function extractReferenceUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!url) continue;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** Build the child text with parent references the child does not already
 * mention appended under a labelled block. Returns the child text unchanged
 * (including null) when there is nothing to inherit. */
export function inheritReferenceUrls(
  childText: string | null | undefined,
  parentText: string | null | undefined,
): string | null {
  const child = childText && childText.trim().length > 0 ? childText : null;
  const parent = parentText && parentText.trim().length > 0 ? parentText : null;
  if (!parent) return child;
  const childUrls = new Set(extractReferenceUrls(child));
  const missing = extractReferenceUrls(parent).filter((url) => !childUrls.has(url));
  if (missing.length === 0) return child;
  const blockLines = [
    "",
    "",
    "**References (inherited from parent):**",
    ...missing.map((url) => `- ${url}`),
  ];
  return child ? child + blockLines.join("\n") : blockLines.slice(2).join("\n");
}
