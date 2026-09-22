# claude-mem-lite — установка и использование (Windows)

## Установка (один раз, для всех проектов)

1. Убедитесь, что есть Node.js 22.13+ и Git:
   ```powershell
   node --version
   git --version
   ```
2. Склонируйте плагин в папку, откуда Claude Code загружает плагины автоматически:
   ```powershell
   git clone git@github.com:MikhailS89/easy-claude-mem.git "$env:USERPROFILE\.claude\skills\claude-mem-lite"
   ```
3. Полностью перезапустите VS Code (или терминал с Claude Code).
4. Проверьте в чате Claude Code: `/plugin` → в списке должен быть `claude-mem-lite`.

Первую сессию плагин только записывает; recap появится начиная со второй сессии в том же проекте.

## Откуда Claude Code загружает плагины автоматически

Без всяких установок и маркетплейсов Claude Code сам подхватывает плагины из двух папок с именем `skills`. Плагином считается любая подпапка, в которой есть файл `.claude-plugin/plugin.json`; она загружается под именем `<имя>@skills-dir`.

| Папка | Область | Когда загружается |
|---|---|---|
| `C:\Users\<вы>\.claude\skills\` | личная | во всех ваших проектах — сюда и ставим claude-mem-lite |
| `<папка проекта>\.claude\skills\` | проектная | только в этом проекте и только после того, как вы подтвердите доверие к папке (trust dialog) |

Проектный вариант нужен, если плагин лежит в самом репозитории и должен достаться всем коллегам. Для личной памяти он не годится: память тогда работала бы только в одном проекте.

**Как убедиться, что именно загрузилось и откуда:**

- В чате Claude Code — команда `/plugin`: список плагинов, вкладка **Errors** покажет ошибки загрузки.
- В терминале — `claude plugin list`. Выводит имя, версию, область и **точный путь** к папке, откуда плагин взят, плюс статус `✔ loaded`:

  ```
  Skills-directory plugins (.claude/skills/*):
    ❯ claude-mem-lite@skills-dir
      Version: 0.1.0
      Scope: user
      Path: ~\.claude\skills\claude-mem-lite
      Status: ✔ loaded
  ```

**Если команды `claude` нет в PATH** (обычная ситуация, когда Claude Code используется только как расширение VS Code) — бинарник лежит внутри расширения, и в его пути есть номер версии, который меняется при обновлениях. Найти актуальный и сразу выполнить команду (PowerShell):

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

Всё хранится в `C:\Users\<вы>\.claude-mem-lite\memory.db`. Из терминала (в папке любого проекта):

```powershell
$m = "$env:USERPROFILE\.claude\skills\claude-mem-lite\scripts\search.mjs"
node $m recent                 # последние сессии текущего проекта
node $m --all recent           # по всем проектам
node $m login bug              # поиск по словам
node $m show ac6ab616          # детали сессии (достаточно начала id)
node $m projects               # какие проекты в памяти
node $m forget ac6ab616        # удалить одну сессию
node $m forget-project <id>    # удалить проект целиком (id из `projects`)
```

Удалить всё: `Remove-Item -Recurse "$env:USERPROFILE\.claude-mem-lite"`.

## Выключить

- Для одного проекта: создать пустой файл `<проект>\.claude-mem-lite\disabled` (и добавить `.claude-mem-lite/` в `.gitignore`).
- Везде: переменная окружения `CLAUDE_MEM_LITE_ENABLED=false` (например, в `~/.claude/settings.json` → `"env"`).
- Совсем удалить: снести папку плагина `~\.claude\skills\claude-mem-lite` и папку данных `~\.claude-mem-lite`.

## Обновить

```powershell
git -C "$env:USERPROFILE\.claude\skills\claude-mem-lite" pull
```

и перезапустить Claude Code.

## Если что-то не так

- Плагин не виден в `/plugin` — проверьте, что папка лежит именно в `C:\Users\<вы>\.claude\skills\` и внутри неё есть `.claude-plugin\plugin.json`, затем перезапустите Claude Code. Детали и диагностика — в разделе «Откуда Claude Code загружает плагины автоматически».
- Лог хуков: `~\.claude-mem-lite\hooks.log`. Для подробностей задайте `CLAUDE_MEM_LITE_DEBUG=true`.
- Хуки никогда не блокируют Claude Code: при любой ошибке они молча выходят и пишут в лог.
- Самопроверка: `cd ~\.claude\skills\claude-mem-lite; npm test`.
