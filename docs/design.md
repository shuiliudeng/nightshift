# Nightshift design

Nightshift is a small, always-on agent that turns authorized GitHub issue
comments into isolated coding tasks and delivers the result as a pull request.
It is a deliberate reduction of the ideas in
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype):
keep the domain loop, replace the host with OpenCode, and make the whole thing
runnable from a single Node process.

## Goals

- **Always on.** A long-lived daemon polls one repository and drains a durable
  queue.
- **Auditable delivery.** Every change lands on its own branch in its own
  worktree; the harness commits, pushes, and opens the PR.
- **Idempotent intake.** Replaying a poll never creates duplicate work.
- **Small surface.** No runtime dependencies, no build step, one config file,
  one SQLite database.
- **Safe defaults.** Only allowlisted humans who explicitly mention the bot can
  start work; the bot ignores itself and other bots.

Non-goals: multi-repository operation, multiple sources (Slack, Discord, mail),
scheduled or self-initiated work, and a web UI. Those are good extensions, but
they are not needed to prove the loop.

## Layers

```
src/
  cli.ts        command parsing, wiring, doctor
  daemon.ts     poll loop, cursor, worker pool, shutdown
  intake.ts     trigger -> policy -> ticket
  policy.ts     mention parsing and authorization
  github.ts     gh api polling, issue lookup, comments, PR lookup
  ticket.ts     one ticket: worktree -> agent -> commit -> push -> PR -> reply
  opencode.ts   resolve the binary, run it, parse its JSON event stream
  prompt.ts     worker prompt and comment templates
  git.ts        clone, worktree, commit, push, PR, diff stat
  db.ts         SQLite schema and CRUD
  config.ts     load, validate, defaults
  types.ts      Trigger, Ticket, AgentRunResult
  log.ts        leveled logger on stderr
```

Dependencies point downward: `cli` → `daemon` → `intake`/`ticket` → `github`/
`git`/`opencode` → `db`/`config`/`types`. There is no plugin system and no
dependency injection container; the config object is passed explicitly.

## Domain model

The original project separates a **Trigger** (something observed), an
**Assignment** (a decision to act), and a **Ticket** (the durable work item).
Nightshift keeps the same shape with fewer nouns:

- **Trigger** — one immutable GitHub comment: id, thread (`owner/repo#n`), actor,
  raw text, url, timestamp.
- **Ticket** — one authorized request: id, trigger id, repo, issue, title,
  requester, branch, worktree, state, OpenCode session id, PR number/url,
  summary, error, timestamps.
- **State machine** — `queued → running → done | failed`, plus `stopped` reserved
  for a future graceful-cancel path. `retry` moves a terminal ticket back to
  `queued` and clears the previous outcome.

A ticket id is `t_` plus the first 10 hex characters of `sha1(triggerId)`. This
makes intake idempotent even if the process crashes between inserting the
trigger and creating the ticket.

## Polling and intake

The daemon stores `github.cursor` in the `meta` table. On first start it begins
one minute in the past, so a comment written just before launch is not lost,
without replaying the repository's history. Each poll:

1. `gh api --paginate --slurp repos/{repo}/issues/comments?since=<cursor>`.
2. Sort by `created_at`, map to triggers.
3. `INSERT OR IGNORE` each trigger; duplicates are skipped.
4. Apply policy: not the bot, not a `[bot]`, actor in `allowedLogins`, text
   mentions `@agentLogin` as a whole handle.
5. Skip comments on pull requests (they would recurse).
6. Read the issue for a title and create the ticket.

The cursor advances to the newest comment's timestamp **minus one second**.
Comments that share a timestamp are therefore re-read, and deduplication makes
the replay harmless. This is a deliberate trade of a little I/O for not losing
work at second granularity.

## Execution

`ticket.ts` is the whole delivery path:

1. Ensure a base clone exists (`gh repo clone` or `cloneUrl`), then `git fetch`.
2. Resolve the base branch: config, `origin/HEAD`, `gh repo view`, then `main`.
3. Create a worktree at `<workspaceDir>/<owner-repo>-<ticket>` on
   `nightshift/<ticket>` from `origin/<base>`. Stale worktrees and branches are
   removed first, so a retry starts clean.
4. Post an acknowledgement comment (optional).
5. Run `opencode run --dir <worktree> --model <model> --auto --format json`.
6. If the worktree is dirty, `git add -A`, commit with a generated subject and
   the agent's report, then either push + open a PR or stop (local mode).
7. Mark the ticket done and comment with the summary or the PR link.

The worker prompt instructs the model to make the smallest change, read the
repository first, run relevant checks, and **not** to commit, push, branch, or
open PRs. Git and GitHub writes belong to the harness, so a model mistake cannot
silently rewrite history or skip review.

`opencode run` is spawned without a shell, with `--format json`. The parser reads
one JSON event per line, keeps the last `sessionID`, and concatenates `text`
parts. The raw output is retained (truncated) for failure comments. On timeout
or abort, the process tree is killed with `taskkill /T /F` on Windows and
`SIGTERM` elsewhere.

## Delivery modes

- `pr` (default): push the branch and open a pull request whose body includes
  `Closes #<issue>` and the agent report. If a PR already exists for the branch
  (for example after a retry), reuse it.
- `local`: commit in the worktree and leave the branch local. This is useful for
  air-gapped evaluation and for the test suite.

`delivery.comment` controls all issue comments: acknowledgement, success, and
failure. Turning it off is useful when the bot account cannot comment.

## Persistence

SQLite via `node:sqlite`, WAL mode, one file at `<stateDir>/nightshift.db`:

- `trigger(id PK, source, thread, actor, text, url, at, received_at)`
- `ticket(id PK, trigger_id UNIQUE, repo, issue, title, requester, branch,
  worktree, state, session_id, pr, pr_url, summary, error, created_at,
  updated_at, started_at, ended_at)`
- `meta(key PK, value)`

No ORM, no migrations beyond `CREATE TABLE IF NOT EXISTS`. The schema is small
enough that a future migration can be a single `ALTER TABLE` guarded by a
`meta` version key.

## Failure handling

- **Poll failure:** logged and retried next interval; the cursor is unchanged.
- **Agent failure:** ticket becomes `failed` with a truncated error, and a
  failure comment is posted.
- **No changes:** ticket becomes `done` with the agent's explanation and no
  commit; the completion comment says no change was necessary.
- **Crash during a run:** on the next `run`/`once`, any ticket left `running` is
  requeued and logged; `nightshift retry <id>` remains available for explicit
  retries. `nightshift status` shows the queue at any time.
- **Shutdown:** `SIGINT`/`SIGTERM` abort the poll sleep and running agents; the
  daemon drains active workers before exiting.

## Why not reuse the original code?

The original is a research prototype with a richer domain (mandates, strengths,
assessments, event sourcing) and a host layer coupled to DSH sessions, clients,
and executors. Reusing `core`/`sources` would still require reimplementing the
host and adapting the model to a single-repository product. A focused rewrite is
smaller, easier to audit, and has no dependency on a fast-moving alpha API. The
concepts are credited; the code is independent.

## Verification

Automated:

```bash
npm run typecheck
npm test
```

The end-to-end tests create a temporary bare repository, clone it, and run a
fake OpenCode script (a `.mjs` file executed by the current Node) that writes a
file or fails on demand. They assert commit creation, no-change handling, and
failure reporting without calling a model or GitHub.

Manual, with a real model and a local bare remote:

1. Create a bare repository and a seed commit on `main`.
2. Point `cloneUrl` at it, set `delivery.mode` to `local`, and choose a model.
3. `nightshift inject --text "Add HELLO.md containing hello" --actor local --run`.
4. Check the ticket is `done`, the commit exists in the worktree, and the file
   content matches.

This exact flow was used during development with
`opencode/deepseek-v4.1-flash-free`: the agent created `HELLO.md`, the harness
committed it, and `nightshift status` reported the ticket as `done`.

## Roadmap

- A `stopped` path that cancels a running agent without marking it failed.
- PR comments as a second source (review feedback → follow-up ticket).
- Per-repository concurrency and a global queue.
- A `--dry-run` mode that prints the prompt and planned commands.
- Optional sandbox integration (container or worktree-only permissions).
