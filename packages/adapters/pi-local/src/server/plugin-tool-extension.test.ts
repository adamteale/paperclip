import { describe, expect, it } from "vitest";
import { renderPluginToolExtension, writePluginToolExtension } from "./plugin-tool-extension.js";
import type { AdapterPluginToolDescriptor } from "@paperclipai/adapter-utils";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const createPr: AdapterPluginToolDescriptor = {
  name: "paperclip.create_pr",
  displayName: "Create PR",
  description: "Open a PR",
  parametersSchema: { type: "object", properties: { title: { type: "string" } } },
  pluginId: "paperclip.company-defaults",
};

describe("renderPluginToolExtension", () => {
  it("emits a registerTool call per descriptor with an execute handler that POSTs to the execute endpoint", () => {
    const src = renderPluginToolExtension([createPr]);
    expect(src).toContain("pi.registerTool({");
    expect(src).toContain('name: "paperclip_create_pr"'); // sanitized for LLM providers
    expect(src).toContain('label: "Create PR"');
    expect(src).toContain("/api/plugins/tools/execute");
    expect(src).toContain("PAPERCLIP_API_KEY");
    expect(src).toContain("runContext"); // agentId/runId/companyId/projectId
  });

  it("emits one registerTool call per descriptor", () => {
    const src = renderPluginToolExtension([
      createPr,
      { name: "t2", displayName: "T2", description: "d2", parametersSchema: { type: "object" }, pluginId: "p" },
    ]);
    expect(src.match(/pi\.registerTool\(\{/g)).toHaveLength(2);
  });

  it("passes parametersSchema through as the tool parameters (typebox is JSON Schema)", () => {
    const src = renderPluginToolExtension([
      {
        name: "t",
        displayName: "T",
        description: "d",
        parametersSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        pluginId: "p",
      },
    ]);
    expect(src).toContain('"x"'); // schema content present
    expect(src).toContain('"required"');
  });

  it("escapes descriptor strings to keep the generated JS valid", () => {
    const src = renderPluginToolExtension([
      {
        name: "t",
        displayName: 'He said "hi"',
        description: "back`tick",
        parametersSchema: { type: "object" },
        pluginId: "p",
      },
    ]);
    expect(src).toMatch(/label:\s*"[^"]*"/); // no broken quotes
    expect(src).toContain('He said \\"hi\\"');
  });
});

describe("writePluginToolExtension", () => {
  it("writes the rendered extension to <dir>/plugin-tools.mjs and returns the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-local-plugin-tools-"));
    try {
      const path = await writePluginToolExtension([createPr], dir);
      expect(path).toBe(join(dir, "plugin-tools.mjs"));
      const contents = await readFile(path, "utf8");
      expect(contents).toContain("pi.registerTool({");
      expect(contents).toContain('name: "paperclip_create_pr"'); // sanitized
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generated extension loads", () => {
  it("imports cleanly and exports a default factory function (pi param)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-local-plugin-tools-load-"));
    try {
      const path = join(dir, "plugin-tools.mjs");
      await writeFile(path, renderPluginToolExtension([createPr]), "utf8");

      // Real gate: pi loads extensions via import() and calls the default
      // export with the ExtensionAPI. A bare-script that references `pi` at
      // module scope rejects here (ReferenceError: pi is not defined).
      const mod = await import(pathToFileURL(path).href);
      expect(typeof mod.default).toBe("function");

      // Exercise the factory with a stub ExtensionAPI to confirm registerTool
      // accepts the descriptor, incl. the JSON-Schema `parameters` passthrough.
      const registered: Array<{ name?: string; parameters?: unknown }> = [];
      mod.default({
        registerTool(def: { name?: string; parameters?: unknown }) {
          registered.push(def);
        },
      });
      expect(registered).toHaveLength(1);
      expect(registered[0]?.name).toBe("paperclip_create_pr"); // sanitized at registration
      expect(registered[0]?.parameters).toEqual(createPr.parametersSchema);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes node --check (syntax validity)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-local-plugin-tools-check-"));
    try {
      const path = join(dir, "plugin-tools.mjs");
      await writeFile(path, renderPluginToolExtension([createPr]), "utf8");
      await execFileAsync("node", ["--check", path]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeToolName", () => {
  it("replaces characters invalid for LLM tool names (dots, colons) with underscores", async () => {
    const { sanitizeToolName, renderPluginToolExtension } = await import("./plugin-tool-extension.js");
    expect(sanitizeToolName("paperclip.company-defaults:create_pr")).toBe("paperclip_company-defaults_create_pr");
    expect(sanitizeToolName("paperclip.create_pr")).toBe("paperclip_create_pr");
    // rendered extension registers the SANITIZED name but dispatches with the ORIGINAL
    const src = renderPluginToolExtension([{
      name: "paperclip.create_pr", displayName: "Create PR", description: "d",
      parametersSchema: { type: "object" }, pluginId: "p",
    }]);
    expect(src).toContain('name: "paperclip_create_pr"');
    expect(src).toContain('exec("paperclip.create_pr"');
  });
});
