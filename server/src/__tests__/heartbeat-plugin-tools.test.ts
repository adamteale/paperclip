import { describe, expect, it } from "vitest";
import { selectPluginTools } from "../services/heartbeat-plugin-tools.js";
import type { AgentToolDescriptor } from "../services/plugin-tool-dispatcher.js";

describe("selectPluginTools", () => {
  it("forwards listToolsForAgent() descriptors unchanged", () => {
    const descriptor: AgentToolDescriptor = {
      name: "paperclip.create_pr",
      displayName: "Create PR",
      description: "Open a pull request",
      parametersSchema: { type: "object", properties: {} },
      pluginId: "paperclip.company-defaults",
    };
    const toolDispatcher = { listToolsForAgent: () => [descriptor] };

    expect(selectPluginTools(toolDispatcher)).toEqual([descriptor]);
  });

  it("returns an empty list when no dispatcher is wired in", () => {
    expect(selectPluginTools(undefined)).toEqual([]);
  });
});
