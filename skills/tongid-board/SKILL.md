---
name: tongid-board
description: Use when an agent needs to inspect or operate the TongID application board (tasks) from a local machine.
---

# TongID Board

Use the TongID board REST API directly over HTTPS. This skill is not an MCP server.

## Local login (shared by every TongID skill)

The local Agent uses a TongID Bearer session, never an application credential. Every TongID skill shares one login session at `~/.tongid/agent/session.json`; the auth commands live in `scripts/tongid-auth.mjs` and are identical across skills.

1. Check the session first: `node scripts/tongid-auth.mjs whoami`. It prints the saved base URL and login time; on failure, log in.
2. Log in: `node scripts/tongid-auth.mjs login [--base-url URL]` (default `https://tongid.dev`; pass `http://localhost:3000` only for local development) and finish the browser login.
3. The helper listens only on `http://127.0.0.1:43173/tongid-skills/callback`; no application redirect-URI whitelist is required. It verifies state and PKCE before exchanging the code, then saves the session atomically (directory mode `0700`, file mode `0600`).
4. Every board command takes an explicit `--application-id app_xxx` for the target application. Application data is isolated per application; the skill never reads environment variables.

本机 Agent 不使用 Secret Key。`Authorization: Bearer <session-token>` 与 `x-tongid-application-id` 由 helper 自动发送；不要把 token 输出到聊天、源码或日志中。

Run `node scripts/tongid-auth.mjs logout` to remove the shared session. If login says port `43173` is occupied, close the process using that port and retry.

## Workflow

1. Check the session (`whoami`) before the first board call; log in if it fails.
2. For analysis, call stats first, then list board tasks with narrow filters when needed.
3. Before creating a task, read categories and tags only when the requested taxonomy matters. Omitting `--category-id` uses the application’s default `用户反馈` category.
4. Treat reply and status changes as writes. Make them only when the user clearly requests them, then state what changed after the call succeeds.
5. A reply is an internal TongID record; do not claim that an external reporter was notified.
6. On `401`, run `login` again. On `403`, the logged-in user lacks manager permission for the `--application-id` you passed; do not work around that boundary.
7. Explain `404`, `409`, rate-limit, and validation errors as returned; do not retry with guessed credentials or switch applications silently.

## Use the helper

Run from this skill directory:

    node scripts/tongid-auth.mjs whoami
    node scripts/tongid-auth.mjs login
    node scripts/tongid-board.mjs --application-id app_xxx stats
    node scripts/tongid-board.mjs --application-id app_xxx list --lane pending --page-size 25
    node scripts/tongid-board.mjs --application-id app_xxx create --title "导出失败" --content "点击导出后无响应" --source "lingoway-extension"
    node scripts/tongid-board.mjs --application-id app_xxx reply issue_yyy --content "已修复，等待验收" --author-name "研发团队"
    node scripts/tongid-board.mjs --application-id app_xxx move issue_yyy --lane review

Use `--help` for all commands. Read `references/tongid-board.json` for the exact shared API contract.

## API rules

- Base path: `/api/v1`; every caller uses the same `/issues*` routes.
- This local Agent must be a TongID workspace manager for the target application to list, analyze, reply, move, or modify board tasks.
- A regular application user may only create with Bearer + application ID. A guest may only create with application ID + its stable `guestId`; neither can query or manage board data.
- SDK and other backend services remain compatible with `x-tongid-secret-key`. That is a service-to-service authorization lane only; it must never be placed in the Agent or browser extension.
- New tasks start in `pending`; valid lanes are `pending`, `in_progress`, `review`, `done`, `closed`.
- Category and tag deletion is blocked while a task references the record.

## Common commands

    node scripts/tongid-auth.mjs login [--base-url URL] | whoami | logout
    node scripts/tongid-board.mjs --application-id app_xxx list [--search TEXT] [--lane LANE] [--category-id ID] [--tag-id ID] [--source SOURCE] [--page N] [--page-size N]
    node scripts/tongid-board.mjs --application-id app_xxx get ISSUE_ID
    node scripts/tongid-board.mjs --application-id app_xxx stats
    node scripts/tongid-board.mjs --application-id app_xxx categories list|create|rename|delete ...
    node scripts/tongid-board.mjs --application-id app_xxx tags list|create|rename|delete ...
    node scripts/tongid-board.mjs --application-id app_xxx board get|update [--enabled true] [--show-content false]
