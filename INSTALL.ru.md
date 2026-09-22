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
git clone git@github.com:MikhailS89/easy-claude-mem.git ~/.claude/skills/claude-mem-lite
```

Windows (PowerShell):

```powershell
git clone git@github.com:MikhailS89/easy-claude-mem.git "$env:USERPROFILE\.claude\skills\claude-mem-lite"
```

Если SSH-ключ к GitHub не настроен, используйте HTTPS-адрес:
`https://github.com/MikhailS89/easy-claude-mem.git`.

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
      Version: 0.1.0
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
- Временно отключить, не удаляя папку: `claude plugin disable claude-mem-lite@skills-dir`.
- Команды `uninstall` для таких плагинов нет — ничего не устанавливалось, достаточно удалить папку.

## Как это работает в повседневной работе

- **Ничего делать не нужно.** После каждого ответа Claude плагин обновляет запись о текущей сессии; при старте новой сессии (или после `/clear`) Claude получает сводку последних 5 сессий этого проекта.
- **Спросить про старое:** `/claude-mem-lite:mem-search <слова>` — например `/claude-mem-lite:mem-search nginx docker`. Без слов — покажет последние сессии. Claude сам найдёт нужную сессию и при необходимости запросит её детали.
- **Скрыть кусок текста от памяти:** оберните его в `<private>…</private>` прямо в промпте.
- **Проект определяется по git remote**, поэтому клон того же репозитория в другой папке видит ту же память.

## Посмотреть / почистить данные

Всё хранится в `~/.claude-mem-lite/memory.db` (Windows: `C:\Users\<вы>\.claude-mem-lite\memory.db`).
Команды можно запускать из папки любого проекта — они смотрят на текущий каталог.

macOS / Linux:

```bash
m=~/.claude/skills/claude-mem-lite/scripts/search.mjs
node $m recent                 # последние сессии текущего проекта
node $m --all recent           # по всем проектам
node $m login bug              # поиск по словам
node $m show ac6ab616          # детали сессии (достаточно начала id)
node $m projects               # какие проекты в памяти
node $m forget ac6ab616        # удалить одну сессию
node $m forget-project <id>    # удалить проект целиком (id из `projects`)
```

Windows (PowerShell) — те же подкоманды:

```powershell
$m = "$env:USERPROFILE\.claude\skills\claude-mem-lite\scripts\search.mjs"
node $m recent
node $m --all recent
node $m login bug
node $m show ac6ab616
```

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

- **Совсем удалить:** снести папку плагина `~/.claude/skills/claude-mem-lite` и папку данных `~/.claude-mem-lite`.

## Обновить

```bash
git -C ~/.claude/skills/claude-mem-lite pull                     # macOS / Linux
```
```powershell
git -C "$env:USERPROFILE\.claude\skills\claude-mem-lite" pull    # Windows
```

и перезапустить Claude Code (изменения в хуках без перезапуска не подхватываются).

## Если что-то не так

- **Плагин не виден в `/plugin`** — проверьте, что папка лежит именно в `~/.claude/skills/`
  и внутри неё есть `.claude-plugin/plugin.json`, затем перезапустите Claude Code.
  Диагностика — в разделе «Откуда Claude Code загружает плагины автоматически».
- **Лог хуков:** `~/.claude-mem-lite/hooks.log`. Для подробностей задайте `CLAUDE_MEM_LITE_DEBUG=true`.
- **Хуки никогда не блокируют Claude Code:** при любой ошибке они молча выходят и пишут в лог.
- **Самопроверка** (39 тестов, без сети):

  ```bash
  cd ~/.claude/skills/claude-mem-lite && npm test                  # macOS / Linux
  ```
  ```powershell
  cd "$env:USERPROFILE\.claude\skills\claude-mem-lite"; npm test   # Windows
  ```

- **Ошибка про `node:sqlite`** — значит Node.js старее 22.13. Обновите Node.
