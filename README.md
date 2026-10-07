# Мини-приложение бота Kolesa

Telegram Mini App без своего сервера (как в Perekup Radar): статическая страница, раздаётся
через GitHub Pages. Оформление «Трасса» (вариант B, выбран владельцем 07.10).

- `index.html`, `app.js`, `style.css` — страница; `i18n.json` — тексты ru/kk;
- `match.js` — правила подписки для оценки «≈ N в день» (копия правил бота, сверка тестом);
- `data/` — справочники и выборка: `dict.json` (регионы, кузов, КПП, топливо, привод),
  `brands.json`, `cities.json`, `sample.json` (выгрузка — `исследование/export_webapp.py`).

Настройки подписчика бот кладёт в адрес после `#s=` (на сервер не уходит), изменения
приходят боту через `Telegram.WebApp.sendData`. Без Telegram открывается демо.

Посмотреть локально: `python -m http.server 8770 --directory webapp` → http://localhost:8770
