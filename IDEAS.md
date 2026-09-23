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
same session. Options, cheapest first:

- Also index a **trigram** copy of the text (`tokenize = 'trigram'` in a second
  FTS5 table) and fall back to it when the prefix query returns nothing. No
  dependencies, handles any language, costs disk.
- Strip common Russian/English endings before indexing and querying (a crude
  stemmer, ~30 lines). Cheap but produces false positives.
- Let the query try progressively shorter prefixes of each term (`кэша` →
  `кэш` → `кэ`) and stop at the first hit. No schema change, but ranking gets
  fuzzy.

Trigram fallback is probably the right call — see `ftsTerms()` and `search()`
in [src/db.mjs](src/db.mjs).

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

### 1.5 `SessionEnd` does not fire in `claude -p`

Sessions captured in print mode stay `status = 'active'` forever.
`isLikelyOpen()` in [src/recall.mjs](src/recall.mjs) papers over this by only
calling a session "possibly still open" for two hours, but the status column
itself is unreliable. Fix: on capture, mark any *other* `active` session of the
same project older than N hours as `ended` — a session that has not been
written to in hours is over.

### 1.6 One record per session, not per unit of work

A long session that goes through several stages is still one recap entry.
Since 0.2.0 the entry lists the session's commits, which already reads as
"stage 0: skeleton · stage 1: content model", so splitting the record itself
by commits was deliberately not done: the session row is upserted by id after
every turn, and splitting would change the data model for little extra value.
Revisit only if sessions with 20+ commits turn out to be common.

The feedback that led to 0.2.0 also warned against two tempting additions,
and both still stand: no "record a decision" command (it costs a tool call
and gets forgotten), and no extracting decisions from prose. Decisions live
in the repository's docs; the recap points at the docs that changed.

### 1.7 Low-value sessions take up recap slots

"Привет, напомни на чём остановились" — one prompt, zero tool calls — occupies
one of the five recap slots just like a session that edited 20 files. Fix:
score sessions (tool calls, files edited, duration) and either skip trivial
ones in the recap or merge consecutive ones from the same day.

---

## 2. Deferred stages from the original plan

### 2.1 LLM summarisation (PLAN.md stage 2)

Heuristic summaries answer *what was touched*, never *why*. One cheap Haiku
call at `SessionEnd` would turn the file/command list into two sentences of
intent.

Constraints agreed up front and still binding: off by default
(`CLAUDE_MEM_LITE_LLM_SUMMARY=true`), key from the user's own environment,
never bundled; falls back to the heuristic summary on any error; the raw
heuristic details stay in the database either way, so a bad summary is never
lossy. Store `summary_source = 'llm' | 'heuristic'` so the two are
distinguishable.

Worth doing only after a few weeks of real use show the heuristic recap is
actually too thin — it may not be.

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
- **`search.mjs stats`** — sessions per project, per week, busiest files.
- **Config file** as an alternative to ten environment variables
  (`~/.claude-mem-lite/config.json`), with env vars still winning.
- **Monorepo scoping.** One memory per repository; in a large monorepo,
  scoping by the subdirectory actually worked in would sharpen the recap. The
  hook receives `cwd`, so the data is there.

---

## 4. Testing and distribution

- **CI on macOS and Linux.** Everything was developed and tested on Windows.
  The path handling in [src/summarize.mjs](src/summarize.mjs) and
  [src/project.mjs](src/project.mjs) is the likeliest place for a
  platform-specific bug. A three-OS GitHub Actions matrix running `npm test` is
  half an hour of work and closes the biggest unknown in the project.
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
