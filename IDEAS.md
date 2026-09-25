# Possible improvements

Ideas for later, roughly in the order they would pay off. Nothing here is
committed work. Measurements were taken on Windows 10 / Node 24 against a real
2.1 MB transcript (796 lines, 16 prompts, 128 tool calls) unless stated
otherwise.

Related: [PLAN.md](PLAN.md) holds the original design and the deliberate
exclusions; this file is what came out of actually building and using the MVP.

---

## 1. Known limitations worth fixing

### 1.1 Search misses inflected word forms

Queries are turned into FTS5 prefix terms (`"кэш"*`), so a **longer** query
form never matches a **shorter** stored word. Verified:

| Query | Stored text contains "кэш" | Result |
|---|---|---|
| `кэш` | yes | found |
| `кэша`, `кэшу` | yes | **not found** |
| `refactor` | "refactoring" | found |
| `parsers` | "parser" | **not found** |

This hits Russian hardest, where the same noun appears in several cases in the
same session.

**Done in 0.6.1** with a light stemmer applied to *query* terms only
([src/stem.mjs](src/stem.mjs)): `кэша` → `"кэш"*`, `parsers` → `"parser"*`.
Since every term is already a prefix match, the stem finds every form. No
schema change and no re-indexing of stored text. On a copy of the real
database: `кэша` 0 → 2 segments, `переводы` 1 → 4, `коммитов` 2 → 5.

The trigram fallback proposed here first would not have worked: a trigram
index finds the query as a *substring* of the text, and the failing case is
the opposite - `кэша` is not a substring of `кэш`.

Found on the way: SQLite's unicode61 tokenizer treats `ё` and `е` as different
letters, so `еще` did not find `ещё`. Indexed text and queries are now both
folded to `е`; databases indexed before are re-indexed once from their stored
rows (by `Stop` or the CLI, never by the hooks Claude waits on).

### 1.2 Subagent work is invisible

[src/transcript.mjs](src/transcript.mjs) skips every record with
`isSidechain: true`. A session where most of the work happened inside `Task`
agents records the user's prompts and almost nothing else. Fix: parse sidechain
records too, attribute them to the parent turn, and record them as
`agent:<type>` entries so the recap can say "3 subagents explored X".

### 1.3 `Stop` re-parses the whole transcript every turn

Parsing the 2.1 MB transcript takes **132 ms** (plus ~40 ms Node start-up).
That is fine today — the hook is `async` and never blocks — but the cost grows
linearly with session length, so a very long session pays it on every turn.

Fix: store the byte offset and line count already consumed for each session,
then `read` only the tail on the next run and merge into the stored details.
The session row is already an upsert, so only the parser needs to become
incremental.

### 1.4 No retention policy

The database grows forever. A session row costs about **11 KB** (the `details`
JSON dominates), so ~1 000 sessions ≈ 11 MB — not a real problem, but there is
currently no way to say "forget anything older than a year" short of
`forget-project`. Worth adding: `search.mjs prune --older-than 180d`, plus
`VACUUM` afterwards.

### 1.5 `claude -p`: background hooks are cut short

Measured with 0.2.1 and 0.3.0: in print mode Claude Code stops the async
`Stop` hook almost as soon as it prints its answer, so whether the last turn
of a `-p` session is recorded is luck, not speed (0.2.1 won the race once
at 65 ms and lost it in the next run). Since 0.3.0 the row is written first,
~30 ms after the hook starts, and `git status` only afterwards, which helps
but cannot guarantee it. A real fix would be a synchronous hook, which would
add latency to every interactive turn; not worth it for print mode.

Sessions captured in print mode also stay `status = 'active'` forever.
`isLikelyOpen()` in [src/recall.mjs](src/recall.mjs) papers over this by only
calling a session "possibly still open" for two hours, but the status column
itself is unreliable. Fix: on capture, mark any *other* `active` session of the
same project older than N hours as `ended` — a session that has not been
written to in hours is over.

### 1.6 Segments, and what "revisited" can and cannot tell

Done in 0.3.0, reversing the earlier call to keep one record per session: a
real two-day session with 16 commits and 90 files showed that a list of
commits without the files per commit does not answer "what happened around
stage 2". Sessions now hold segments (one per commit) in their own table.

Rework detection stays a heuristic. "Undone" (created then deleted, edits
discarded) is certain. "Revisited after moving on" cannot tell a decision
that did not settle from a core file that grows with every feature; the
first version flagged 8 files in this repository's own development session,
and ignoring docs-only commits as gaps brought it to 4, all of them genuine
returns but only one real rework. It is shown with counts, for the newest
session only. Telling the two apart needs the *why* - an LLM summary per
segment (§2.1) is the way to get it.

The feedback that led to 0.2.0 also warned against two tempting additions,
and both still stand: no "record a decision" command (it costs a tool call
and gets forgotten), and no extracting decisions from prose. Decisions live
in the repository's docs; the recap points at the docs that changed.

### 1.7 Edges of reading commits from `.git`

Commits on HEAD are read from loose objects only; decoding packfiles (deltas)
is not worth it for this. Fresh commits stay loose until `git gc`, so the walk
normally sees everything a session made, but after a `gc` it stops early and
the recap falls back to what the transcript printed. Other edges:

- A commit found on HEAD is attributed to a session only if it was made
  while one of that session's own committing git calls (`commit`, `merge`,
  `rebase`…) was running (0.2.1; before that, parallel sessions on one branch
  each claimed the other's commits). Consequence: commits typed by hand in a
  terminal belong to no session; they only show up as "HEAD moved".
- HEAD is read when the hook runs, so replaying or re-indexing an *old*
  transcript sees today's HEAD, not the one at the end of that session. Any
  migration of old rows must take "HEAD at end" from the session's last
  attributed commit (or leave it empty), not from `.git/HEAD`.
- Pack-index lookup (to drop commits made in other repositories) assumes
  SHA-1 `.idx` files; in a SHA-256 repository a packed commit counts as
  unknown and is dropped. Loose objects work for both.

### 1.8 Low-value sessions take up recap slots

"Привет, напомни на чём остановились" — one prompt, zero tool calls — occupies
one of the five recap slots just like a session that edited 20 files.

**Done in 0.6.2.** A session is trivial when it changed no project file, made
no commit, undid or revisited nothing, and had at most three prompts. The
recap skips trivial sessions (it looks four times further back to fill its
places with real work) and says in one line how many it passed over; if every
session is trivial it shows them as before. Longer talks without edits are
kept on purpose: a design discussion may be where something was agreed.
`recent` also leaves out talk-only segments (no commit, no files); search
still finds them. On the real database this removed the two
`claude plugin list` check-ins from the recaps of two projects.

### 1.9 File hints and shell reads

Measured on real sessions, Claude reads most files through Bash (`cat`,
`sed -n`): 11 `Read` calls out of 487 tool calls in one ApexFit session. Since
0.6.0 the hint hook also runs on Bash, but only for `cat` and `sed`, through
Claude Code's per-handler `if` filter (`"Bash(cat *)"`), so other commands
never start Node (verified: three commands, one hook run).

Left out: `head` / `tail`. In the same sessions they appeared 50-120 times,
almost always as pipeline filters (`npm test | tail -5`); `if` matches every
subcommand, so it cannot tell those from `head -40 file.ts`, and including
them would cost ~20-30 s of Node starts per session for few hints.

---

## 2. Deferred stages from the original plan

### 2.1 LLM summarisation (PLAN.md stage 2)

Done in 0.4.0 as commit notes (src/llm.mjs, src/notes.mjs). Measured on real
ApexFit commits: $0.01-0.015 and 10-20 s per commit, reasons found where the
conversation stated them, "not stated" where it did not. Original plan below.

Heuristic summaries answer *what was touched*, never *why*. Planned for 0.4.0:
one cheap Haiku call per segment (not per tool call, as the original does),
fed the segment's prompts, Claude's own explanations, its files and commit
subject, returning a type (feature, fix, decision, …) and two sentences of
what and why. The reason is taken from the conversation, where it was
actually stated, instead of being inferred from tool calls.

Run through `claude -p` on the user's existing subscription, so no API key.
Known trap, handled by the original separately: the nested `claude` process
runs our own hooks and would record itself and show up in `--resume`, so it
must run with the plugin disabled for that process.

Constraints agreed up front and still binding: off by default
(`CLAUDE_MEM_LITE_LLM_SUMMARY=true`); falls back to the heuristic record on
any error; the heuristic details stay in the database either way, so a bad
summary is never lossy; LLM text is marked as such.

### 2.2 MCP server (PLAN.md stage 3)

A stdio MCP server with `search` / `recent` / `get_details` would let Claude
query memory without the `mem-search` skill spawning a CLI process. It is
mostly a thin wrapper over [src/db.mjs](src/db.mjs).

Against it: the skill already works, and an MCP server's tool definitions cost
context in *every* session, whereas a skill costs almost nothing until invoked.
Only worth it if the skill turns out to be invoked constantly.

---

## 3. Quality of life

- **Relevance-ranked recall.** Recall is purely "5 newest". Boost sessions that
  touched files present in the current working directory, or that ran on the
  current git branch, and the recap gets noticeably more useful on a repo with
  parallel workstreams.
- **Branch awareness in the recap header** — "3 sessions on this branch, 9 on
  others".
- **Pinned notes.** `search.mjs note "the staging deploy needs VPN"` storing a
  manual entry that always appears in the recap. Covers the "things I keep
  re-explaining to Claude" case that transcripts cannot.
- **`mem-forget` skill** so deletion does not require dropping to a terminal.
- ~~**`search.mjs stats`**~~ — done in 0.7.0, aimed at the question that
  matters more than activity counts: is the memory used, and do sessions that
  start with a recap reach their first edit with fewer lookups. Still open:
  sessions per week and busiest files; and subagent sessions (§1.2) are not
  counted.
- **Config file** as an alternative to ten environment variables
  (`~/.claude-mem-lite/config.json`), with env vars still winning.
- **Monorepo scoping.** One memory per repository; in a large monorepo,
  scoping by the subdirectory actually worked in would sharpen the recap. The
  hook receives `cwd`, so the data is there.

---

## 4. Testing and distribution

- **CI on macOS and Linux.** Done in 0.6.3: `.github/workflows/test.yml` runs
  `npm test` on Ubuntu, macOS and Windows with Node 22.16 and 24. Running the
  suite on Linux first (Docker) found two things. 17 tests failed only because
  their fixtures were written as Windows paths (`C:\proj\src\a.ts` is not an
  absolute path on Linux); the plugin code itself was fine, and the fixtures
  are now built with the platform's own paths. And the documented minimum,
  Node 22.13, was wrong: Node's bundled SQLite has no FTS5 before 22.16 (nor
  in 23.4), so on 22.13-22.15 the plugin recorded nothing and only logged
  "no such module: fts5". The minimum is now 22.16 (or 24), and an older Node
  gets a clear "needs Node.js 22.16 or newer".
- **A fixture from a long real session** committed to `test/fixtures/` (with
  paths and text scrubbed) to guard against transcript-format drift when Claude
  Code changes its `.jsonl` shape.
- **Marketplace distribution.** Currently installed by cloning into
  `~/.claude/skills/`. A one-repo marketplace (`.claude-plugin/marketplace.json`)
  would make `claude plugin install` work and bring proper versioning — worth it
  only if other people start using it.

---

## 5. Still deliberately out of scope

Carried over from [PLAN.md](PLAN.md) §5 and unchanged: no cloud sync or
accounts, no telemetry, no Postgres, no multi-tenancy (teams / API keys /
audit log), no crypto token, no support for agents other than Claude Code, and
no background daemon or listening port. Vector search stays out too — fix
§1.1 first and see whether full-text is still the bottleneck.
