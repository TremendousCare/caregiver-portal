#!/bin/bash
# SessionStart hook: ensures the Supabase MCP server is installed so Claude
# Code can connect to the project's Supabase instance.
#
# Why this exists:
#   The standard `npx @supabase/mcp-server-supabase@latest` spawn in .mcp.json
#   fails on fresh sandboxes because npx's cache resolution drops a transitive
#   dependency (@modelcontextprotocol/sdk). Pre-installing into a stable path
#   sidesteps that bug and makes startup deterministic.

set -euo pipefail

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

MCP_DIR="${HOME}/.mcp-servers"
MCP_BIN="${MCP_DIR}/node_modules/.bin/mcp-server-supabase"

# Install the Supabase MCP server if missing.
if [ ! -x "${MCP_BIN}" ]; then
  echo "[session-start] Installing Supabase MCP server into ${MCP_DIR}..." >&2
  mkdir -p "${MCP_DIR}"
  if [ ! -f "${MCP_DIR}/package.json" ]; then
    printf '{"name":"mcp-servers","version":"1.0.0","private":true}\n' > "${MCP_DIR}/package.json"
  fi
  (cd "${MCP_DIR}" && npm install --no-audit --no-fund \
    @supabase/mcp-server-supabase@latest \
    @modelcontextprotocol/sdk >&2)
fi

# Regenerate .mcp.json from the token env var if the file is missing.
# (The committed .mcp.json is gitignored to keep the token out of git, so fresh
# sandboxes arrive without it. If SUPABASE_ACCESS_TOKEN is set at the Claude
# Code project level, we recreate .mcp.json here.)
MCP_JSON="${CLAUDE_PROJECT_DIR}/.mcp.json"
if [ ! -f "${MCP_JSON}" ] && [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "[session-start] Writing .mcp.json from SUPABASE_ACCESS_TOKEN env var..." >&2
  cat > "${MCP_JSON}" <<EOF
{
  "mcpServers": {
    "supabase": {
      "command": "${MCP_BIN}",
      "args": [
        "--read-only",
        "--project-ref=zocrnurvazyxdpyqimgj"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "${SUPABASE_ACCESS_TOKEN}"
      }
    }
  }
}
EOF
fi

if [ ! -f "${MCP_JSON}" ]; then
  echo "[session-start] WARNING: .mcp.json is missing and SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "[session-start]          Supabase MCP tools will not be available this session." >&2
  echo "[session-start]          Set SUPABASE_ACCESS_TOKEN in Claude Code project settings," >&2
  echo "[session-start]          or paste the token in chat to have it restored." >&2
fi

echo "[session-start] Supabase MCP ready." >&2
