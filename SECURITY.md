# Security policy

## Trust boundary

Capability Hub starts MCP servers as local processes. Treat every MCP command and every skill body as executable or trusted content.

- Model-created proposals are always stored as untrusted.
- Approval is available only through the separate human-operated admin command.
- Secrets are accepted only through named environment variables and are never returned to the model.
- Skill paths are resolved through `realpath` and must stay below the catalog/package root or a human-approved `skill.allowedRoots` directory; this also blocks `..` and symlink escapes.
- Avoid floating installers such as `npx -y package@latest` in approved entries. Pin a version or an immutable revision and review its source.

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include credentials, tokens, or private catalog contents in a report.
