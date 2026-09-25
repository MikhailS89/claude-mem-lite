# claude-mem-lite

Local, offline, auditable session memory for [Claude Code](https://code.claude.com).

At the end of every assistant turn the plugin compresses the current session's
transcript into a short record and stores it in a SQLite file on your machine.
A session is split into **segments, one per commit**: the commit, the files it
changed, the prompts behind it and how long it took. Around them it keeps the
state the work was left in (HEAD, anything uncommitted), which docs changed,
and which files did not settle (created and deleted again, or revisited after
moving on).
When you start a new session in the same project, a compact recap of the last
few sessions is injected into Claude's context, and a `mem-search` skill lets
Claude (or you) ask "when did we last touch this file, and what came of it?".

Inspired by [claude-mem](https://github.com/thedotmack/claude-mem), rebuilt from
scratch with a much smaller surface: **no network calls of its own, no
accounts, no daemons, no native modules, no dependencies.** (The one optional
exception, commit notes, goes through your own Claude Code; off by default.)
About 3 300 lines of plain, commented JavaScript you can audit in one sitting.

## Requirements

- Node.js **22.16+** or **24+** (uses the built-in `node:sqlite`, whose bundled
  SQLite has full-text search only from 22.16; tested on 22.16, 24 and on
  Windows, macOS and Linux in CI)
- Claude Code 2.1+
- macOS, Linux or Windows (developed and tested on Windows 10 + Node 24)

## Install

**Option A — permanent, auto-loaded** (recommended). Claude Code picks up any
plugin placed under `~/.claude/skills/` as `<name>@skills-dir`, on every
platform:

```bash
# macOS / Linux
git clone git@github.com:MikhailS89/claude-mem-lite.git ~/.claude/skills/claude-mem-lite
```

```powershell
# Windows (PowerShell)
git clone git@github.com:MikhailS89/claude-mem-lite.git "$env:USERPROFILE\.claude\skills\claude-mem-lite"
```

Restart Claude Code (or the VS Code extension). Confirm with `claude plugin list`
— it prints the path it loaded the plugin from and `Status: ✔ loaded`. Update
later with `git -C ~/.claude/skills/claude-mem-lite pull`, then restart Claude
Code and check the `Version:` line in `claude plugin list`. Updates keep the
database; after an upgrade to 0.3 older sessions are rebuilt in the new format
from their transcripts, a few per turn, as long as Claude Code still has the
transcript (it keeps them for 30 days by default). The rest stay as
`legacy record`s.

**Option B — try it for one session** without installing:

```bash
git clone git@github.com:MikhailS89/claude-mem-lite.git
claude --plugin-dir ./claude-mem-lite
```

Check that it is loaded with `/plugin` inside Claude Code. The first recap
appears in the *second* session you run in a project (there is nothing to
recall before that). Run `npm test` in the clone if you want to verify the
plugin on your machine before enabling it.

## What you get

**On `SessionStart`** (new session, `/clear`, or after `/compact`) Claude receives something like:

```
# claude-mem-lite: previous sessions in this project (ApexFit)
2 sessions stored locally. Newest first; a segment is the work up to one commit. ...
### 2026-09-22 16:04 · master · Маркетплейс для тренировок
- HEAD at end: e6b5545 (master), now 4443af4 · clean
- work (last 6 of 16 segments), oldest first:
  - a6ab2e4 Этап 3: проверка страниц каталога, две правки · 3 files · 10 min
  - 35c640c Этап 3 завершён: детальные страницы и SEO · 8 files · 18 min
  - efcceb5 Этап 4: права как код, API аккаунта, 152-ФЗ · 7 files · 15 min
  - 9a596d8 Этап 4: роль пользователя следует за статусом верификации · 5 files · 10 min
  - f885af2 Этап 4: страницы входа, регистрации, онбординга · 12 files · 8 min
  - e6b5545 Документация: синхронизация с этапом 4 · 2 files · 1 min
- docs changed: docs/ARCHITECTURE.md, docs/ROADMAP.md, README.md
- revisited after moving on: backend/scripts/lib/exercise-names.cjs (21 edits in 3 segments)
- last request: Спасибо за помощь
- session: 4b9aabea

### 2026-09-22 16:25 · master · …
- work (last 2 of 4 segments), oldest first:
  …
```

Five sessions, at most ~4 000 characters (~1 000 tokens); the newest in
detail, the older ones in two segments each. That is the whole per-session
cost of the plugin. Short sessions that changed nothing ("where did we
stop?", at most three prompts, no edits or commits) do not take a place; the
recap mentions them in one line at the end.

The recap describes where the work was left, not how busy the session was:

- **HEAD at end** is read from `.git` when the session last saved; for the
  newest session the recap adds `now <sha>` if HEAD has moved since. Next to
  it, `git status` from the same moment: `clean`, or `3 uncommitted: a, b, c`
  (including changes made outside the session; secrets like `.env` are counted
  but never named).
- **work** lists segments, one per commit, oldest first: the subject, how many
  project files it changed, and minutes of *active* work (pauses longer than
  10 minutes - a break, the night - are left out). What was changed after the
  last commit is an `uncommitted` segment with its files. A session in which no
  commit was found says `no commits recorded` and claims nothing more.
- **Commits** are the ones this session made: `git commit` output in the
  transcript (amends replace the original, failed commits are skipped, commits
  in another repository are dropped), plus commits read from `.git/objects`
  that were made while one of the session's own committing git commands ran
  (this catches `git commit -q`; commits from a parallel session or typed in
  a terminal are not attributed).
- **docs changed** (`docs/`, `*.md`, `*.rst`… inside the project): a doc edit
  usually records a decision, and the doc is where to read it.
- **undone** (certain) - files created in the session and deleted again, or
  whose edits were thrown away (`git restore`, `git checkout --`,
  `git reset --hard`). **revisited after moving on** (a hint) - code files
  returned to after other code work, with edit and segment counts. Docs, temp
  files and files that merely grow commit by commit are not flagged. Shown for
  the newest session only.
- Sessions without commits (a review, a discussion) also show a cleaned-up
  `outcome:` (Claude's last message cut at a sentence boundary).

**Commit notes (optional, off by default).** With
`CLAUDE_MEM_LITE_LLM_SUMMARY=true`, each commit also gets a note from a small
model: a type, one sentence of *what* and one of *why*. The reason is taken
from the conversation in that commit's window, where it was actually said,
not guessed from tool calls; when no reason was stated the note says so and
nothing is shown. The recap then carries it under the newest session's
commits:

```
  - 8d30976 Этап 4 завершён: черновики политики и оферты · 4 files · 4 min
    why: создать правовые тексты так, чтобы проверенные юристом не перезаписывались без --force
```

How it runs: after a turn with new commits, the `Stop` hook starts a
short-lived background process and returns at once; the process calls your
own Claude Code (`claude -p`, Haiku by default) once per commit, stores the
notes and exits. The call has no tools, is not saved as a session (it never
appears in `--resume`), loads none of your settings or hooks, and runs with
this plugin disabled so it cannot record itself. It uses your Claude
subscription or API key as Claude Code does; measured cost is about
**$0.01-0.015 and 10-20 seconds per commit**. What is sent: the commit
subject, its file names, your prompts and Claude's replies in that window,
after the same secret masking and `<private>` removal as everything stored.
Commits without any conversation in their window are not sent at all.
`search.mjs summarize` writes notes for past commits on demand.

**File history, when Claude opens a file.** The first time Claude reads or
edits a file in a session (`Read`, `Edit`, `Write`, `NotebookEdit`, or a shell
`cat` / `sed` of that file), the tool result carries that file's history from
earlier sessions, if it has any:

```
claude-mem-lite: src/db.mjs in earlier sessions (4 changes):
- 2026-09-24 f327421 feat: 0.4.0 commit notes - what and why per commit, via claude -p
- 2026-09-23 786ad2b feat: recap shows commits and git state ... - why: the plugin should show state, not activity
- revisited after moving on (23 edits in 3 segments) in session f2d518c0
- more: mem-search `touched src/db.mjs`
```

So before changing a file Claude sees that the last approach was replaced, or
why the current one was chosen, without running `git log` or searching.
Nothing is shown for files without history (edits that never reached a
commit do not count, unless they were undone or revisited), and each file is
shown once per session.

The hook must be synchronous for its output to reach Claude, so each call it
runs on waits for one Node start (~0.2 s here). For shell commands it runs
only on `cat` and `sed` (Claude Code's `if` filter), not on every command:
measured on real sessions, 20-70 such commands plus a handful of `Read` /
`Edit` calls, i.e. seconds over many hours. `head` / `tail` are left out on
purpose: they are mostly pipeline filters (`npm test | tail -5`), and a filter
cannot tell those from reading a file. Turn it off with
`CLAUDE_MEM_LITE_FILE_HINTS=false`.

**`/claude-mem-lite:mem-search <words>`** — the skill Claude uses to look
further back: `touched <file>` (when was it last changed, in which commit, and
did that work hold), full-text search over commit subjects, prompts and paths
(any word form finds the others - `кэша` finds `кэш`, `parsers` finds
`parser` - and `е` / `ё` are the same letter),
and `show` for one session or one commit. This is the "progressive
disclosure" idea from the original: a cheap index first, details on request.

**CLI** for the same thing from a terminal:

```bash
node scripts/search.mjs touched exercise-names   # when did we last change it, and what came of it
node scripts/search.mjs login bug                # search the current project
node scripts/search.mjs --all "docker nginx"     # search every project
node scripts/search.mjs recent --since 7d        # newest segments (--sessions: whole sessions)
node scripts/search.mjs show ac6ab616            # a session with all its segments
node scripts/search.mjs show e6b5545             # the segment of one commit
node scripts/search.mjs projects
node scripts/search.mjs forget ac6ab616          # delete one session
node scripts/search.mjs forget-project git:github.com/me/repo
node scripts/search.mjs where                    # db path + how the current project is identified
node scripts/search.mjs reindex                  # rebuild old-format sessions from transcripts now
node scripts/search.mjs stats --since 7d         # is the memory used, and does it change how work starts
node scripts/search.mjs summarize --since 7d     # write commit notes for past work (costs, see above)
node scripts/search.mjs replay ~/.claude/projects/<dir>/<session>.jsonl
                                                 # dry run: what the hooks would store and recall
                                                 # for a transcript, plus sanity checks; writes nothing
```

`--since` takes `24h`, `7d`, `2w` or a date (`2026-09-01`) and works with
`recent`, `touched`, `stats` and search.

**Is it worth it?** `stats` measures instead of guessing. From each session's
transcript it takes what Claude actually received (the recap and its size, file
hints), how often it looked something up with `mem-search`, and how work
started: tool calls before the first edit of a project file, and how many of
them were `git log` / `show` / `blame`, the lookups a recap is meant to
replace. Sessions that started with a recap are compared against those that
did not, including transcripts from before the plugin was installed (Claude
Code keeps them for 30 days). Sessions in the temp directory are experiments
and are left out, as are lookups against another database or through a
relative `scripts/search.mjs`, which is work on the plugin itself. It also
totals what commit notes cost.

```
claude-mem-lite usage: project git:github.com/me/repo, since 2026-09-18 13:03
Sessions: 7 (4 started with a recap)

Start of work, in sessions that edited project files:
                                            with recap     without
  sessions                                           3           2
  tool calls before the first edit (median)        14.0         5.5
  git log/show/blame before it (average)          0.33        0.00
  sessions that looked at git history                1           0

Memory lookups: 6 mem-search call(s) in 2 session(s) (recent 3, show 2, search 1)
File hints shown: 18 in 2 session(s)
Recap size: ~1126 chars (~322 tokens) on average
Commit notes: 35 written, $0.603 spent on model calls
```

The groups differ in more than the recap (the first session in a project has
none; long sessions explore more), so read the table as a trend over weeks
of ordinary work, not as a precise number.

## What is stored, and where

Everything lives in **`~/.claude-mem-lite/memory.db`** (plus `hooks.log`).
Nothing else is written anywhere, and nothing is sent anywhere - except,
when you turn commit notes on, the per-commit text described above, sent to
the model through your own Claude Code.

Per session:

| Field | Source | Cap |
|---|---|---|
| title | Claude Code's own auto-generated session title | 120 chars |
| your prompts | text you typed (not what Claude Code injects: file attachments, IDE selections, system reminders) | last 30, 400 chars each |
| edited / read files | paths from `Read`/`Edit`/`Write`/`NotebookEdit` tool calls, relative to the project | 200 |
| commands | `Bash` command lines | last 40, 200 chars each |
| search patterns | `Grep`/`Glob` patterns | 20 |
| commits | `[branch sha] subject` lines printed by `git` commands in the session, plus commits on HEAD made during the session's own committing git calls (from `.git`) | last 30, 120 chars each |
| segments | per commit: subject, files edited in that window, the prompts in it, active minutes | 60 files, 10 prompts each |
| rework | files undone (created then deleted, edits discarded) or revisited after moving on | |
| git state | HEAD branch and sha when the session last saved; `git status` at that moment (count + up to 10 paths, secrets only counted); files edited after the last commit | |
| outcome | first 600 chars of Claude's final message | 600 chars |
| stats | prompt count, tool call count, tools used, duration, branch | |

**Not stored:** file contents, tool outputs, diffs (`old_string`/`new_string`),
Claude's thinking, subagent activity. From tool results the plugin takes only
whether a call failed, when it finished, and the commit line above (output of
`Bash` calls that ran `git` is scanned for it in memory and discarded).

Projects are identified by the normalised git `origin` URL
(`git:github.com/owner/repo`, so ssh and https clones share memory), falling
back to the repository path, then to the working directory. Cloned the same
repo twice? Same memory.

## Privacy controls

- **`<private>…</private>`** in a prompt (or in a command) is removed before storage.
- **Sensitive file paths** are never recorded: `.env*`, `*.pem`, `*.key`,
  `id_rsa*`, `.npmrc`, `.netrc`, `credentials*`, anything under `.ssh/`,
  `.aws/`, `.gnupg/`, `.kube/`, `.docker/` … (full list in
  [src/privacy.mjs](src/privacy.mjs)). Templates like `.env.example` are fine.
- **Secret-looking strings** in prompts, commands, commit subjects and outcomes are masked:
  Anthropic/OpenAI/GitHub/GitLab/Slack/AWS/Google/npm token formats, JWTs,
  `Bearer …` headers, `user:password@host` URLs, `password=…` / `api_key: …`
  pairs, PEM private keys.
- **Turn it off** globally with `CLAUDE_MEM_LITE_ENABLED=false`, or for one
  project by creating the empty file `<project>/.claude-mem-lite/disabled`.
- **Delete** a session or a project with `forget` / `forget-project`, or
  everything with `rm -rf ~/.claude-mem-lite`.

The filters are heuristics. If you paste a secret into a prompt in an unusual
format, assume it may be stored — wrap it in `<private>` or delete the session.

Emoji and other characters outside the Basic Multilingual Plane are shown as
`•` in the recap. A cut through such a character leaves half of a UTF-16
surrogate pair, which the API rejects for the rest of the session, so the
recap never contains any.

## How it works

```
Claude Code ──SessionStart──▶ scripts/session-start.mjs ──▶ reads SQLite, prints recap as additionalContext
            ──PostToolUse──▶ scripts/file-hint.mjs     ──▶ (Read/Edit/Write, cat/sed) a file's history, once per file
            ──Stop─────────▶ scripts/session-stop.mjs  ──▶ parses the session transcript (.jsonl),
            ──SessionEnd───▶ scripts/session-end.mjs   ──▶ compresses it, upserts one row per session
```

Capture does not use per-tool hooks: Claude Code already writes every tool
call to the transcript file, so the plugin re-reads that file after each turn
(≈150 ms including Node start-up, in the background). `Stop` and `SessionEnd`
run the same idempotent code; the only difference is that `SessionEnd` marks
the session as ended. The one per-tool hook, `PostToolUse` on file reads and
edits, only reads the database to show a file's history (below).

Everything about git is read straight from the files under `.git` (HEAD,
refs, loose commit objects, pack indexes) with one exception: `git status`,
because telling a modified file from an unmodified one means comparing the
index with the working tree. It runs only in the background `Stop` /
`SessionEnd` hooks, with a 3-second timeout, without taking optional locks
(`GIT_OPTIONAL_LOCKS=0`, so it cannot collide with your own git commands);
if git is missing or slow the recap simply has no worktree state. Set
`CLAUDE_MEM_LITE_GIT_STATUS=false` to turn it off.

After an upgrade that changes the record format, `Stop` also rebuilds up to 5
older sessions per turn from their transcripts until none are left
(`search.mjs reindex` does it in one go).

Hooks use the exec form (`node` + args, no shell), so paths with spaces and
Windows backslashes are not a problem. Every hook exits 0 no matter what
happens; failures are written to `~/.claude-mem-lite/hooks.log`.

Layout:

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             hook wiring
scripts/session-*.mjs        hook entry points (a few lines each)
scripts/search.mjs           CLI
src/config.mjs               env-driven settings
src/hook-io.mjs              stdin JSON in, JSON out, never fail
src/project.mjs              project identity, HEAD and recent commits, read from .git (no git spawn)
src/worktree.mjs             `git status` (the one git process), bounded and lock-free
src/transcript.mjs           .jsonl parser
src/privacy.mjs              <private>, sensitive paths, secret redaction, surrogate-safe text
src/summarize.mjs            heuristic compression
src/segments.mjs             segments between commits, active time, undone/revisited files
src/db.mjs                   node:sqlite schema, FTS5 search over sessions and segments
src/capture.mjs              Stop/SessionEnd body
src/reindex.mjs              rebuild rows written by older versions from transcripts
src/llm.mjs                  one isolated `claude -p` call per commit -> {type, what, why}
src/notes.mjs                which commits need a note; the background worker's loop
scripts/notes-worker.mjs     the short-lived background process that writes notes
src/hints.mjs                a file's history for the PostToolUse hook (scripts/file-hint.mjs)
src/recall.mjs               SessionStart recap
src/usage.mjs                per-session usage (recap, hints, lookups, start of work) and totals
src/stats.mjs                `search.mjs stats`: usage over the database and older transcripts
skills/mem-search/SKILL.md   the skill
test/                        node:test suite (npm test)
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEM_LITE_ENABLED` | `true` | `false` disables all hooks |
| `CLAUDE_MEM_LITE_DIR` | `~/.claude-mem-lite` | where `memory.db` and `hooks.log` live |
| `CLAUDE_MEM_LITE_GIT_STATUS` | `true` | `false` skips `git status` after each turn (for huge repositories) |
| `CLAUDE_MEM_LITE_LLM_SUMMARY` | `false` | `true` writes a what/why note per commit through `claude -p` (costs quota) |
| `CLAUDE_MEM_LITE_LLM_MODEL` | `haiku` | model for commit notes |
| `CLAUDE_MEM_LITE_FILE_HINTS` | `true` | `false` turns off file history on Read/Edit/Write (saves ~0.2 s per call) |
| `CLAUDE_MEM_LITE_CLAUDE_BIN` | auto | path to `claude` if it cannot be found (hooks get it from Claude Code; else `PATH`, else the VS Code extension) |
| `CLAUDE_MEM_LITE_RECALL_SESSIONS` | `5` | sessions in the SessionStart recap |
| `CLAUDE_MEM_LITE_CONTEXT_CHARS` | `4000` | hard cap on the recap size (at most 9000) |
| `CLAUDE_MEM_LITE_MAX_PROMPTS` / `_PROMPT_CHARS` | `30` / `400` | prompts kept per session |
| `CLAUDE_MEM_LITE_MAX_COMMANDS` / `_COMMAND_CHARS` | `40` / `200` | commands kept per session |
| `CLAUDE_MEM_LITE_MAX_FILES` | `200` | files kept per session |
| `CLAUDE_MEM_LITE_OUTCOME_CHARS` | `600` | length of the stored final message |
| `CLAUDE_MEM_LITE_DEBUG` | `false` | verbose `hooks.log` |

Set them in your shell profile or in Claude Code's `settings.json` under `"env"`.

## Known limitations

See [IDEAS.md](IDEAS.md) for what could be done about these and what else is on
the list.

- Without commit notes the record is heuristic: commits, files, prompts and
  state, not *why*. Notes find a reason only if it was said in the
  conversation. "Revisited after moving on" cannot tell rework from a file
  that simply grows with each feature; it is a pointer, with counts.
- The uncommitted tail of a session gets no note (there is no commit yet);
  it is noted once committed, if that happens in a session with notes on.
- Commits already packed by `git gc` cannot be read from `.git`; the recap then
  relies on what `git commit` printed in the transcript.
- In `claude -p` (print) mode Claude Code stops background hooks almost as
  soon as it exits, so the capture after the last answer is often cut short
  and that session may be missing or out of date (the row is written first,
  within ~30 ms, but that is not guaranteed to be enough). Interactive sessions are not
  affected: the hook has the time between turns, and `SessionEnd` (which
  runs in the foreground) captures the end.
- A segment lists the files edited in its window, which is not always exactly
  what its commit contained (a file can be edited before a commit and
  committed later). For the last commit this is corrected from `git status`;
  earlier segments stay approximate.
- Subagent (sidechain) activity is not recorded.
- `node:sqlite` is marked experimental by Node; the API used here (`DatabaseSync`,
  `prepare/run/get/all`) has been stable since Node 22.13, but its bundled
  SQLite lacks FTS5 before 22.16; on an older Node the hooks log
  "needs Node.js 22.16 or newer" and record nothing.

## Uninstall

`claude plugin uninstall` does **not** apply here — it only works for plugins
installed from a marketplace, and fails with *"loaded from ~/.claude/skills/
with no marketplace backing"*. A skills-directory plugin is removed by deleting
its folder:

```bash
rm -rf ~/.claude/skills/claude-mem-lite   # the plugin
rm -rf ~/.claude-mem-lite                 # the database and log
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\skills\claude-mem-lite"
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-mem-lite"
```

To keep the files but stop loading the plugin, use
`claude plugin disable claude-mem-lite@skills-dir` instead (re-enable with
`claude plugin enable`).

There are no other traces: no background
processes, no registry/launchd entries, no files in your projects (unless you
created a `.claude-mem-lite/disabled` marker yourself).

## Development

```bash
npm test                       # ~100 tests, a few seconds, no network
node scripts/search.mjs replay <transcript.jsonl>   # check a change against real sessions
claude plugin validate .       # manifest check
CLAUDE_MEM_LITE_DIR=/tmp/mem CLAUDE_MEM_LITE_DEBUG=1 claude --plugin-dir . -p "hello"
```

## Русский

Пошаговая инструкция по установке и использованию: [INSTALL.ru.md](INSTALL.ru.md).

Локальная память для Claude Code: после каждого хода ассистента плагин
раскладывает сессию на отрезки по коммитам (коммит, его файлы, запросы,
время работы) и запоминает, в каком виде оставлен проект (HEAD, незакоммиченное),
какие документы менялись и что переделывалось. При старте новой сессии в том
же проекте Claude получает краткую сводку (~1000 токенов), а skill
`/claude-mem-lite:mem-search` отвечает на «когда мы в последний раз трогали
этот файл и чем кончилось».

Безопасность: сам плагин ничего не отправляет в сеть (единственное исключение —
сводки коммитов, они по умолчанию выключены и идут через ваш же Claude Code),
нет аккаунтов, демонов и нативных модулей; содержимое файлов и вывод инструментов не сохраняются; пути к
секретам (`.env`, ключи, `.ssh/`) не записываются; токены и пароли в тексте
маскируются; `<private>…</private>` вырезается. Выключить:
`CLAUDE_MEM_LITE_ENABLED=false` или файл `<проект>/.claude-mem-lite/disabled`.
Удалить всё: `rm -rf ~/.claude-mem-lite`.
