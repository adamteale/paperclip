import { describe, expect, it } from "vitest";
import { BASE_PI_TOOLS, buildArgs } from "./execute.js";

const baseOpts = {
  renderedSystemPromptExtension: "sys",
  provider: null,
  modelId: null,
  thinking: "",
  skillsDir: "/tmp/skills",
  extraArgs: [] as string[],
};

describe("buildArgs prompt delivery", () => {
  it("never puts the user prompt on argv, even if a caller still passes one (piped via stdin instead)", () => {
    // Regression test for the 2026-09-08 `spawn E2BIG` incident (DAI-314/DF-288):
    // a long-running ticket's assembled prompt grew past the OS argv+envp
    // ceiling because it was pushed as a positional CLI argument. BuildArgsOptions
    // no longer has a userPrompt field at all -- the prompt is passed as `stdin`
    // to the process-spawn call in `execute.ts`'s `runAttempt`, which has no such
    // ceiling (a pipe, not an execve() argument). This test injects a userPrompt
    // property at runtime (bypassing the type system) to confirm buildArgs
    // genuinely ignores it rather than merely relying on TypeScript to prevent
    // callers from passing it.
    const optsWithStalePromptField = { ...baseOpts, userPrompt: "SHOULD_NEVER_APPEAR_IN_ARGV" };
    const args = buildArgs("session.jsonl", optsWithStalePromptField);
    expect(args).not.toContain("SHOULD_NEVER_APPEAR_IN_ARGV");
    expect(args.join("\x00")).not.toContain("SHOULD_NEVER_APPEAR_IN_ARGV");
  });
});

describe("buildArgs plugin-tool wiring", () => {
  it("adds --extension and appends plugin tool names to --tools when pluginTools present", () => {
    const args = buildArgs("session.jsonl", {
      ...baseOpts,
      extensionPath: "/tmp/x/plugin-tools.mjs",
      pluginToolNames: ["paperclip.create_pr", "paperclip.merge_pr"],
    });

    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe(
      `${BASE_PI_TOOLS},paperclip.create_pr,paperclip.merge_pr`,
    );

    const extIdx = args.indexOf("--extension");
    expect(extIdx).toBeGreaterThanOrEqual(0);
    expect(args[extIdx + 1]).toBe("/tmp/x/plugin-tools.mjs");
  });

  it("is unchanged when pluginTools is empty or absent", () => {
    const args = buildArgs("session.jsonl", baseOpts);

    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe(BASE_PI_TOOLS);
    expect(args).not.toContain("--extension");
  });
});
