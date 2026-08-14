# TenX — Agent Instructions

> **Precedence:** user instructions (direct requests) > this AGENTS.md > spec/contracts under `docs/superpowers/specs/` and `contracts/` > default system prompt.

This repo provisions an always-on **Paperclip Agent Company** platform. Paperclip handles orchestration, delegating to Pi (`pi_local`) for execution.

## Platform Architecture — The Big Picture

TenX builds an autonomous software factory: AI agents that take a product brief and deliver a deployed application — design, code, tests, PRs, and production deployment — with human review at key gates.

### How the pieces fit together

```
Provisioning Wizard ──generates──> Company (agents, projects, repos, graphs)
       │
       └──> Workflow Engine ──drives──> Pipeline (design → build → deploy)
              │
              ├── Architect: single source of truth, creates contracts, decomposes work
              ├── Coder: dispatches sp-implementer sub-agents for parallel building
              ├── Designer: creates mockups via Open Design
              ├── QA: reviews against quality guidelines
              └── Hindsight: persistent memory across all agent runs
```

### The Architect is the brain

The Architect holds the big picture: what services exist, how they connect, what credentials are in use. Before decomposing work, the Architect creates an **integration contract** document defining API endpoints, data models, auth flow, and integration wiring. This contract is the single source of truth that ensures independently-built pieces (frontend pages, backend services) connect coherently.

### The workflow graph provides structure

Every project has a pipeline graph with nodes for each step (design, code, QA, review, deploy). The graph enforces quality gates — work can't advance until checks pass. Multiple **entry points** allow different work types: features go through the full design pipeline, bugs skip straight to investigation and fix.

### Sub-agents provide parallelism within a single task

The Coder uses `sp-implementer` sub-agents (via the `subagent` tool) to build independent subtasks in parallel within a single heartbeat. This is complementary to Paperclip's concurrent heartbeats (which parallelize across different issues).

### Hindsight provides persistent memory

Every agent gets Hindsight recall at run start and auto-retains comments. The company-level bank (`['company']` granularity) shares memory across all agents — the Architect's knowledge is available to the Coder, QA, etc. Agents call `hindsight_recall` to surface relevant context and `hindsight_retain` to store discoveries.

### Production deployment is part of the pipeline

The `deploy_production` node deploys to permanent subdomains (`{companySlug}.robotpants.ddns.net`) via Docker containers behind Caddy. The pipeline doesn't stop at preview — it goes all the way to a live production URL.

### Key design principles

1. **The contract is the glue** — if the contract is right, everything downstream works. If it's wrong, everything is wrong.
2. **Smaller outputs are better** — sub-agent dispatch produces small, verifiable chunks instead of one massive build.
3. **The graph is the tool, not the brain** — the graph provides structure and quality gates. The Architect provides intelligence and routing.
4. **Memory persists** — Hindsight ensures agents don't start from scratch each run. Decisions and discoveries accumulate.

## Essential Reading (in order)

1. **`docs/guides/operational-runbook.md`** — THE single source of truth. Server access, agent execution, fan-out, circuit breaker, OD integration, zeroing/restoring, plugin deployment, known SDK issues. Start here.
2. **`docs/guides/gotchas.md`** — every trap, pitfall, + lesson learned. READ THIS before any work.
3. **`docs/guides/zero-and-restore.md`** — How to zero a company and restore the wizard draft. NEVER DELETE wizard sessions.
4. **`docs/guides/gcp-gemini-brownfield-setup.md`** — Quick reference for GCP + Gemini + brownfield + integrations.
5. **`docs/guides/troubleshooting.md`** — Every bug, fix, and lesson learned by category.
6. **`docs/superpowers/specs/2026-07-29-post-design-fanout-design.md`** — The next feature to implement: parallel frontend coding via post-design fan-out.
7. `docs/guides/platform-overview.md` — What TenX is and how the layers fit.
8. `docs/plugins/` — Plugin reference docs (workflow-engine, jira-bridge, od-bridge, company-defaults, provisioning-wizard, etc.)

## Server

- **ASUS NUC (home):** `ssh test@100.112.32.2` (Tailscale) — sudo password: `minecraft1`
  - Paperclip API: `http://127.0.0.1:3100/api` (on server)
  - Paperclip UI: `https://robotpants.ddns.net:9444`
  - DB: `PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip`
- **GCP Daily Foods:** `ssh -i ~/.ssh/google_compute_engine adamteale@136.119.205.29`
  - Paperclip UI: `https://paperclip.136-119-205-29.sslip.io`
  - Open Design: `https://od.136-119-205-29.sslip.io`
  - Daily Foods company ID: `29d6c3fd-03d3-43ed-a010-3b2afdff3465`
  - Jira board: project key `DF`, board ID `2427`, 51 tickets
- **WFE namespace:** `plugin_workflow_engine_2da16ae596`
- **Wizard namespace:** `plugin_provisioning_wizard_2cbfa2c8e9`
- **Server repos:** `/srv/paperclip/repo` (core), `/srv/TenX` (this repo), `/srv/paperclip/plugins` (installed plugins)

## Current Status (2026-07-31)

**Working:**
- Provisioning wizard → company generation (agents, projects, repos, graphs, Gitea setup)
- Workflow engine with multiple entry points (Feature, Bug fix, Quick fix)
- Program-level fan-out + pipeline-level fan-out with child-coder graph
- Integration contract embedding (fan-out reads parent's contract doc, embeds in children)
- Hindsight memory (auto-recall at run start, auto-retain on comments, company-level bank)
- Designer + Open Design mockups with brand skip/apply gate
- Production deployment via `production-deploy` script + Caddy routing
- Auto-approve at all human review gates (program plan, design, PR, preview)
- CEO non-grab rules (won't override workflow assignments)
- Coder sub-agent dispatch pattern (sp-implementer for parallel subtasks)
- pi-local adapter patch: skip `pi --list-models` (eliminates heartbeat contention)
- Fan-in loop fix, escaped-backtick parser fix, auto-cancel fix for standalone issues

**Known issues:**
- Wizard auto-config for Hindsight is unreliable — always verify/insert manually after generation
- Agent instruction sync race — instructions may be empty if agents unpause before sync completes
- Recovery system may reassign issues to wrong agents after errors
- Sub-agent dispatch (sp-implementer) not yet verified working end-to-end in Paperclip context
- Paperclip core ancestor context only passes parent titles, not descriptions (contract-in-description works around this)

## Key Rules

- **NEVER `DELETE` wizard sessions** — always `UPDATE status='active'` to restore a completed draft.
- **Always pass `%` wildcards** to `zero-company.sh` (e.g. `'%X Bank%'`, not `'X Bank'`).
- **Use `node esbuild.config.mjs`** to build plugins, NOT `npx esbuild` (ESM mismatch).
- **ALWAYS deploy all 3 esbuild outputs** (`worker.js`, `manifest.js`, `ui/index.js`) + restart Paperclip + reset plugin status to `ready`.
- **Plugin UI entrypoint must be a directory** (`"./dist/ui/"`) not a file (`"./dist/ui/index.js"`).
- **Plugin UI must use `export const X: React.FC` pattern** (not `export function X`).
- **Plugin UI must use CSS variables** for dark mode (`var(--card)`, `var(--foreground)`, `var(--border)`, `var(--muted-foreground)`).
- **`ctx.config.get()` + `ctx.secrets.resolve()` do NOT work in plugin API route handlers** — read from `/etc/paperclip/env` instead.
- **Jira API:** use `GET /rest/api/3/search/jql` (old `POST /search` was removed — 410).
- **OD bridge uses scheduled jobs** — `setInterval` does NOT work in the plugin worker context.
- **`runWorker(plugin, import.meta.url)`** — must pass `import.meta.url` or the worker crashes.
- **Designer must use WFE `open_design_create` tool** — NOT the MCP tool (MCP tool doesn't append issue ID to project name).
- **Agent heartbeat runs show 0 bytes for first few minutes** — this is normal, don't cancel.
- **`ctx.issues.*` fails in watchdog context** — use HTTP fallbacks (`fetch http://127.0.0.1:3100/api/...`).
- **Server patches are lost on restart** — add to `provision/paperclip-patches/` as `.patch` files.
- **The Paperclip server runs from TypeScript source via tsx**, NOT from `dist/`.
- **ALWAYS use the `run_tests` WFE tool to run test suites** — NEVER shell out to `pnpm test`, `npm test`, `jest`, or `vitest` directly. `run_tests` serialises execution server-wide (one suite at a time) to prevent CPU saturation when multiple Coder agents run simultaneously. Call it with `cwd` (project root) and `command` (e.g. `"pnpm test"`). See `docs/guides/wfe-test-runner.md` for why.

## Plugin Development

```bash
# Build a plugin
cd plugins/paperclip-workflow-engine && node esbuild.config.mjs

# Deploy to server
scp dist/worker.js test@100.112.32.2:/tmp/worker.js
ssh test@100.112.32.2 "echo 'minecraft1' | sudo -S bash -c 'cp /tmp/worker.js /srv/paperclip/plugins/paperclip-workflow-engine/dist/worker.js && systemctl restart paperclip'"

# Check plugin health
ssh test@100.112.32.2 'curl -s http://127.0.0.1:3100/api/plugins | python3 -c "import sys,json; [print(f\"{p[\"pluginKey\"]}: {p[\"status\"]}\") for p in json.load(sys.stdin)]"'

# If plugin stuck in error state:
# UPDATE plugins SET status='ready' WHERE plugin_key='paperclip.workflow-engine';
# then restart Paperclip
```

## Pi Skills Available

Future agents (including cheaper/dumber models) should read these pi-skills:
- `project:asus-nextcloud-tsa:paperclip-server-ops` — server access, API, DB, plugins, deployment
- `project:asus-nextcloud-tsa:workflow-engine-reference` — node types, gates, enforcer logic
- `project:asus-nextcloud-tsa:zero-and-restore-company` — zeroing + wizard draft restoration
- `project:asus-nextcloud-tsa:plugins-reference` — what each plugin does, key routes, UI slots
- `project:asus-nextcloud-tsa:project-orientation` — map of the entire infrastructure
- `project:asus-nextcloud-tsa:paperclip-stuck-issue-recovery` — recover stuck/blocked issues
- `project:asus-nextcloud-tsa:clean-demo-run-checklist` — pre-flight checklist before a demo run

## Session Budget

- **Hard cap: 100K context tokens per session.** When you approach it, checkpoint state to `.agent-scratchpad.md` and start fresh.
- Long command output → pipe to file, reference it, don't paste into chat.
- Prefer `rg` (ripgrep) over `grep` for searching. Use CodeGraph tools for structural code questions.

## Do Not

- Do not scaffold product code inside `TenX`; use the per-project repo.
- Do not paste >50 lines of command output into chat.
- Do not claim work is complete without verification.
- Do not DELETE wizard sessions — use UPDATE status='active'.
- Do not use `npx esbuild` — use `node esbuild.config.mjs`.
- Do not cancel heartbeat runs that show 0 bytes of log — wait 3-5 minutes.