import { describe, expect, it } from "vitest";
import { BASE_PI_TOOLS, buildArgs } from "./execute.js";

const baseOpts = {
  renderedSystemPromptExtension: "sys",
  provider: null,
  modelId: null,
  thinking: "",
  skillsDir: "/tmp/skills",
  extraArgs: [] as string[],
  userPrompt: "hello",
};

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
