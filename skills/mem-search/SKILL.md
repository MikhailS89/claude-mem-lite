---
name: mem-search
description: Search the local claude-mem-lite memory of previous Claude Code sessions in this project - when a file was last touched and what came of it, the work done per commit, what the user asked, what was undone or revisited. Use when the user refers to earlier work ("as we did last time", "the file we changed yesterday", "continue what we started", "when did we do X") or before changing a file whose history matters.
allowed-tools: Bash(node *)
---

# mem-search

All data lives in a local SQLite file; nothing is fetched from the network.
Run the CLI with Bash and relay the relevant parts to the user. Start with the
narrowest command that answers the question, and `show` details only when
needed (this keeps context small).

Most answers are **segments**: the work up to one commit (its subject, the files
it changed, the prompts behind it, minutes of active work), or the uncommitted
tail of a session.

Base command (always quote the path — it may contain spaces):

```
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs" <subcommand> [flags]
```

Subcommands, most useful first:

- `touched <path-fragment>` — when a file was last changed, in which commit, and whether that work was later undone or revisited. The main question memory answers that git does not answer as directly.
- `<words...>` — full-text search over commit subjects, prompts and file paths.
- `recent [--limit N]` — newest segments first (`--sessions` for whole sessions).
- `show <session-id | commit sha>` — one session with all its segments, or the segment a commit belongs to (an 8-char id or 7-char sha prefix is enough).
- `projects` — all projects that have memory.
- `forget <session-id>` — delete a session (only when the user asks).

Flags: `--since 24h|7d|2w|YYYY-MM-DD` limits to recent work; `--all` searches every project instead of the current one; `--limit N`; `--json` for machine-readable output.

Workflow for a user request of `$ARGUMENTS`:

1. If `$ARGUMENTS` is empty, run `recent`. If it names a file or module, run `touched <name>`. Otherwise search with its words (drop stop words); if that returns nothing, retry with `--all`, then with fewer or more general words.
2. Pick the 1–3 segments or sessions that match and, if the listing is not enough, `show` them.
3. Answer from the results. Quote dates, commit shas and session ids so the user can dig further. "Revisited after moving on" is a hint that a decision may not have settled, not proof: check the commit or the docs it changed before relying on it. Do not paste raw JSON.
