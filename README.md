# my-bar

Кастомный бар для Hyprland на базе [AGS](https://github.com/Aylur/ags) + [Astal](https://github.com/Aylur/astal).

## Зависимости

- `aylurs-gtk-shell-git` (AUR) — тянет AGS + все libastal-*
- `dart-sass`
- `nodejs`, `npm` (для TS-подсказок)

## Установка

```bash
git clone git@github.com:username/my-bar.git ~/.config/ags
cd ~/.config/ags
ags types          # сгенерить TS-типы
ags run            # запустить
```

В `~/.config/hypr/hyprland.conf`:
```
exec-once = ags run
```

## Структура

- `app.ts` — точка входа
- `widget/` — виджеты
- `lib/` — утилиты
- `style.scss` — стили

## Лицензия

MIT