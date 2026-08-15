import { describe, expect, it } from "vitest";
import { extractReferenceUrls, inheritReferenceUrls } from "./reference-inheritance.js";

describe("extractReferenceUrls", () => {
  it("returns empty for null/undefined/empty text", () => {
    expect(extractReferenceUrls(null)).toEqual([]);
    expect(extractReferenceUrls(undefined)).toEqual([]);
    expect(extractReferenceUrls("")).toEqual([]);
    expect(extractReferenceUrls("   ")).toEqual([]);
  });

  it("extracts bare URLs", () => {
    const out = extractReferenceUrls("see https://figma.com/design/abc for comps");
    expect(out).toEqual(["https://figma.com/design/abc"]);
  });

  it("extracts markdown link targets", () => {
    const out = extractReferenceUrls("[DF-165](https://applydigital.atlassian.net/browse/DF-165) is the source");
    expect(out).toEqual(["https://applydigital.atlassian.net/browse/DF-165"]);
  });

  it("deduplicates while preserving order", () => {
    const text = "a https://x.com/1 b https://x.com/1 c https://y.com/2 d https://x.com/1";
    expect(extractReferenceUrls(text)).toEqual(["https://x.com/1", "https://y.com/2"]);
  });

  it("trims trailing sentence punctuation", () => {
    expect(extractReferenceUrls("go to https://example.com/a. Then https://example.com/b,")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("stops at closing paren and bracket (markdown safe)", () => {
    const out = extractReferenceUrls("([link](https://od.example/p/1)) [ref]");
    expect(out).toEqual(["https://od.example/p/1"]);
  });

  it("ignores non-http schemes", () => {
    expect(extractReferenceUrls("mailto:a@b.com ftp://x.y z")).toEqual([]);
  });
});

describe("inheritReferenceUrls", () => {
  const PARENT =
    "Brand tokens per [DF-9](https://applydigital.atlassian.net/browse/DF-9). " +
    "Figma: https://www.figma.com/design/rmWi7jY8a6XzaASwTNZxZu/DS-Daily-Foods?node-id=2148-912";

  it("returns child unchanged when parent has no urls", () => {
    expect(inheritReferenceUrls("child text", "parent without links")).toBe("child text");
  });

  it("returns null when child is null and parent has no urls", () => {
    expect(inheritReferenceUrls(null, "no links here")).toBeNull();
  });

  it("appends missing parent urls under a labelled block", () => {
    const out = inheritReferenceUrls("Build the navbar shell.", PARENT);
    expect(out).not.toBeNull();
    expect(out!.startsWith("Build the navbar shell.")).toBe(true);
    expect(out!).toContain("**References (inherited from parent):**");
    expect(out!).toContain("- https://www.figma.com/design/rmWi7jY8a6XzaASwTNZxZu/DS-Daily-Foods?node-id=2148-912");
    expect(out!).toContain("- https://applydigital.atlassian.net/browse/DF-9");
  });

  it("does not duplicate urls the child already mentions", () => {
    const child =
      "Per [DF-9](https://applydigital.atlassian.net/browse/DF-9): " +
      "Figma comps at https://www.figma.com/design/rmWi7jY8a6XzaASwTNZxZu/DS-Daily-Foods?node-id=2148-912 already";
    expect(inheritReferenceUrls(child, PARENT)).toBe(child);
  });

  it("appends only the urls the child is missing", () => {
    const child = "Build navbar. Figma: https://www.figma.com/design/rmWi7jY8a6XzaASwTNZxZu/DS-Daily-Foods?node-id=2148-912";
    const out = inheritReferenceUrls(child, PARENT)!;
    expect(out.startsWith(child)).toBe(true);
    expect(out).toContain("- https://applydigital.atlassian.net/browse/DF-9");
    expect(out.match(/figma\.com/g)).toHaveLength(1); // child text only — not duplicated in the block
  });

  it("builds a standalone block when child text is null", () => {
    const out = inheritReferenceUrls(null, PARENT)!;
    expect(out.startsWith("**References (inherited from parent):**")).toBe(true);
    expect(out).not.toContain("\n\n");
  });

  it("treats whitespace-only child as null", () => {
    const out = inheritReferenceUrls("   \n  ", PARENT)!;
    expect(out.startsWith("**References (inherited from parent):**")).toBe(true);
  });
});
