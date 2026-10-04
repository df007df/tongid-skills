---
name: tongid-board
description: Use when an agent needs to inspect or operate the TongID application board (tasks) from a local machine.
---

# TongID Board

Use the TongID board REST API directly over HTTPS. This skill is not an MCP server.

## Local login

The local Agent uses a TongID Bearer session, never an application credential.

1. Set `TONGID_BASE_URL` to the TongID site origin, for example `https://tongid.example.com`.
2. Run `node scripts/tongid-board.mjs login` and finish the browser login.
3. The helper listens only on `http://127.0.0.1:43173/tongid-agent/callback`; no application redirect-URI whitelist is required. It verifies state and PKCE before exchanging the code.
4. For board operations, set `TONGID_APPLICATION_ID` to the target application. The local session is saved atomically at `~/.tongid/tongid-board/session.json` with directory mode `0700` and file mode `0600`.

本机 Agent 不使用 Secret Key。`Authorization: Bearer <session-token>` 与 `x-tongid-application-id` 由 helper 自动发送；不要把 token 输出到聊天、源码或日志中。

Run `node scripts/tongid-board.mjs logout` to remove the local session. If login says port `43173` is occupied, close the process using that port and retry.

## Workflow

1. For analysis, call stats first, then list board tasks with narrow filters when needed.
2. Before creating a task, read categories and tags only when the requested taxonomy matters. Omitting `--category-id` uses the application’s default `用户反馈` category.
3. Treat reply and status changes as writes. Make them only when the user clearly requests them, then state what changed after the call succeeds.
4. A reply is an internal TongID record; do not claim that an external reporter was notified.
5. On `401`, run `login` again. On `403`, the logged-in user lacks manager permission for `TONGID_APPLICATION_ID`; do not work around that boundary.
6. Explain `404`, `409`, rate-limit, and validation errors as returned; do not retry with guessed credentials or switch applications silently.

## Use the helper

Run from this skill directory:

    node scripts/tongid-board.mjs login
    node scripts/tongid-board.mjs stats
    node scripts/tongid-board.mjs list --lane pending --page-size 25
    node scripts/tongid-board.mjs create --title "导出失败" --content "点击导出后无响应" --source "lingoway-extension"
    node scripts/tongid-board.mjs reply issue_xxx --content "已修复，等待验收" --author-name "研发团队"
    node scripts/tongid-board.mjs move issue_xxx --lane review

Use `--help` for all commands. Read `references/tongid-board.json` for the exact shared API contract.

## API rules

- Base path: `/api/v1`; every caller uses the same `/issues*` routes.
- This local Agent must be a TongID workspace manager for the target application to list, analyze, reply, move, or modify board tasks.
- A regular application user may only create with Bearer + application ID. A guest may only create with application ID + its stable `guestId`; neither can query or manage board data.
- SDK and other backend services remain compatible with `x-tongid-secret-key`. That is a service-to-service authorization lane only; it must never be placed in the Agent or browser extension.
- New tasks start in `pending`; valid lanes are `pending`, `in_progress`, `review`, `done`, `closed`.
- Category and tag deletion is blocked while a task references the record.

## Common commands

    node scripts/tongid-board.mjs login|logout
    node scripts/tongid-board.mjs list [--search TEXT] [--lane LANE] [--category-id ID] [--tag-id ID] [--source SOURCE] [--page N] [--page-size N]
    node scripts/tongid-board.mjs get ISSUE_ID
    node scripts/tongid-board.mjs stats
    node scripts/tongid-board.mjs categories list|create|rename|delete ...
    node scripts/tongid-board.mjs tags list|create|rename|delete ...
    node scripts/tongid-board.mjs board get|update [--enabled true] [--show-content false]
