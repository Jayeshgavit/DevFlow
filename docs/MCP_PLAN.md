# MCP integration plan (not implemented)

A local MCP server can expose the same Rust process registry to compatible AI coding clients. Start with stdio transport to avoid a network listener.

Read-only tools: `list_projects`, `get_project_status`, `get_logs(project_id,service_id,limit)`, `search_logs(project_id,query)`.

Security: require explicit local client configuration, restrict access to configured project IDs, scrub common secret patterns and environment values, cap log sizes, and never return entire `.env` contents. Do not allow arbitrary shell execution. Start/stop tools must require explicit approval and should not be available in the initial MCP release.

Client compatibility should be tested against the current official Codex and Claude MCP documentation at implementation time.
