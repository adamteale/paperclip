import type {
  AgentToolDescriptor,
  PluginToolDispatcher,
} from "./plugin-tool-dispatcher.js";

/**
 * Module-level default dispatcher.
 *
 * `heartbeatService` is instantiated in many places (index.ts, routes,
 * services) and most of them don't — and shouldn't — know about the plugin
 * tool dispatcher. Rather than threading `toolDispatcher` through every
 * instantiation, the app wiring registers the dispatcher once here
 * (see app.ts), and `selectPluginTools` falls back to it when the service
 * options don't carry one.
 */
let defaultDispatcher: PluginToolDispatcher | undefined;

/** Register the process-wide plugin tool dispatcher (called once at app wiring). */
export function setDefaultToolDispatcher(dispatcher: PluginToolDispatcher | undefined): void {
  defaultDispatcher = dispatcher;
}

/**
 * Resolve the plugin tools to expose to an agent for a single execution.
 *
 * Kept as a small pure helper so the heartbeat service can attach the result
 * to `AdapterExecutionContext.pluginTools` at the `adapter.execute(...)` call
 * site without dragging the ~10k-line heartbeat module into unit tests.
 *
 * Precedence: an explicitly passed dispatcher (service options) wins; the
 * process-wide default (registered by the app wiring) is the fallback; with
 * neither, returns an empty array (e.g. the plugin system is disabled or a
 * test harness has not provided one).
 */
export function selectPluginTools(
  toolDispatcher?: Pick<PluginToolDispatcher, "listToolsForAgent">,
): AgentToolDescriptor[] {
  const dispatcher = toolDispatcher ?? defaultDispatcher;
  return dispatcher?.listToolsForAgent() ?? [];
}
