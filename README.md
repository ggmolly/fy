# fy

`fy` is a local diff review tool powered by `@pierre/diffs`.
It runs a Bun/Hono server bound to `127.0.0.1`, serves a React UI, and keeps
review state as JSON under `~/.cache/fy/`.

## Install

```bash
bun install
bun run build
```

## Usage

```bash
fy
fy --staged
fy --base origin/main
fy --pr 123
fy --patch path/to/file.patch
fy --repo ../some-repo --base origin/main
fy --no-open
fy --port 5179
```

The CLI chooses one normalized repo root at startup. API requests never accept
arbitrary filesystem paths; all Git commands run inside that repo root.

## Agent CLI

Codex can update review comments without editing JSON directly:

```bash
fy agent list --repo .
fy agent list --repo . --json
fy agent list --repo . --status open
fy agent next --repo .
fy agent next --repo . --json
fy agent prompt --repo .
fy agent prompt --repo . --mode questions
fy agent prompt --repo . --mode fixes
fy agent reply <comment-id> --repo . --body "Answer to the question."
fy agent resolve <comment-id> --repo .
fy agent resolve <comment-id> --repo . --body "Fixed by simplifying the branch selection."
fy agent reopen <comment-id> --repo .
fy agent delete <comment-id> --repo .
```

UI comments are created as `molly`. Agent replies default to `codex`.

## Review UX

- Select one or more diff lines to open an inline GitHub-style comment form.
- Use the file header comment button to leave a finding on the whole file.
- Comments are threaded: the UI can edit/delete the root comment, add replies,
  delete replies, and resolve/reopen the thread.
- The suggestion button inserts a `suggestion` fenced block using the selected code.
- The Codex prompt includes the selected range, selected code, suggestions,
  comment IDs, an instruction to use the `fy-review` Codex skill, and
  instructions to use `fy agent reply` or `fy agent resolve`.
- When open comments include questions ending in `?`, the UI exposes prompt
  modes for all comments, fixes only, or questions only.
- Click a finding in the floating findings panel to jump to the anchored line
  or file header in the diff.
- The sidebar renders a collapsible file tree with search, folder-level viewed
  toggles, generated badges, additions/deletions, and updated-since-viewed badges.
- Sidebar filters narrow to open, viewed, updated, commented, or generated files.
- The sidebar progress block shows viewed files, open comments, updated files,
  and outdated comments for the active comparison.
- File viewed state is stored by comparison and in a repo-level hash index, so
  unchanged files can stay viewed across comparisons while changed files are
  marked updated instead of staying silently viewed.
- New comments store the file diff hash; if the active file diff changes later,
  the comment is marked outdated.
- Generated and deleted files are marked viewed by default and collapse unless
  manually expanded.
- Auto-view glob rules are stored per repo in `~/.cache/fy` and can be edited
  from the sidebar.
- File headers can copy the path, open the file in `code --goto`, mark viewed,
  or start a file-level comment.
- Image, Markdown, and notebook files get lightweight inline previews backed by
  the local read-only blob API.
- The local watcher marks the refresh button when the active diff changes.
- Review comments changed outside the UI, such as `fy agent reply` or
  `fy agent resolve`, sync into the UI automatically without refreshing the
  active diff.

## Local Git API

- `GET /api/session`
- `GET /api/git/status`
- `GET /api/git/branches`
- `GET /api/git/remotes`
- `GET /api/git/refs`
- `GET /api/git/commits?ref=HEAD&limit=30`
- `GET /api/diff?working=true`
- `GET /api/diff?staged=true`
- `GET /api/diff?base=origin/main&head=HEAD`
- `GET /api/diff?base=origin/main&working=true`
- `GET /api/diff?commit=<sha>`
- `GET /api/files?base=origin/main&head=HEAD`
- `GET /api/blob?path=README.md&ref=working`
- `GET /api/review/viewed-index`
- `POST /api/review/viewed-index`
- `GET /api/review/auto-view-rules`
- `POST /api/review/auto-view-rules`
- `POST /api/open-in-editor`
- `GET /api/watch?working=true` streams local live events for the selected diff
  query without sending diff contents in the event payload. `diff-changed` marks
  the refresh button, and `review-changed` tells the UI to reload review comments.

## Development

```bash
bun run check
bun run build
bun src/cli/index.ts --repo . --no-open
```

`@pierre/diffs` exposes `CodeView` and `parsePatchFiles` in the installed
version, so `fy` uses those directly for parsing, rendering, line selection,
annotations, split/unified layouts, file-level preview annotations, and
virtualization. `@pierre/trees` is currently beta and oriented around a full
shadow-root file tree model; this version uses a small custom changed-file tree
instead.

## Review Export

Review state is keyed by comparison, such as `working`, `staged`,
`origin/main...HEAD`, `origin/main...working`, `commit-<sha>`, or `pr-123`.

`POST /api/export` writes:

- `~/.cache/fy/repos/<repo-hash>/exports/<comparison-hash>/review.json`
- `~/.cache/fy/repos/<repo-hash>/exports/<comparison-hash>/review.md`

The markdown includes repo/source metadata, a summary, review comments by file,
replies, and code context when available.

## Privacy

`fy` does not send repository content, diffs, review comments, or telemetry to any
remote service. The only network-style access is the local browser talking to
the local `127.0.0.1` server. For `--pr`, `fy` shells out to the authenticated
GitHub CLI (`gh`) in the selected repo.
