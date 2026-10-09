/* Правила подписки для оценки «≈ N в день» — копия правил бота (car_filters.py,
 * этап 3 плана; сверка тестом на одной выборке). Решения владельца:
 *  - пробег не указан → объявление проходит фильтр «пробег до» (придёт с пометкой);
 *  - поле не указано продавцом (кузов, топливо…) → проходит;
 *  - привод и растаможка есть только на странице объявления → в оценке не учитываются;
 *  - руль: «Правый руль» в карточке, без пометки — левый (проверить на сайте);
 *  - слова и минус-слова — все слова фразы с начала слова, в любом порядке (matching.py).
 *  - в выборке приложения есть только название объявления (тексты продавцов не публикуем),
 *    поэтому оценка со словами — по названию; бот ищет слова и в тексте продавца.
 */
(function () {
  "use strict";

  function fold(text) { return String(text || "").toLowerCase().replace(/ё/g, "е"); }

  // «Priora 2170 (седан)» → «priora2170», «RAV 4» → «rav4» (как kolesa_card.model_key)
  function modelKey(text) { return fold(text).replace(/\([^)]*\)/g, "").replace(/[\s\-]+/g, ""); }

  // буква или цифра любого алфавита — как str.isalnum() в боте
  var LETTER = /[\p{L}\p{N}]/u;

  // слово запроса — с начала слова в тексте: граница — начало, не буква/цифра или переход буква↔цифра
  function hasWord(text, word) {
    var from = 0;
    for (;;) {
      var at = text.indexOf(word, from);
      if (at < 0) return false;
      if (at === 0) return true;
      var prev = text.charAt(at - 1), first = word.charAt(0);
      if (!LETTER.test(prev) || /[0-9]/.test(prev) !== /[0-9]/.test(first)) return true;
      from = at + 1;
    }
  }

  function phraseOk(text, phrase) {
    return fold(phrase).split(/\s+/).filter(Boolean).every(function (w) { return hasWord(text, w); });
  }

  function inList(list, value) { return !list || !list.length || !value || list.indexOf(value) >= 0; }

  /* sub — подписка в формате приложения (см. app.js), r — строка выборки как объект. */
  function matches(sub, r) {
    if (sub.b && r.brand !== sub.b) return false;
    if (sub.b && sub.m && sub.m.length) {
      var keys = sub.m.map(modelKey).filter(Boolean);
      if (r.model.charAt(0) === "~") {
        // модели в карточке нет — сравниваем с началом названия (как car_filters.model_ok)
        var tail = modelKey(r.model.slice(1));
        if (keys.length && !keys.some(function (k) { return tail.indexOf(k) === 0; })) return false;
      } else if (keys.length && keys.indexOf(modelKey(r.model)) < 0) return false;
    }
    if (sub.g === "r") { if (r.region !== sub.gv) return false; }
    else if (sub.g === "c") { if (r.city !== sub.gv) return false; }
    else if (r.region.indexOf("KZ-") !== 0) return false;     // весь КЗ: из-за рубежа — нет
    if (r.year) {
      if (sub.yf && r.year < sub.yf) return false;
      if (sub.yt && r.year > sub.yt) return false;
    }
    if (r.price) {
      if (sub.pf && r.price < sub.pf) return false;
      if (sub.pt && r.price > sub.pt) return false;
    }
    if (sub.km && r.km >= 0 && r.km > sub.km) return false;
    if (!inList(sub.bd, r.body) || !inList(sub.tr, r.transm) || !inList(sub.fu, r.fuel)) return false;
    if (sub.vf || sub.vt) {
      if (r.fuel === "6") return false;                     // электромобиль: объёма нет
      if (r.vol10) {
        if (sub.vf && r.vol10 < Math.round(sub.vf * 10)) return false;
        if (sub.vt && r.vol10 > Math.round(sub.vt * 10)) return false;
      }
    }
    if (sub.pv && (r.seller === 4 || r.seller === 7)) return false;   // салоны — как «От дилеров» сайта
    if (sub.nw === 1 && r.new === 0) return false;
    if (sub.nw === 2 && r.new === 1) return false;
    if (sub.sw === 1 && r.right === 1) return false;
    if (sub.sw === 2 && r.right !== 1) return false;
    var text = fold(r.words);
    if (sub.w && sub.w.length && !sub.w.some(function (p) { return phraseOk(text, p); })) return false;
    // минус-фраза — как в боте (matching.minus_ok): все её слова есть, в любом порядке
    if (sub.x && sub.x.some(function (p) { return phraseOk(text, p); })) return false;
    return true;
  }

  /* Сколько объявлений в день подходит: совпадения в выборке × множитель выборки. */
  function perDay(sub, sample) {
    var n = 0;
    for (var i = 0; i < sample.rows.length; i++) if (matches(sub, sample.rows[i])) n++;
    return n * sample.perDay;
  }

  /* строки выборки — массивы; поля по sample.fields, марка — индекс в brands.json */
  function prepareSample(raw, brands) {
    var f = raw.fields;
    return {
      perDay: raw.per_day,
      note: raw.note,
      rows: raw.rows.map(function (row) {
        var o = {};
        f.forEach(function (name, i) { o[name] = row[i]; });
        o.brand = brands[o.brand] ? brands[o.brand].n : "";
        return o;
      })
    };
  }

  window.KRMatch = { matches: matches, perDay: perDay, prepareSample: prepareSample, modelKey: modelKey, fold: fold };
})();
