# Tremendous Care — Caregiver Portal

## CRITICAL: Production Safety Rules

This app is **live in production** and used by a real team. The owner is non-technical. Claude must act as the **senior developer, architect, and deployment manager** — proactively enforcing best practices and preventing mistakes that could break production.

### Development Workflow (MANDATORY)

1. **NEVER push directly to `main`** — Always create a feature branch (`feature/description`)
2. **ALWAYS open a Pull Request** — PRs trigger CI (tests + build) and Vercel preview deploys
3. **NEVER merge a PR with failing CI** — If tests or build fail, fix them first
4. **Run `npm test` before committing** — Catch issues locally before pushing
5. **Run `npm run build` before pushing** — Verify the production build works
6. **Write tests for new business logic** — Any new utility function or business rule gets a test
7. **Discuss plans before major features** — The user wants to understand and approve the approach

### Database Safety (MANDATORY)

- **NEVER DROP tables or DELETE rows** as part of development work
- **NEVER run destructive migrations** without explicit user approval
- **Add columns as nullable** — old code must continue working
- **All schema changes must be reviewed** before execution

### Deployment Rules

- `main` branch auto-deploys to production via Vercel — treat it as sacred
- Vercel preview deploys are created for every PR — use them to test before merging
- Edge Functions deploy via CLI: `npx supabase functions deploy <name> --no-verify-jwt`
- If a deploy breaks production, Vercel dashboard allows instant rollback to previous deployment

### Testing

- **Framework**: Vitest (config in `vitest.config.js`)
- **Test location**: `src/lib/__tests__/`
- **Commands**: `npm test` (CI), `npm run test:watch` (dev), `npm run test:ui` (browser UI)
- **Current coverage**: 74 tests across utils, automations, actionEngine
- **Rule**: New utility/business logic functions MUST have tests before merging

### CI Pipeline

GitHub Actions runs on every PR to `main` (`.github/workflows/ci.yml`):
1. Install dependencies
2. Run all tests
3. Build the app

If any step fails, the PR is blocked.

## Project Overview

- **Supabase Project ID**: `zocrnurvazyxdpyqimgj`
- **Production URL**: `https://caregiver-portal.vercel.app`
- **Stack**: React 18 + Vite + Supabase + Vercel

## Key Conventions

- **Notes format**: Array of objects `{text, type, timestamp, author, outcome, direction}` — never strings
- **Tasks format**: Flat `{taskId: {completed, completedAt, completedBy}}` — never nested
- **AI chat deploys via CLI**, not MCP tool: `npx supabase functions deploy ai-chat --no-verify-jwt`
- **Edge Functions not in git** (except ai-chat): outlook-integration, docusign-integration, execute-automation, automation-cron, sharepoint-docs, get-communications
