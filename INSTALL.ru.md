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

- Лог хуков: `~\.claude-mem-lite\hooks.log`. Для подробностей задайте `CLAUDE_MEM_LITE_DEBUG=true`.
- Хуки никогда не блокируют Claude Code: при любой ошибке они молча выходят и пишут в лог.
- Самопроверка: `cd ~\.claude\skills\claude-mem-lite; npm test`.
