# Nightshift

An always-on, proactive coding agent for **one GitHub repository**, built on
[OpenCode](https://opencode.ai). Mention the bot in an issue comment; Nightshift
opens a ticket, works in an isolated git worktree, commits the result, pushes a
branch, and opens a pull request.

The name is the idea: the agent works the night shift. It polls, picks up work,
and reports back while you are away.

```
issue comment "@nightshift-bot fix the flaky login test"
        │
        ▼
   poll (gh api)  ──►  policy (who may ask?)  ──►  ticket (SQLite)
                                                        │
                                                        ▼
                                            git worktree + branch
                                                        │
                                                        ▼
                                    opencode run --dir <worktree> --auto
                                                        │
                                            commit ─► push ─► PR
                                                        │
                                                        ▼
                                              reply on the issue
```

## Requirements

- **Node.js >= 22.18** (24.x recommended). Nightshift runs TypeScript directly
  with Node's built-in type stripping and stores state in the built-in
  `node:sqlite`; there are no runtime dependencies.
- **git**
- **GitHub CLI (`gh`)**, authenticated: `gh auth login -h github.com`
- **OpenCode** on `PATH` (`opencode --version`), with a configured model

`node:sqlite` still prints an `ExperimentalWarning` on some Node versions. It is
harmless; suppress it with `NODE_OPTIONS=--no-warnings` if you prefer.

## Quick start

```bash
# 1. Install the CLI from this checkout
npm install
npm link            # or: node src/cli.ts <command>

# 2. Create a config in your project directory
nightshift init --repo your-name/your-repo \
  --agent nightshift-bot \
  --allow your-name \
  --model opencode-go/glm-5.3

# 3. Verify the environment
nightshift doctor

# 4. Try one request without touching GitHub
nightshift inject --text "Add a CONTRIBUTING.md with a short guide" --actor your-name --run

# 5. Start the always-on loop
nightshift run
```

Before step 4, create a GitHub account or machine user for the bot (for example
`nightshift-bot`), invite it to the repository with **write** access, and make
sure the token used by `gh` can act as that account. The bot must be able to
push branches and open pull requests.

> **Security:** the token you run Nightshift with can push to the repository and
> the agent executes model-generated commands on your machine. Run it on a
> dedicated machine or container, keep `allowedLogins` small, and never put
> secrets in the repository. See [Security](#security).

## How it works

1. **Source.** Every `pollSeconds`, Nightshift asks GitHub for issue comments
   updated since the stored cursor (`gh api .../issues/comments?since=...`).
2. **Policy.** A comment becomes a trigger only if it mentions `agentLogin`,
   comes from a human on `allowedLogins`, and was not written by the bot itself.
   Duplicate comments are deduplicated in SQLite by comment id.
3. **Intake.** The issue is read, the request text is cleaned of the mention, and
   a ticket row is created. Ticket ids are derived from the trigger id, so
   replaying a poll is idempotent.
4. **Execution.** A worker creates a fresh git worktree on
   `nightshift/<ticket-id>` from `origin/<base>`, then runs
   `opencode run --dir <worktree> --model <model> --auto --format json`.
5. **Delivery.** If the worktree changed, Nightshift commits everything, pushes
   the branch, and opens a pull request (`delivery.mode: "pr"`) or leaves the
   commit local (`delivery.mode: "local"`). It then comments on the issue with
   the agent's report.
6. **Recovery.** State lives in SQLite. A crashed run leaves a `running` ticket;
   `nightshift retry <id>` puts it back in the queue.

The agent never commits, pushes, or opens pull requests itself. The harness owns
git and GitHub, which keeps the model's job small and the delivery path
auditable.

## Commands

| Command | Purpose |
| --- | --- |
| `nightshift init` | Write a starter `nightshift.config.json`. |
| `nightshift run` | Poll forever and execute tickets. |
| `nightshift once` | Poll once, run queued tickets, then exit. |
| `nightshift status [--all]` | Show ticket counts and recent tickets. |
| `nightshift inject --text "..." [--run]` | Queue a local request without GitHub. |
| `nightshift retry <ticketId> [--run]` | Re-queue a failed ticket. |
| `nightshift doctor` | Check Node, git, `gh` auth, config, and OpenCode. |
| `nightshift version` | Print the version. |

Global options: `--config <path>`, `--log debug|info|warn|error`. The
`NIGHTSHIFT_LOG` environment variable sets the default log level.

## Configuration

`nightshift.config.json` is found in the current directory or a parent. Relative
paths are resolved against the config file.

```json
{
  "repo": "your-name/your-repo",
  "agentLogin": "nightshift-bot",
  "allowedLogins": ["your-name"],
  "model": "opencode-go/glm-5.3",
  "baseBranch": "main",
  "maxWorkers": 1,
  "pollSeconds": 60,
  "workspaceDir": ".nightshift/workspaces",
  "stateDir": ".nightshift/state",
  "delivery": { "mode": "pr", "comment": true },
  "git": {
    "authorName": "Nightshift",
    "authorEmail": "nightshift@users.noreply.github.com"
  },
  "opencode": {
    "command": "",
    "agent": "",
    "extraArgs": [],
    "timeoutMinutes": 30
  },
  "prompt": { "extraInstructions": "" }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `repo` | required | Repository in `owner/name` form. |
| `agentLogin` | required | GitHub login the agent listens for in `@mentions`. |
| `allowedLogins` | required | Humans allowed to request work; `["*"]` allows anyone. |
| `model` | required | OpenCode model id, e.g. `opencode-go/glm-5.3`. |
| `baseBranch` | auto | Branch new work starts from. Empty means the remote default branch. |
| `maxWorkers` | `1` | Concurrent tickets (1–16). |
| `pollSeconds` | `60` | Poll interval (5–86400). |
| `workspaceDir` | `.nightshift/workspaces` | Base clone and worktrees. |
| `stateDir` | `.nightshift/state` | SQLite database. |
| `delivery.mode` | `"pr"` | `"pr"` pushes and opens a pull request; `"local"` only commits. |
| `delivery.comment` | `true` | Post acknowledgement, completion, and failure comments. |
| `git.authorName` / `authorEmail` | `Nightshift` / bot address | Commit identity. |
| `opencode.command` | auto | Path to the OpenCode binary or a wrapper script. |
| `opencode.agent` | none | OpenCode agent name passed with `--agent`. |
| `opencode.extraArgs` | `[]` | Extra arguments inserted before the prompt, e.g. `["--pure"]`. |
| `opencode.timeoutMinutes` | `30` | Hard timeout per ticket. |
| `prompt.extraInstructions` | `""` | Team-specific rules appended to the worker prompt. |
| `cloneUrl` | none | Optional git URL used instead of `gh repo clone` (SSH, local path, tests). |

## Security

Nightshift is a remote-control bridge between GitHub comments and an agent that
can edit files and run commands. Treat it accordingly.

- **Authorization is a mention plus an allowlist.** A comment must contain
  `@agentLogin` and come from a login in `allowedLogins`. The bot's own comments
  and other `[bot]` accounts are ignored, which prevents reply loops.
- **Prompt injection is possible.** Issue text is untrusted. The worker prompt
  tells the model to stay inside the checkout and to refuse unsafe requests, but
  a language model is not a security boundary. Run Nightshift in a container or
  a dedicated VM if the repository or its issue authors are not fully trusted.
- **The token is powerful.** `gh` needs `repo` scope to push and open pull
  requests. Use a dedicated bot account, and prefer a fine-grained token limited
  to the one repository.
- **Worktrees are not sandboxes.** `opencode run --auto` can execute commands with
  your user's permissions. Do not run it as an administrator, and do not keep
  unrelated secrets on the same machine.
- **Never commit secrets.** The agent is told not to touch credentials or CI
  configuration, but review every pull request before merging.

## Differences from `dsh-superagent-prototype`

Nightshift is an independent implementation inspired by the domain model of
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
(Trigger → Ticket → Assignment, policy admission, durable store). It does not
import or modify that project. The main differences:

- **Host layer:** OpenCode replaces the DSH sessions/executor/client stack.
- **Runtime:** Node 24 only, with built-in SQLite and TypeScript stripping; zero
  runtime dependencies and no build step.
- **Scope:** one GitHub repository and one delivery path (worktree → commit →
  PR), instead of a general multi-source proactive-agent framework.
- **State:** a small SQLite schema for triggers, tickets, and the poll cursor,
  rather than the original event-sourced domain store.
- **Prompt/execution:** each ticket is one `opencode run` process in its own
  worktree; the harness, not the model, owns git and GitHub writes.

See [docs/design.md](docs/design.md) for the architecture and the trade-offs.

## Development

```bash
npm install
npm run typecheck
npm test          # node --test "tests/*.test.ts"
```

Tests use a temporary bare git repository and a fake OpenCode script, so they do
not call a model or GitHub. A manual end-to-end check against a real model is
described in [docs/design.md](docs/design.md#verification).

## License

MIT. See [LICENSE](LICENSE).
