# claude-mem-lite — установка и использование

Инструкция для Windows, macOS и Linux. Пути к папкам одинаковые на всех системах
(`~/.claude/skills/` и `~/.claude-mem-lite/`), различается только синтаксис команд:
в Windows примеры даны для PowerShell, в macOS/Linux — для bash/zsh.

## Установка (один раз, для всех проектов)

**1. Проверьте, что есть Node.js 22.13+ и Git:**

```bash
node --version
git --version
```

Если Node.js старый или отсутствует: macOS — `brew install node`, Ubuntu/Debian —
[NodeSource](https://github.com/nodesource/distributions) или `nvm`, Windows —
[nodejs.org](https://nodejs.org) или `winget install OpenJS.NodeJS.LTS`.
Node из репозитория Debian/Ubuntu часто устаревший — проверяйте версию после установки.

**2. Склонируйте плагин в папку, откуда Claude Code загружает плагины автоматически:**

macOS / Linux:

```bash
git clone git@github.com:MikhailS89/claude-mem-lite.git ~/.claude/skills/claude-mem-lite
```

Windows (PowerShell):

```powershell
git clone git@github.com:MikhailS89/claude-mem-lite.git "$env:USERPROFILE\.claude\skills\claude-mem-lite"
```

Если SSH-ключ к GitHub не настроен, используйте HTTPS-адрес:
`https://github.com/MikhailS89/claude-mem-lite.git`.

**3. Полностью перезапустите** VS Code (или терминал с Claude Code).

**4. Проверьте** в чате Claude Code: `/plugin` → в списке должен быть `claude-mem-lite`.

Первую сессию плагин только записывает; recap появится начиная со второй сессии в том же проекте.

## Откуда Claude Code загружает плагины автоматически

Без всяких установок и маркетплейсов Claude Code сам подхватывает плагины из двух папок с именем `skills`. Плагином считается любая подпапка, в которой есть файл `.claude-plugin/plugin.json`; она загружается под именем `<имя>@skills-dir`.

| Папка | Область | Когда загружается |
|---|---|---|
| `~/.claude/skills/` (Windows: `C:\Users\<вы>\.claude\skills\`) | личная | во всех ваших проектах — сюда и ставим claude-mem-lite |
| `<папка проекта>/.claude/skills/` | проектная | только в этом проекте и только после того, как вы подтвердите доверие к папке (trust dialog) |

Проектный вариант нужен, если плагин лежит в самом репозитории и должен достаться всем коллегам. Для личной памяти он не годится: память тогда работала бы только в одном проекте.

**Как убедиться, что именно загрузилось и откуда:**

- В чате Claude Code — команда `/plugin`: список плагинов, вкладка **Errors** покажет ошибки загрузки.
- В терминале — `claude plugin list`. Выводит имя, версию, область и **точный путь** к папке, откуда плагин взят, плюс статус `✔ loaded`:

  ```
  Skills-directory plugins (.claude/skills/*):
    ❯ claude-mem-lite@skills-dir
      Version: 0.6.1
      Scope: user
      Path: ~/.claude/skills/claude-mem-lite
      Status: ✔ loaded
  ```

**Если команда `claude` не найдена.** Она есть, только если Claude Code установлен как
самостоятельное приложение (тогда на macOS/Linux это обычно `~/.local/bin/claude`,
см. [инструкцию по установке](https://code.claude.com/docs/en/setup)). Если вы пользуетесь
только расширением для VS Code, бинарник лежит внутри расширения, и в его пути есть номер
версии, меняющийся при обновлениях. Найти актуальный и сразу выполнить команду:

macOS / Linux:

```bash
CLAUDE=$(ls -dt ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | head -1)
"$CLAUDE" plugin list
```

Windows (PowerShell):

```powershell
$claude = (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
& $claude plugin list
```

**Полезно знать:**

- Правки в `SKILL.md` подхватываются сразу; изменения в хуках (`hooks/`) — только после `/reload-plugins` или перезапуска Claude Code.
- Отключение и удаление — в разделе «Удалить плагин»: команды `uninstall` для таких плагинов не существует.

## Как это работает в повседневной работе

- **Ничего делать не нужно.** После каждого ответа Claude плагин обновляет запись о текущей сессии; при старте новой сессии, после `/clear` и после `/compact` Claude получает сводку последних 5 сессий этого проекта. Главное в ней — в каком виде оставлен проект: HEAD, «чисто» или список незакоммиченного (по `git status`), и не сдвинулся ли HEAD с тех пор. Дальше — работа по коммитам (отрезок = коммит, его файлы и сколько минут заняла работа), изменённые документы и файлы, которые не устоялись: созданные и удалённые, или к которым возвращались после другой работы.
- **Спросить про старое:** `/claude-mem-lite:mem-search <слова или имя файла>` — например `/claude-mem-lite:mem-search exercise-names` ответит, когда этот файл менялся в последний раз, в каком коммите и не переделывался ли потом. Без слов — покажет последнюю работу. Claude сам найдёт нужное и при необходимости запросит детали.
- **Скрыть кусок текста от памяти:** оберните его в `<private>…</private>` прямо в промпте.
- **Проект определяется по git remote**, поэтому клон того же репозитория в другой папке видит ту же память.

## Посмотреть / почистить данные

Всё хранится в `~/.claude-mem-lite/memory.db` (Windows: `C:\Users\<вы>\.claude-mem-lite\memory.db`).
Команды можно запускать из папки любого проекта — они смотрят на текущий каталог.

macOS / Linux:

```bash
m=~/.claude/skills/claude-mem-lite/scripts/search.mjs
node $m touched auth.ts        # когда в последний раз меняли файл и чем кончилось
node $m recent                 # последняя работа текущего проекта (по коммитам)
node $m recent --since 7d      # только за неделю (24h, 2w или дата 2026-09-01)
node $m --all recent           # по всем проектам
node $m login bug              # поиск по словам
node $m show ac6ab616          # сессия целиком (достаточно начала id)
node $m show e6b5545           # работа, которая закончилась этим коммитом
node $m projects               # какие проекты в памяти
node $m forget ac6ab616        # удалить одну сессию
node $m forget-project <id>    # удалить проект целиком (id из `projects`)
```

Windows (PowerShell) — те же подкоманды:

```powershell
$m = "$env:USERPROFILE\.claude\skills\claude-mem-lite\scripts\search.mjs"
node $m touched auth.ts
node $m recent
node $m --all recent
node $m login bug
node $m show ac6ab616
```

Отрезок (segment) — это работа до одного коммита: его сообщение, изменённые
файлы, запросы, которые к нему привели, и активное время (паузы длиннее 10 минут
не считаются).

Удалить всё:

```bash
rm -rf ~/.claude-mem-lite                                   # macOS / Linux
```
```powershell
Remove-Item -Recurse "$env:USERPROFILE\.claude-mem-lite"    # Windows
```

Удобно завести алиас, чтобы не писать длинный путь (macOS/Linux, в `~/.zshrc` или `~/.bashrc`):

```bash
alias mem='node ~/.claude/skills/claude-mem-lite/scripts/search.mjs'
```

## История файла при открытии

Когда Claude в сессии впервые читает или правит файл (`Read`, `Edit`, `Write`
или командой `cat` / `sed` в терминале), вместе с результатом он получает историю
этого файла из прошлых сессий, если она есть: последние коммиты с «почему»,
пометки о переделках. Так он видит, что прежний подход уже заменяли, до того как
начнёт менять файл, — без `git log` и поиска. Для файлов без истории (правки,
так и не попавшие в коммит, не в счёт) ничего не показывается, для каждого
файла — один раз за сессию.

Цена — примерно 0,2 секунды (запуск Node) на каждый `Read`/`Edit`/`Write` и на
команды `cat`/`sed`; остальные команды терминала хук не запускают. `head` и
`tail` не охватываются: обычно это фильтры вроде `npm test | tail -5`.
Если мешает, выключите: `"CLAUDE_MEM_LITE_FILE_HINTS": "false"` в `env` файла
`~/.claude/settings.json`.

## Сводки «что и почему» по коммитам (по желанию)

По умолчанию выключены. Если включить, у каждого коммита появляется короткая
заметка: тип, одно предложение «что сделано» и одно — «почему». Причину модель
берёт из разговора в окне этого коммита (ваши запросы и ответы Claude), а не
придумывает: если причину не называли, заметка так и говорит, и в сводке ничего
не показывается. В сводке при старте сессии «почему» стоит под коммитами
последней сессии:

```
  - 8d30976 Этап 4 завершён: черновики политики и оферты · 4 files · 4 min
    why: создать правовые тексты так, чтобы проверенные юристом не перезаписывались без --force
```

**Что это стоит.** Вызов идёт через ваш же Claude Code (`claude -p`, модель Haiku)
и расходует квоту вашей подписки или API-ключа: по замерам около $0,01–0,015 и
10–20 секунд на коммит. Работа идёт в фоне: хук запускает короткий отдельный
процесс и сразу возвращается, Claude Code ничего не ждёт.

**Что уходит в модель.** Сообщение коммита, имена его файлов, ваши запросы и
ответы Claude в окне коммита — после той же маскировки секретов и вырезания
`<private>…</private>`, что и всё остальное. Коммиты, в окне которых не было
разговора, не отправляются вовсе. Вызов идёт без инструментов, не сохраняется
как сессия (не появится в `--resume`), не загружает ваши настройки и хуки.

**Включить** — в `~/.claude/settings.json` (Windows: `C:\Users\<вы>\.claude\settings.json`):

```json
{
  "env": {
    "CLAUDE_MEM_LITE_LLM_SUMMARY": "true"
  }
}
```

и перезапустить VS Code. Выключить — `"false"` или удалить строку.
Сделать заметки для уже прошедших сессий: `node $m summarize --since 7d`
(или `node $m summarize <id сессии>`).

## Выключить

- **Для одного проекта:** создать пустой файл `<проект>/.claude-mem-lite/disabled`
  (и добавить `.claude-mem-lite/` в `.gitignore`):

  ```bash
  # macOS / Linux
  mkdir -p .claude-mem-lite && touch .claude-mem-lite/disabled
  ```

  ```powershell
  # Windows
  New-Item -ItemType Directory -Force .claude-mem-lite | Out-Null
  New-Item -ItemType File -Force .claude-mem-lite\disabled | Out-Null
  ```

- **Везде:** переменная окружения `CLAUDE_MEM_LITE_ENABLED=false`. Надёжнее всего прописать
  её в `~/.claude/settings.json` — тогда работает одинаково на всех ОС и в VS Code:

  ```json
  {
    "env": {
      "CLAUDE_MEM_LITE_ENABLED": "false"
    }
  }
  ```

- **Совсем удалить:** см. следующий раздел.

## Удалить плагин

**`claude plugin uninstall` здесь не работает** — и это не ошибка установки.
Эта команда существует только для плагинов, поставленных из маркетплейса. Наш
плагин вы просто положили папкой в `~/.claude/skills/`, никакой «установки» не
было, поэтому Claude Code отвечает:

```
× Failed to uninstall plugin "claude-mem-lite@skills-dir": This plugin is loaded
  from ~\.claude\skills/ with no marketplace backing — it cannot be uninstalled.
```

Правильные способы:

- **Временно отключить**, оставив файлы и накопленную память:

  ```bash
  claude plugin disable claude-mem-lite@skills-dir
  ```

  Включить обратно — `claude plugin enable claude-mem-lite@skills-dir`.
  Если команды `claude` нет в PATH — см. раздел «Откуда Claude Code загружает
  плагины автоматически»; либо просто пропишите `CLAUDE_MEM_LITE_ENABLED=false`
  в `~/.claude/settings.json`.

- **Удалить сам плагин** (память при этом сохранится):

  ```bash
  rm -rf ~/.claude/skills/claude-mem-lite                                   # macOS / Linux
  ```
  ```powershell
  Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\skills\claude-mem-lite"   # Windows
  ```

- **Удалить вместе с накопленной памятью** — дополнительно снести папку данных:

  ```bash
  rm -rf ~/.claude-mem-lite                                                 # macOS / Linux
  ```
  ```powershell
  Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-mem-lite"           # Windows
  ```

После удаления перезапустите Claude Code. Никаких других следов не остаётся:
фоновых процессов нет, в проектах файлы не создаются (кроме маркера
`.claude-mem-lite/disabled`, если вы делали его сами).

## Обновить

1. Скачайте новую версию в папку плагина:

   ```bash
   git -C ~/.claude/skills/claude-mem-lite pull                     # macOS / Linux
   ```
   ```powershell
   git -C "$env:USERPROFILE\.claude\skills\claude-mem-lite" pull    # Windows
   ```

   Если вы запускали плагин через `claude --plugin-dir <папка>`, выполните
   `git pull` в той папке.

2. Перезапустите Claude Code (или VS Code). Если в новой версии менялись хуки
   (`hooks/hooks.json`), без перезапуска они не подхватятся; перезапуск
   ничего не стоит, поэтому делайте его всегда.

3. Проверьте версию: `claude plugin list` (см. «Как убедиться, что именно
   загрузилось» выше) должна показать новый номер в строке `Version:`.
   Номер текущей версии — в файле `.claude-plugin/plugin.json` репозитория.

База данных при обновлении не пересоздаётся, ваши сессии сохраняются. С версии
0.3.0 старые записи сами переводятся в новый формат: после каждого ответа Claude
плагин пересобирает по несколько старых сессий из их транскриптов, пока не
пройдёт все. Claude Code хранит транскрипты около 30 дней, поэтому сессии старше
перевести не из чего — в сводке они помечены `legacy record` и выглядят как
раньше. Это не значит, что обновление не сработало. Перевести всё сразу, не
дожидаясь, можно командой `node <папка плагина>/scripts/search.mjs reindex`.

Плагин запускает `git status` после каждого ответа Claude (в фоне, не дольше
3 секунд), чтобы сводка знала, закоммичено ли всё. Если репозиторий огромный
и это заметно, отключите: `CLAUDE_MEM_LITE_GIT_STATUS=false` в `env`
файла `~/.claude/settings.json`.

Если `git pull` ругается на локальные изменения, значит файлы в папке плагина
правились вручную. Посмотрите их командой `git -C <папка плагина> status`;
если они не нужны, откатите их через `git -C <папка плагина> checkout -- .`
и повторите `pull`.

## Если что-то не так

- **Плагин не виден в `/plugin`** — проверьте, что папка лежит именно в `~/.claude/skills/`
  и внутри неё есть `.claude-plugin/plugin.json`, затем перезапустите Claude Code.
  Диагностика — в разделе «Откуда Claude Code загружает плагины автоматически».
- **Лог хуков:** `~/.claude-mem-lite/hooks.log`. Для подробностей задайте `CLAUDE_MEM_LITE_DEBUG=true`.
- **Сводка выглядит странно** (не те коммиты, лишние файлы) — прогоните транскрипт сессии
  через `replay`: команда покажет, что плагин записал бы и вспомнил, ничего не меняя в базе.
  Транскрипты лежат в `~/.claude/projects/<папка проекта>/<id сессии>.jsonl`.

  ```bash
  node ~/.claude/skills/claude-mem-lite/scripts/search.mjs replay <путь к .jsonl>
  ```
- **Хуки никогда не блокируют Claude Code:** при любой ошибке они молча выходят и пишут в лог.
- **Самопроверка** (тесты без сети):

  ```bash
  cd ~/.claude/skills/claude-mem-lite && npm test                  # macOS / Linux
  ```
  ```powershell
  cd "$env:USERPROFILE\.claude\skills\claude-mem-lite"; npm test   # Windows
  ```

- **Ошибка про `node:sqlite`** — значит Node.js старее 22.13. Обновите Node.
