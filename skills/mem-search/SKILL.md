---
name: mem-search
description: Search the local claude-mem-lite memory of previous Claude Code sessions in this project (what was edited, which commands ran, what the user asked, how it ended). Use when the user refers to earlier work ("as we did last time", "the file we changed yesterday", "continue what we started") or asks what happened in a past session.
allowed-tools: Bash(node *)
---

# mem-search

All data lives in a local SQLite file; nothing is fetched from the network.
Run the CLI with Bash and relay the relevant parts to the user. Prefer the
compact index first, then `show` a specific session only when details are needed
(this keeps context small).

Base command (always quote the path — it may contain spaces):

```
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs" <subcommand> [flags]
```

Subcommands:

- `<words...>` — full-text search across titles, prompts, file paths, commands, commit messages and outcomes of past sessions in the current project.
- `recent [--limit N]` — newest sessions first.
- `show <session-id>` — full details of one session (an 8-char id prefix from the index is enough).
- `file <path-fragment>` — sessions that read or edited a matching file.
- `projects` — all projects that have memory.
- `forget <session-id>` — delete a session (only when the user asks).

Flags: `--all` searches every project instead of the current one; `--json` for machine-readable output; `--limit N`.

Workflow for a user request of `$ARGUMENTS`:

1. If `$ARGUMENTS` is empty, run `recent`. Otherwise run a search with the words from `$ARGUMENTS` (drop stop words). If it returns nothing, retry with `--all`, then with fewer/more general words.
2. Pick the 1–3 sessions that match what the user is asking about and, if the summary is not enough, run `show <id>` for them.
3. Answer the user's question from the results. Quote session dates and ids so they can dig further. Do not paste raw JSON.
