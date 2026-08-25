<p align="center">
  <img src="docs/cover.png" alt="DeepSeek Capability Hub" width="100%" />
</p>

<h1 align="center">DeepSeek Capability Hub</h1>

<p align="center"><strong>One stable MCP tool. Capabilities appear only when the agent needs them.</strong></p>

<p align="center">
  <a href="https://github.com/NeoXider/deepseek-capability-hub/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/NeoXider/deepseek-capability-hub/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-49e7c6" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-1.30-8b79ff" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Capability Hub is a lazy MCP and skill broker for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and other MCP clients. The host sees one compact tool, `capability_hub`, instead of paying the context cost of every tool schema from every configured server.

The agent searches a lightweight catalog, inspects permissions, wakes one trusted server, calls it through the hub, and can shut it down again. Skill bodies are loaded only after selection.

## Why it exists

Large static MCP configurations waste context and make tool choice noisier. Capability Hub keeps the model-facing surface stable:

```text
search → inspect → enable → tools → call → disable
```

- One fixed schema stays in the Harness prompt.
- Child tool schemas remain outside the model context until requested.
- `tools` returns names and descriptions by default; full schemas are opt-in.
- MCP processes start lazily and live only for the hub process lifetime.
- Skills are discovered by metadata and loaded one at a time.
- Third-party additions enter a human approval queue; the model cannot self-approve executable code.

## Quick start

Requirements: Node.js 22.19+ and pnpm.

```powershell
git clone https://github.com/NeoXider/deepseek-capability-hub.git
cd deepseek-capability-hub
pnpm install --frozen-lockfile
pnpm test
pnpm client -- --json '{"action":"search","query":"demo"}'
```

The default catalog contains only a bundled echo MCP and an example ML skill. Tests do not download or execute third-party packages.

## DeepSeek Harness setup

Build the hub, then merge [`examples/dsh/cordis.patch.yml`](examples/dsh/cordis.patch.yml) into the active Harness Web profile and adjust the absolute repository path. Restart Harness.

```powershell
pnpm build
```

Harness will expose one model-facing tool:

```text
mcp__capability_hub__capability_hub
```

Start with:

```json
{"action":"search","query":"web research"}
```

## Model-facing contract

The public schema is intentionally flat so constrained-decoding engines such as LM Studio can compile it reliably. Arbitrary child arguments travel as JSON strings.

Discover and call a tool:

```json
{"action":"tools","name":"web-search-neo"}
```

```json
{
  "action": "call",
  "name": "web-search-neo",
  "tool": "web_info",
  "argumentsJson": "{\"topic\":\"search_status\"}"
}
```

Available actions:

| Action | Purpose |
|---|---|
| `search` | Search compact capability metadata |
| `inspect` | Review one capability, permissions, config and environment status |
| `configure` | Set allowlisted non-secret values through `configJson` |
| `enable` / `disable` | Start or stop one trusted MCP |
| `tools` | List child tools; schemas remain optional |
| `call` | Proxy one child tool call through `argumentsJson` |
| `skill.load` | Load one approved local skill body |
| `propose` | Store an untrusted proposal from `entryJson` |
| `proposals` | List pending proposals |
| `catalog.reload` | Reload approved catalog state |

## Real integration examples

Ready-to-review proposals are included for:

- [Web Search Neo](examples/catalog/web-search-neo.proposal.json) — dynamic web research and browser tooling.
- [Unity CLI MCP](examples/catalog/unity-cli.proposal.json) — the official Unity CLI transport. Its tool list is populated only while a Unity Editor with Unity Pipeline is connected.

These files are examples, not silently trusted defaults. Review paths, versions and permissions before approval.

## Human-gated installation

Model-created proposals are stored under `data/state/pending` and cannot execute. Approve from a separate human-operated command:

```powershell
node dist/src/admin.js approve <proposal-id> --state .\data\state --yes
```

Then call `catalog.reload` and `enable`. Prefer pinned package versions or immutable Git revisions; avoid floating `latest` installers in approved entries.

## Catalogs, secrets and skills

- MCP transports: `stdio` and `streamable-http`.
- Templates: `${catalogDir}`, `${packageDir}` and explicitly allowlisted `${config:key}` values.
- Secrets: environment-variable references only. Secret-like model configuration keys are rejected.
- Skills: approved local Markdown files, loaded on demand, limited to 256 KiB.
- State: runtime config and proposals are ignored by Git.

See [SECURITY.md](SECURITY.md) for the trust boundary.

## Current scope

- Tool calls are proxied; child MCP resources and prompts are not bridged yet.
- Reconnect is explicit: `disable`, then `enable`.
- Remote skill download, signature verification and sandboxed installers are future work.
- A model with unrestricted host shell access can bypass plugin-local policy; use Harness permissions as the outer boundary.

## Companion project

Want a compact animated desktop view of agents, context, models, reasoning and chat? See [DeepSeek Harness Widget](https://github.com/NeoXider/deepseek-harness-widget).

## Contributing

Issues and focused pull requests are welcome. New integrations should include a pinned example, a narrow permission description and an end-to-end test.

MIT © NeoXider
