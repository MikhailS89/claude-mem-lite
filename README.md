# claude-mem-lite

Local, offline, auditable session memory for [Claude Code](https://code.claude.com).

At the end of every assistant turn the plugin compresses the current session's
transcript into a short record (what you asked, which files were edited, which
commands ran, how it ended) and stores it in a SQLite file on your machine.
When you start a new session in the same project, a compact recap of the last
few sessions is injected into Claude's context, and a `mem-search` skill lets
Claude (or you) dig up older sessions on demand.

Inspired by [claude-mem](https://github.com/thedotmack/claude-mem), rebuilt from
scratch with a much smaller surface: **no network calls, no accounts, no
daemons, no native modules, no dependencies.** About 1 300 lines of plain,
commented JavaScript you can audit in one sitting.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`; tested on Node 24)
- Claude Code 2.1+

## Install

```bash
git clone <this repo> ~/claude-mem-lite

# Try it for one session:
claude --plugin-dir ~/claude-mem-lite

# Or make it permanent (loads automatically as claude-mem-lite@skills-dir):
mkdir -p ~/.claude/skills && cp -r ~/claude-mem-lite ~/.claude/skills/claude-mem-lite
```

Check that it is loaded with `/plugin` inside Claude Code. The first recap
appears in the second session you run in a project.

## What you get

**On `SessionStart`** (new session or `/clear`) Claude receives something like:

```
# claude-mem-lite: previous sessions in this project (shopkit)
12 sessions stored locally. Newest first. For details or to search older work use the `mem-search` skill.
### 2026-09-21 17:59 · main · Архитектура E-commerce проекта
- edited: AGENTS.md, CLAUDE.md, CONTEXT.md, shopkit-core/composer.json (+16 more)
- ran: git init, git commit, pnpm install, pnpm lint, docker (+9 more)
- last request: Понял, давай зафиксируем кэш
- outcome: Зафиксировано (`b886776`). CONTEXT.md — 53 строки: …
- session: ac6ab616 (20 prompts, 107 tool calls)
```

Five sessions, at most ~4 000 characters (~1 000 tokens). That is the whole
per-session cost of the plugin.

**`/claude-mem-lite:mem-search <words>`** — Claude searches the database
(full-text over titles, prompts, file paths, commands and outcomes), picks the
relevant sessions and, only if needed, pulls the full details of one of them.
This is the "progressive disclosure" idea from the original: a cheap index
first, expensive details only on request.

**CLI** for the same thing from a terminal:

```bash
node scripts/search.mjs login bug            # search current project
node scripts/search.mjs --all "docker nginx" # search every project
node scripts/search.mjs recent --limit 20
node scripts/search.mjs show ac6ab616        # full details (id prefix is enough)
node scripts/search.mjs file auth.ts         # sessions that touched a file
node scripts/search.mjs projects
node scripts/search.mjs forget ac6ab616      # delete one session
node scripts/search.mjs forget-project git:github.com/me/repo
node scripts/search.mjs where                # db path + how the current project is identified
```

## What is stored, and where

Everything lives in **`~/.claude-mem-lite/memory.db`** (plus `hooks.log`).
Nothing else is written anywhere; nothing is sent anywhere.

Per session:

| Field | Source | Cap |
|---|---|---|
| title | Claude Code's own auto-generated session title | 120 chars |
| your prompts | text you typed (not what Claude Code injects: file attachments, IDE selections, system reminders) | last 30, 400 chars each |
| edited / read files | paths from `Read`/`Edit`/`Write`/`NotebookEdit` tool calls, relative to the project | 200 |
| commands | `Bash` command lines | last 40, 200 chars each |
| search patterns | `Grep`/`Glob` patterns | 20 |
| outcome | first 600 chars of Claude's final message | 600 chars |
| stats | prompt count, tool call count, tools used, duration, branch | |

**Not stored:** file contents, tool outputs, diffs (`old_string`/`new_string`),
Claude's thinking, subagent activity, anything from tool results.

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
- **Secret-looking strings** in prompts, commands and outcomes are masked:
  Anthropic/OpenAI/GitHub/GitLab/Slack/AWS/Google/npm token formats, JWTs,
  `Bearer …` headers, `user:password@host` URLs, `password=…` / `api_key: …`
  pairs, PEM private keys.
- **Turn it off** globally with `CLAUDE_MEM_LITE_ENABLED=false`, or for one
  project by creating the empty file `<project>/.claude-mem-lite/disabled`.
- **Delete** a session or a project with `forget` / `forget-project`, or
  everything with `rm -rf ~/.claude-mem-lite`.

The filters are heuristics. If you paste a secret into a prompt in an unusual
format, assume it may be stored — wrap it in `<private>` or delete the session.

## How it works

```
Claude Code ──SessionStart──▶ scripts/session-start.mjs ──▶ reads SQLite, prints recap as additionalContext
            ──Stop─────────▶ scripts/session-stop.mjs  ──▶ parses the session transcript (.jsonl),
            ──SessionEnd───▶ scripts/session-end.mjs   ──▶ compresses it, upserts one row per session
```

There is no `PostToolUse` hook: Claude Code already writes every tool call to
the transcript file, so the plugin simply re-reads that file after each turn
(≈150 ms including Node start-up, runs in the background) instead of spawning
a process on every tool call. `Stop` and `SessionEnd` run the same idempotent
code; the only difference is that `SessionEnd` marks the session as ended.

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
src/project.mjs              project identity from .git/config (no git spawn)
src/transcript.mjs           .jsonl parser
src/privacy.mjs              <private>, sensitive paths, secret redaction
src/summarize.mjs            heuristic compression
src/db.mjs                   node:sqlite schema, FTS5 search
src/capture.mjs              Stop/SessionEnd body
src/recall.mjs               SessionStart recap
skills/mem-search/SKILL.md   the skill
test/                        node:test suite (npm test)
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEM_LITE_ENABLED` | `true` | `false` disables all hooks |
| `CLAUDE_MEM_LITE_DIR` | `~/.claude-mem-lite` | where `memory.db` and `hooks.log` live |
| `CLAUDE_MEM_LITE_RECALL_SESSIONS` | `5` | sessions in the SessionStart recap |
| `CLAUDE_MEM_LITE_CONTEXT_CHARS` | `4000` | hard cap on the recap size |
| `CLAUDE_MEM_LITE_MAX_PROMPTS` / `_PROMPT_CHARS` | `30` / `400` | prompts kept per session |
| `CLAUDE_MEM_LITE_MAX_COMMANDS` / `_COMMAND_CHARS` | `40` / `200` | commands kept per session |
| `CLAUDE_MEM_LITE_MAX_FILES` | `200` | files kept per session |
| `CLAUDE_MEM_LITE_OUTCOME_CHARS` | `600` | length of the stored final message |
| `CLAUDE_MEM_LITE_DEBUG` | `false` | verbose `hooks.log` |

Set them in your shell profile or in Claude Code's `settings.json` under `"env"`.

## Known limitations

- Summaries are heuristic (no LLM): a list of files and commands plus your
  last request and Claude's last message. Good enough to answer "what was I
  doing here?", not a narrative. An optional LLM summariser is a possible
  later stage, off by default.
- In `claude -p` (print) mode `SessionEnd` does not fire; the session is still
  captured by `Stop`, it just isn't marked as ended.
- Subagent (sidechain) activity is not recorded.
- `node:sqlite` is marked experimental by Node; the API used here (`DatabaseSync`,
  `prepare/run/get/all`) has been stable since Node 22.13.

## Uninstall

Remove the plugin directory (or run `claude plugin uninstall claude-mem-lite`)
and delete `~/.claude-mem-lite`. There are no other traces: no background
processes, no registry/launchd entries, no files in your projects (unless you
created a `.claude-mem-lite/disabled` marker yourself).

## Development

```bash
npm test                       # 39 tests, ~3 s, no network
claude plugin validate .       # manifest check
CLAUDE_MEM_LITE_DIR=/tmp/mem CLAUDE_MEM_LITE_DEBUG=1 claude --plugin-dir . -p "hello"
```

## Русский

Локальная память для Claude Code: после каждого хода ассистента плагин
сжимает транскрипт сессии (ваши запросы, изменённые файлы, команды, итог) в
одну запись в SQLite на вашей машине, а при старте новой сессии в том же
проекте подмешивает краткую сводку последних сессий (~1000 токенов). Skill
`/claude-mem-lite:mem-search <слова>` ищет по старым сессиям.

Безопасность: ничего не уходит в сеть, нет аккаунтов, демонов и нативных
модулей; содержимое файлов и вывод инструментов не сохраняются; пути к
секретам (`.env`, ключи, `.ssh/`) не записываются; токены и пароли в тексте
маскируются; `<private>…</private>` вырезается. Выключить:
`CLAUDE_MEM_LITE_ENABLED=false` или файл `<проект>/.claude-mem-lite/disabled`.
Удалить всё: `rm -rf ~/.claude-mem-lite`.
