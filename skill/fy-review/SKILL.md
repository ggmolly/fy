---
name: fy-review
description: Address review comments created by the local fy diff viewer. Use when Codex is asked to inspect, answer, fix, resolve, reopen, or delete local fy review comments, comments exported from fy, or code-review prompts that mention `fy agent`, `~/.cache/fy`, comparison keys, or local review findings.
---

# fy Review

## Core Workflow

Use the `fy` CLI as the source of truth. Do not edit files under `~/.cache/fy` directly.

1. Inspect comments:

```bash
fy agent list --repo . --json
```

2. For each open comment, decide whether it is a question or an actionable code change.

3. If the comment is phrased as a question, answer it directly with the agent CLI and do not modify code for that item:

```bash
fy agent reply <comment-id> --repo . --body "..."
```

4. If the comment identifies a concrete bug or requests a clear code change, inspect the relevant files, implement the smallest fix, run focused checks, then resolve it:

```bash
fy agent resolve <comment-id> --repo . --body "Fixed by ..."
```

5. If a comment is stale, invalid, or intentionally not fixed, reply with the reasoning instead of silently ignoring it.

## Rules

- Treat `fy agent list --json` as authoritative for comment IDs, comparison keys, paths, ranges, selected code, replies, and status.
- Preserve the distinction between answering and changing code. Questions get replies; bugs get fixes plus resolution.
- Do not mark a comment resolved until the requested code change has actually been made or the resolution body explains why no code change is appropriate.
- Keep replies concise and specific enough for the reviewer to understand the decision.
- Run the relevant project checks after code changes, and mention failures or skipped checks in the final response.
- Avoid editing generated review JSON directly. Use `fy agent reply`, `fy agent resolve`, `fy agent reopen`, or `fy agent delete`.

## Useful Commands

```bash
fy agent list --repo .
fy agent list --repo . --json
fy agent reply <comment-id> --repo . --body "Answer..."
fy agent resolve <comment-id> --repo . --body "Fixed by ..."
fy agent reopen <comment-id> --repo .
fy agent delete <comment-id> --repo .
```
