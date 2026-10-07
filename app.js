/* Мини-приложение бота Kolesa — Telegram Mini App без своего сервера (как в Perekup Radar).
 *
 * Откуда данные:
 *   - настройки подписчика бот кладёт в адрес кнопки: #s=j.<base64 JSON> или
 *     #s=z.<base64 deflate-raw>. Хэш не уходит на сервер GitHub Pages;
 *   - справочники — статические data/*.json (исследование/export_webapp.py, потом — бот):
 *     dict.json (регионы, кузов, КПП, топливо, привод — ru/kk), brands.json (марки и модели),
 *     cities.json (города с регионом), sample.json (новые объявления для оценки «≈ N в день»).
 * Куда уходят изменения:
 *   - Telegram.WebApp.sendData(JSON одной операции) ≤ 4096 байт; Telegram закрывает
 *     приложение, бот отвечает в чате. Бот проверяет всё заново — здесь проверка для удобства.
 * Без Telegram (обычный браузер) — демо: пример подписок, вместо отправки — показ операции.
 *
 * Подписка (короткие ключи, как в состоянии от бота):
 *   i id, b марка ("" — любая), m модели ([] — все), g место "kz" | "r" (область) | "c" (город),
 *   gv код области (KZ-ALM) или город (almaty), yf/yt год, pf/pt цена, km пробег до,
 *   bd/tr/fu/dr коды кузова/КПП/топлива/привода, vf/vt объём, pv только частники,
 *   nw 0 любая / 1 новая / 2 с пробегом, sw руль 0/1 левый/2 правый, cu 1 — только растаможенные,
 *   w слова (фразы), x минус-слова, rp повторные публикации, p пауза, r счётчик правок.
 * Состояние: v, l язык, lim лимит подписок, u доступ до (unix), tr пробный (1/0),
 *   q тихие часы [с, до (минуты), "silent"|"hold"] или null, st.m медиана скорости (с), subs.
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  // initData пустой у приложения с кнопки клавиатуры (только с неё работает sendData),
  // поэтому Telegram узнаём по платформе: вне Telegram скрипт ставит «unknown»
  var inTelegram = !!(tg && (tg.initData || (tg.platform && tg.platform !== "unknown")));
  var M = window.KRMatch;

  var MAX_DATA = 4096;
  var MAX_WORD = 40;
  var MAX_WORDS = 10;
  var MAX_MINUS = 10;
  var QUICK_PRICES = [3e6, 5e6, 10e6, 15e6, 25e6];
  var QUIET_PRESETS = [[23 * 60, 8 * 60], [0, 7 * 60]];
  var TOP_BRANDS = 8;
  var TOP_MODELS = 8;
  var GROUND = "#F3F2EC";

  var i18n = null;      // {ru: {...}, kk: {...}}
  var dirs = null;      // справочники
  var sample = null;    // выборка для оценки
  var state = null;     // состояние от бота
  var lang = "ru";
  var stack = [];       // экраны: {name, ...}
  var dockAction = null;
  var app = document.getElementById("app");

  // ------------------------------------------------------------ тексты и числа

  function T(key, params) {
    var text = (i18n[lang] && i18n[lang][key]) || i18n.ru[key] || key;
    Object.keys(params || {}).forEach(function (name) {
      text = text.split("{" + name + "}").join(String(params[name]));
    });
    return text;
  }

  // 1 объявление, 3 объявления, 43 объявления, 52 объявления, 11 объявлений
  function plural(n, key) {
    var forms = T(key).split("|");
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return forms[0];
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return forms[1];
    return forms[2];
  }

  function number(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

  // 15000000 → «15 млн», 1500000 → «1,5 млн», 800000 → «800 000»
  function money(n) {
    if (n >= 1e6) return T("mln", { v: String(Math.round(n / 1e5) / 10).replace(".", ",") });
    return number(n);
  }

  function two(x) { return (x < 10 ? "0" : "") + x; }
  function timeText(minutes) { return two(Math.floor(minutes / 60)) + ":" + two(minutes % 60); }
  function dateText(unix) { var d = new Date(unix * 1000); return two(d.getDate()) + "." + two(d.getMonth() + 1); }
  function daysLeft(until) { return Math.max(0, Math.ceil((until * 1000 - Date.now()) / 86400000)); }

  function digits(text) {
    var clean = String(text || "").replace(/[^\d]/g, "");
    return clean ? parseInt(clean, 10) : null;
  }

  function decimal(text) {
    var v = parseFloat(String(text || "").replace(",", "."));
    return isNaN(v) ? null : Math.round(v * 10) / 10;
  }

  function name(item) { return item[lang] || item.ru; }

  // ------------------------------------------------------------ DOM

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  function add(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { add(el, c); }); return; }
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  var ICONS = {
    back: "M15 18l-6-6 6-6",
    plus: "M12 5v14M5 12h14",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    clock: "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 2.5M9 2h6",
    sign: "M12 2l10 10-10 10L2 12zM12 8v5M12 16h.01",
    up: "M6 15l6-6 6 6",
    down: "M6 9l6 6 6-6",
    right: "M9 6l6 6-6 6",
    check: "M5 12l5 5 9-10"
  };

  function icon(key, size, color, width) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", size || 20);
    svg.setAttribute("height", size || 20);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", color || "currentColor");
    svg.setAttribute("stroke-width", width || 2);
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[key]);
    svg.appendChild(path);
    return svg;
  }

  function switchBtn(on, label, onclick) {
    return h("button", { class: "switch", type: "button", role: "switch", "aria-checked": on ? "true" : "false",
                         "aria-label": label, onclick: onclick },
      h("span", { class: "track" }, h("span", { class: "knob" })));
  }

  function chip(text, pressed, onclick, extra) {
    return h("button", { class: "chip" + (extra ? " " + extra : ""), type: "button",
                         "aria-pressed": pressed ? "true" : "false", onclick: onclick }, text);
  }

  function header(title, right) {
    var left = h("div", { class: "left" });
    if (stack.length > 1 && !inTelegram) {
      left.appendChild(h("button", { class: "back", type: "button", "aria-label": T("back"), onclick: pop },
        icon("back", 24, null, 2.4)));
    }
    left.appendChild(h("h1", { text: title }));
    return h("div", { class: "head" }, left, right || null);
  }

  // ------------------------------------------------------------ Telegram и навигация

  function setDock(text, action, enabled) {
    var dock = document.getElementById("dock");
    var button = document.getElementById("dock-button");
    button.textContent = "";
    if (action === openNew) button.appendChild(icon("plus", 20, null, 2.6));
    button.appendChild(document.createTextNode(text));
    button.disabled = enabled === false;
    dockAction = action;
    dock.hidden = false;
  }

  function hideDock() { document.getElementById("dock").hidden = true; dockAction = null; }

  function updateBack() {
    if (!inTelegram) return;
    if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
  }

  function confirmAsk(text, then) {
    if (inTelegram && tg.showConfirm) tg.showConfirm(text, function (ok) { if (ok) then(); });
    else if (window.confirm(text)) then();
  }

  function haptic(kind) {
    if (!inTelegram || !tg.HapticFeedback) return;
    if (kind === "error") tg.HapticFeedback.notificationOccurred("error");
    else tg.HapticFeedback.selectionChanged();
  }

  function push(screen) { stack.push(screen); render(); window.scrollTo(0, 0); }
  function pop() { if (stack.length > 1) { stack.pop(); render(); } }
  function top() { return stack[stack.length - 1]; }

  function render() {
    var screen = top();
    if (screen.name !== "settings") lang = i18n[state.l] ? state.l : "ru";
    document.documentElement.lang = lang === "kk" ? "kk" : "ru";
    app.innerHTML = "";
    hideDock();
    updateBack();
    SCREENS[screen.name](screen);
  }

  // ------------------------------------------------------------ отправка боту

  function send(op) {
    var text = JSON.stringify(op);
    if (new TextEncoder().encode(text).length > MAX_DATA) { showError(T("err_too_big")); return; }
    haptic();
    if (inTelegram) { tg.sendData(text); return; }    // Telegram закроет приложение, бот ответит
    document.getElementById("demo-title").textContent = T("demo_sent");
    document.getElementById("demo-out").textContent = JSON.stringify(op, null, 2);
    document.getElementById("demo-close").textContent = T("close");
    var dialog = document.getElementById("demo-dialog");
    if (dialog.showModal) dialog.showModal(); else window.alert(text);
  }

  function showError(text) {
    var old = app.querySelector(".error.global");
    if (old) old.remove();
    app.appendChild(h("p", { class: "error global", role: "alert", text: text }));
    haptic("error");
  }

  // ------------------------------------------------------------ подписка: описание и оценка

  function regionName(code) {
    var r = dirs.regionBy[code];
    return r ? name(r) : code;
  }

  function cityName(slug) {
    var c = dirs.cityBy[slug];
    return c ? c.n : slug;
  }

  function placeText(sub) {
    if (sub.g === "r") return regionName(sub.gv);
    if (sub.g === "c") return cityName(sub.gv);
    return T("kz");
  }

  function subTitle(sub) {
    if (!sub.b) return T("all_brands");
    if (!sub.m || !sub.m.length) return sub.b + " · " + T("all_models");
    return sub.b + " " + sub.m.join(", ");
  }

  function rangeText(from, to, one, keyFrom, keyTo, keyRange) {
    if (from && to) return T(keyRange, { a: one(from), b: one(to) });
    if (from) return T(keyFrom, { v: one(from) });
    if (to) return T(keyTo, { v: one(to) });
    return "";
  }

  function extrasCount(sub) {
    var n = 0;
    ["bd", "tr", "fu", "dr", "w", "x"].forEach(function (k) { if (sub[k] && sub[k].length) n++; });
    if (sub.vf || sub.vt) n++;
    ["pv", "nw", "sw", "cu", "rp"].forEach(function (k) { if (sub[k]) n++; });
    return n;
  }

  function subMeta(sub) {
    var parts = [placeText(sub)];
    parts.push(rangeText(sub.pf, sub.pt, money, "price_from", "price_to", "price_range"));
    parts.push(rangeText(sub.yf, sub.yt, String, "year_from", "year_to", "year_range"));
    if (sub.km) parts.push(T("km_to", { v: number(sub.km) }));
    var extra = extrasCount(sub);
    if (extra) parts.push(T("more_filters_n", { n: extra }));
    return parts.filter(Boolean).join(" · ");
  }

  function perDay(sub) { return M.perDay(sub, sample); }

  function roundDay(n) {
    if (n >= 1000) return number(Math.round(n / 100) * 100);
    if (n >= 100) return number(Math.round(n / 10) * 10);
    return number(Math.round(n));
  }

  function perDayText(n) { return n < 0.5 ? T("per_day_less") : T("per_day", { n: roundDay(n) }); }

  // ------------------------------------------------------------ главный экран

  function renderHome() {
    var subs = state.subs || [];
    app.appendChild(header(T("home_title"),
      h("button", { class: "icon-btn", type: "button", "aria-label": T("language"),
                    onclick: openSettings }, T("lang_btn"))));
    app.appendChild(accessCard());
    if (state.st && state.st.m) {
      app.appendChild(h("div", { class: "speed" }, icon("clock", 20, "#15181D"),
        h("span", { text: T("speed_line", { sec: state.st.m + " с" }) })));
    }
    app.appendChild(h("div", { class: "section" },
      h("span", { text: T("subs_head") }), h("span", { text: T("subs_count", { n: subs.length, lim: state.lim }) })));
    if (!subs.length) app.appendChild(h("p", { class: "empty", text: T("subs_empty") }));
    app.appendChild(h("div", { class: "subs" }, subs.map(subCard)));

    var q = state.q;
    app.appendChild(h("div", { class: "row-btns" },
      h("button", { type: "button", onclick: openSettings }, icon("moon", 18),
        q ? T("quiet_btn_on", { from: timeText(q[0]).slice(0, 2), to: timeText(q[1]).slice(0, 2) }) : T("quiet_btn")),
      h("button", { type: "button", onclick: openSettings }, icon("gear", 18), T("settings_btn"))));

    var full = subs.length >= state.lim;
    setDock(full ? T("limit_reached") : T("add_sub"), openNew, !full);
  }

  function accessCard() {
    var now = Date.now() / 1000;
    var active = state.u && state.u > now;
    if (!active) {
      return h("div", { class: "access off" },
        h("div", { class: "txt" }, h("span", { class: "big", text: T("access_none") })),
        h("button", { class: "pay", type: "button", onclick: function () { send({ v: 1, op: "pay" }); } }, T("pay_btn")));
    }
    var left = daysLeft(state.u);
    var small = (state.tr ? T("access_trial") + " · " : "") + T("access_until", { date: dateText(state.u) });
    return h("div", { class: "access" },
      h("div", { class: "txt" },
        h("span", { class: "small", text: small }),
        h("span", { class: "big", text: left <= 1 ? T("access_today") : T("access_left", { n: left }) })),
      h("button", { class: "pay", type: "button", onclick: function () { send({ v: 1, op: "pay" }); } }, T("extend_btn")));
  }

  function subCard(sub) {
    var paused = !!sub.p;
    var badge = paused ? h("span", { class: "badge ghost", text: T("paused") })
                       : h("span", { class: "badge", text: perDayText(perDay(sub)) });
    return h("div", { class: "sub" + (paused ? " paused" : "") },
      h("button", { class: "open", type: "button", onclick: function () { openEditor(sub); } },
        h("span", { class: "title", text: subTitle(sub) }),
        h("span", { class: "meta", text: subMeta(sub) }),
        badge),
      switchBtn(!paused, paused ? T("sub_paused_aria") : T("sub_on"), function () {
        confirmAsk(T(paused ? "confirm_resume" : "confirm_pause"), function () {
          send({ v: 1, op: "pause", i: sub.i, p: paused ? 0 : 1 });
        });
      }));
  }

  // ------------------------------------------------------------ редактор

  var EMPTY = { b: "", m: [], g: "kz", gv: "", yf: null, yt: null, pf: null, pt: null, km: null,
                bd: [], tr: [], fu: [], dr: [], vf: null, vt: null, pv: 0, nw: 0, sw: 0, cu: 0,
                w: [], x: [], rp: 0, p: 0 };

  function draftOf(sub) {
    var d = JSON.parse(JSON.stringify(EMPTY));
    Object.keys(sub || {}).forEach(function (k) { d[k] = JSON.parse(JSON.stringify(sub[k])); });
    return d;
  }

  function openNew() { push({ name: "editor", draft: draftOf(null), more: false }); }
  function openEditor(sub) { push({ name: "editor", draft: draftOf(sub), more: extrasCount(sub) > 0 }); }

  function renderEditor(screen) {
    var d = screen.draft;
    app.appendChild(header(d.i ? T("editor_edit") : T("editor_new")));

    var estN = h("span", { class: "n" });
    var estNote = h("span", { class: "note", text: T(sample.demo ? "estimate_note_demo" : "estimate_note") });
    app.appendChild(h("div", { class: "estimate" }, icon("sign", 30, "#15181D"),
      h("div", { class: "txt" }, estN, estNote)));
    function estimate() {
      var n = perDay(d);
      var shown = roundDay(n);
      estN.textContent = n < 0.5 ? T("estimate_less")
                                 : T("estimate", { n: shown, ads: plural(parseInt(shown.replace(/\s/g, ""), 10), "ads_forms") });
    }
    estimate();
    screen.estimate = estimate;

    // марка: «Любая», частые, «Все N»
    var brandChips = [chip(T("brand_any"), !d.b, function () { setBrand(d, ""); })];
    var shown = dirs.brands.slice(0, TOP_BRANDS).map(function (b) { return b.n; });
    if (d.b && shown.indexOf(d.b) < 0) shown.unshift(d.b);
    shown.forEach(function (b) { brandChips.push(chip(b, d.b === b, function () { setBrand(d, b); })); });
    brandChips.push(chip(T("brand_all_n", { n: dirs.brands.length }), false,
      function () { push({ name: "brands", draft: d, query: "" }); }, "all"));
    app.appendChild(h("div", { class: "field" }, h("span", { class: "label", text: T("brand") }),
      h("div", { class: "chips" }, brandChips)));

    // модели марки
    if (d.b) {
      var all = (dirs.brandBy[d.b] || { m: [] }).m;
      var top = all.slice(0, TOP_MODELS);
      d.m.forEach(function (m) { if (top.indexOf(m) < 0) top.push(m); });
      var modelChips = [chip(T("models_any"), !d.m.length, function () { d.m = []; changed(true); })];
      top.forEach(function (m) {
        modelChips.push(chip(m, d.m.indexOf(m) >= 0, function () { toggle(d.m, m); changed(true); }));
      });
      if (all.length > top.length) {
        modelChips.push(chip(T("models_more", { n: all.length - top.length }), false,
          function () { push({ name: "models", draft: d, query: "" }); }, "all"));
      }
      app.appendChild(h("div", { class: "field" },
        h("span", { class: "label" }, T("models_of", { brand: d.b }) + " ", h("span", { class: "hint", text: T("models_hint") })),
        h("div", { class: "chips" }, modelChips)));
    }

    // место
    var placePick = null;
    if (d.g === "r") {
      placePick = h("button", { class: "pick", type: "button", onclick: function () { push({ name: "regions", draft: d }); } },
        h("span", { text: d.gv ? regionName(d.gv) : T("pick_region") }), icon("right", 18));
    } else if (d.g === "c") {
      placePick = h("button", { class: "pick", type: "button", onclick: function () { push({ name: "cities", draft: d, query: "" }); } },
        h("span", { text: d.gv ? cityName(d.gv) : T("pick_city") }), icon("right", 18));
    }
    app.appendChild(h("div", { class: "field" }, h("span", { class: "label", text: T("where") }),
      h("div", { class: "seg" },
        chip(T("kz_short"), d.g === "kz", function () { d.g = "kz"; d.gv = ""; changed(true); }),
        chip(T("region"), d.g === "r", function () {
          if (d.g !== "r") { d.g = "r"; d.gv = ""; push({ name: "regions", draft: d }); }
        }),
        chip(T("city"), d.g === "c", function () {
          if (d.g !== "c") { d.g = "c"; d.gv = ""; push({ name: "cities", draft: d, query: "" }); }
        })),
      placePick));

    // год, цена, пробег
    app.appendChild(h("div", { class: "grid2", style: "margin-top: 18px" },
      numberField("yf", T("year_from_l"), d, false), numberField("yt", T("year_to_l"), d, false)));
    app.appendChild(h("div", { class: "grid2", style: "margin-top: 14px" },
      numberField("pf", T("price_from_l"), d, true), numberField("pt", T("price_to_l"), d, true)));
    app.appendChild(h("div", { class: "chips", style: "margin-top: 10px" }, QUICK_PRICES.map(function (n) {
      return chip(T("mln", { v: n / 1e6 }), d.pt === n && !d.pf, function () { d.pf = null; d.pt = n; changed(true); });
    })));
    app.appendChild(h("div", { class: "field" },
      h("label", { for: "f-km", text: T("km_l") }),
      numberInput("f-km", "km", d, true),
      h("p", { class: "help", text: T("km_hint") })));

    app.appendChild(moreBlock(screen));

    if (screen.err) app.appendChild(h("p", { class: "error", role: "alert", text: screen.err }));
    if (d.i) {
      app.appendChild(h("button", { class: "danger-btn", type: "button", onclick: function () {
        confirmAsk(T("confirm_delete"), function () { send({ v: 1, op: "delete", i: d.i }); });
      } }, T("delete")));
    }
    setDock(T("save"), function () { save(screen); });
  }

  function numberInput(id, key, d, spaced) {
    var input = h("input", { id: id, class: "input", inputmode: "numeric", autocomplete: "off",
                             value: d[key] ? (spaced ? number(d[key]) : String(d[key])) : "",
                             placeholder: T("any") });
    input.addEventListener("input", function () {
      d[key] = digits(input.value);
      changed(false);
    });
    input.addEventListener("blur", function () {
      input.value = d[key] ? (spaced ? number(d[key]) : String(d[key])) : "";
    });
    return input;
  }

  function numberField(key, label, d, spaced) {
    var id = "f-" + key;
    return h("div", { class: "field" }, h("label", { for: id, text: label }), numberInput(id, key, d, spaced));
  }

  function setBrand(d, brand) {
    if (d.b !== brand) d.m = [];
    d.b = brand;
    changed(true);
  }

  function toggle(list, value) {
    var at = list.indexOf(value);
    if (at >= 0) list.splice(at, 1); else list.push(value);
  }

  // правка черновика: full — перерисовать экран (кнопки), иначе — только оценку (ввод текста)
  function changed(full) {
    haptic();
    var editor = stack.filter(function (s) { return s.name === "editor"; })[0];
    if (editor && editor.err) {
      editor.err = "";                          // ошибка проверки — до следующей правки
      var shown = app.querySelector(".error");
      if (shown) shown.remove();
    }
    if (full) { render(); return; }
    if (editor && editor.estimate) editor.estimate();
  }

  function listText(codes, items) {
    if (!codes || !codes.length) return "";
    return codes.map(function (c) {
      var item = items.filter(function (x) { return x.v === c; })[0];
      return item ? name(item) : c;
    }).join(", ");
  }

  function moreBlock(screen) {
    var d = screen.draft;
    var box = h("div", { class: "more" });
    var count = extrasCount(d);
    box.appendChild(h("button", { class: "toggle", type: "button", "aria-expanded": screen.more ? "true" : "false",
                                  onclick: function () { screen.more = !screen.more; render(); } },
      h("span", { text: T("more") }),
      h("span", { class: "sum" }, screen.more ? icon("up", 18, null, 2.4)
                                              : (count ? T("more_filters_n", { n: count }) : icon("down", 18, null, 2.4)))));
    if (!screen.more) return box;

    function row(label, value, onclick) {
      return h("button", { class: "row", type: "button", onclick: onclick },
        h("span", { text: label }), h("span", { class: "val", text: value }));
    }
    function multi(key, items, title) {
      return function () { push({ name: "multi", draft: d, key: key, items: items, title: title }); };
    }
    function choice(key, options, title) {
      return function () { push({ name: "choice", draft: d, key: key, options: options, title: title }); };
    }

    box.appendChild(row(T("body"), listText(d.bd, dirs.dict.body) || T("any"), multi("bd", dirs.dict.body, T("body"))));
    box.appendChild(row(T("transm"), listText(d.tr, dirs.dict.transm) || T("any_f"), multi("tr", dirs.dict.transm, T("transm"))));
    box.appendChild(row(T("fuel"), listText(d.fu, dirs.dict.fuel) || T("any_n"), multi("fu", dirs.dict.fuel, T("fuel"))));
    box.appendChild(row(T("volume"),
      rangeText(d.vf, d.vt, function (v) { return String(v).replace(".", ","); }, "vol_from", "vol_to", "vol_range") || T("any"),
      function () { push({ name: "volume", draft: d }); }));

    var priv = h("div", { class: "row" }, h("span", { text: T("private") }),
      switchBtn(d.pv, T("private"), function () { d.pv = d.pv ? 0 : 1; changed(true); }));
    box.appendChild(priv);

    var cond = [T("any_n"), T("cond_new"), T("cond_used")];
    box.appendChild(row(T("condition"), cond[d.nw || 0], choice("nw", cond, T("condition"))));
    box.appendChild(row(T("drive"), listText(d.dr, dirs.dict.drive) || T("any"), multi("dr", dirs.dict.drive, T("drive"))));
    var steer = [T("any"), T("steer_left"), T("steer_right")];
    box.appendChild(row(T("steer"), steer[d.sw || 0], choice("sw", steer, T("steer"))));
    var customs = [T("any"), T("customs_yes")];
    box.appendChild(row(T("customs"), customs[d.cu || 0], choice("cu", customs, T("customs"))));
    if ((d.dr && d.dr.length) || d.sw || d.cu) box.appendChild(h("p", { class: "note", text: T("page_note") }));

    var words = d.w.join(", ") + (d.x.length ? (d.w.length ? " · " : "") + d.x.map(function (x) { return "−" + x; }).join(", ") : "");
    box.appendChild(row(T("words"), words || "—", function () { push({ name: "words", draft: d }); }));

    var reposts = h("div", { class: "row" },
      h("span", { class: "two" }, h("span", { text: T("reposts") }), h("small", { text: T("reposts_hint") })),
      switchBtn(d.rp, T("reposts"), function () { d.rp = d.rp ? 0 : 1; changed(true); }));
    box.appendChild(reposts);
    return box;
  }

  function validate(d) {
    if (d.yf && d.yt && d.yf > d.yt) return T("err_year");
    if (d.pf && d.pt && d.pf > d.pt) return T("err_price");
    if (d.vf && d.vt && d.vf > d.vt) return T("err_volume");
    if ((d.g === "r" || d.g === "c") && !d.gv) return T("err_place");
    return "";
  }

  // в операцию — только заданное (короче для sendData)
  function compact(d) {
    var out = {};
    Object.keys(EMPTY).concat(["i", "r"]).forEach(function (k) {
      var v = d[k];
      if (v === null || v === undefined || v === "" || v === 0 || (Array.isArray(v) && !v.length)) return;
      out[k] = v;
    });
    if (!out.g) out.g = "kz";
    return out;
  }

  function save(screen) {
    var err = validate(screen.draft);
    if (err) { screen.err = err; render(); haptic("error"); return; }
    send({ v: 1, op: "save", sub: compact(screen.draft) });
  }

  // ------------------------------------------------------------ выбор из списков

  function searchBox(screen, placeholder, draw) {
    var input = h("input", { class: "input", type: "search", placeholder: placeholder, value: screen.query || "",
                             "aria-label": placeholder, autocomplete: "off" });
    input.addEventListener("input", function () { screen.query = input.value; draw(); });
    return input;
  }

  function renderBrands(screen) {
    var d = screen.draft;
    app.appendChild(header(T("brand")));
    var list = h("div", { class: "list" });
    function draw() {
      var q = M.fold(screen.query || "").trim();
      list.innerHTML = "";
      var items = dirs.brands.filter(function (b) { return !q || M.fold(b.n).indexOf(q) >= 0; });
      if (!q) list.appendChild(item(T("brand_any"), "", !d.b, function () { setBrand(d, ""); pop(); }));
      items.forEach(function (b) {
        list.appendChild(item(b.n, String(b.m.length), d.b === b.n, function () { setBrand(d, b.n); pop(); }));
      });
    }
    app.appendChild(searchBox(screen, T("brand_search"), draw));
    app.appendChild(list);
    draw();
  }

  function item(text, small, pressed, onclick, checkbox) {
    return h("button", { class: "item", type: "button", "aria-pressed": pressed ? "true" : "false", onclick: onclick },
      h("span", { text: text }),
      checkbox ? h("span", { class: "check" }, pressed ? icon("check", 16, "#fff", 3) : null)
               : (small ? h("small", { text: small }) : null));
  }

  function renderModels(screen) {
    var d = screen.draft;
    app.appendChild(header(T("models_of", { brand: d.b })));
    var all = (dirs.brandBy[d.b] || { m: [] }).m;
    var list = h("div", { class: "list" });
    function draw() {
      var q = M.fold(screen.query || "").trim();
      list.innerHTML = "";
      all.filter(function (m) { return !q || M.fold(m).indexOf(q) >= 0; }).forEach(function (m) {
        list.appendChild(item(m, "", d.m.indexOf(m) >= 0, function () { toggle(d.m, m); haptic(); draw(); }, true));
      });
    }
    app.appendChild(searchBox(screen, T("models_search"), draw));
    app.appendChild(list);
    draw();
    setDock(T("done"), pop);
  }

  function renderRegions(screen) {
    var d = screen.draft;
    app.appendChild(header(T("pick_region")));
    app.appendChild(h("div", { class: "list" }, dirs.dict.regions.map(function (r) {
      return item(name(r), "", d.gv === r.v, function () { d.g = "r"; d.gv = r.v; pop(); });
    })));
  }

  function renderCities(screen) {
    var d = screen.draft;
    app.appendChild(header(T("pick_city")));
    var list = h("div", { class: "list" });
    function draw() {
      var q = M.fold(screen.query || "").trim();
      list.innerHTML = "";
      dirs.cities.filter(function (c) { return !q || M.fold(c.n).indexOf(q) >= 0; }).slice(0, q ? 60 : 30)
        .forEach(function (c) {
          list.appendChild(item(c.n, regionName(c.r), d.gv === c.k, function () { d.g = "c"; d.gv = c.k; pop(); }));
        });
    }
    app.appendChild(searchBox(screen, T("city_search"), draw));
    app.appendChild(list);
    draw();
  }

  function renderMulti(screen) {
    var d = screen.draft;
    app.appendChild(header(screen.title));
    var list = h("div", { class: "list" });
    function draw() {
      list.innerHTML = "";
      list.appendChild(item(T("any"), "", !d[screen.key].length, function () { d[screen.key] = []; haptic(); draw(); }, true));
      screen.items.forEach(function (x) {
        list.appendChild(item(name(x), "", d[screen.key].indexOf(x.v) >= 0,
          function () { toggle(d[screen.key], x.v); haptic(); draw(); }, true));
      });
    }
    app.appendChild(list);
    draw();
    setDock(T("done"), pop);
  }

  function renderChoice(screen) {
    var d = screen.draft;
    app.appendChild(header(screen.title));
    app.appendChild(h("div", { class: "list" }, screen.options.map(function (text, index) {
      return item(text, "", (d[screen.key] || 0) === index, function () { d[screen.key] = index; pop(); });
    })));
    if (screen.key === "sw" || screen.key === "cu") app.appendChild(h("p", { class: "help", style: "margin-top: 12px", text: T("page_note") }));
  }

  function renderVolume(screen) {
    var d = screen.draft;
    app.appendChild(header(T("volume")));
    function box(key, label) {
      var input = h("input", { id: "v-" + key, class: "input", inputmode: "decimal", autocomplete: "off",
                               value: d[key] ? String(d[key]).replace(".", ",") : "", placeholder: T("any") });
      input.addEventListener("input", function () { d[key] = decimal(input.value); });
      return h("div", { class: "field" }, h("label", { for: "v-" + key, text: label }), input);
    }
    app.appendChild(h("div", { class: "grid2", style: "margin-top: 12px" }, box("vf", T("volume_from")), box("vt", T("volume_to"))));
    setDock(T("done"), pop);
  }

  function renderWords(screen) {
    var d = screen.draft;
    app.appendChild(header(T("words")));
    app.appendChild(tagsField(d.w, MAX_WORDS, "", T("words_l"), T("words_hint")));
    app.appendChild(tagsField(d.x, MAX_MINUS, "minus", T("minus_l"), T("minus_hint")));
    setDock(T("done"), pop);
  }

  function tagsField(list, max, kind, label, hint) {
    var id = "t-" + (kind || "plus");
    var tags = h("div", { class: "tags" });
    var input = h("input", { id: id, class: "input", autocomplete: "off", maxlength: MAX_WORD * 3 });
    function draw() {
      tags.innerHTML = "";
      list.forEach(function (w, index) {
        tags.appendChild(h("span", { class: "tag " + kind }, (kind ? "−" : "") + w,
          h("button", { type: "button", "aria-label": "×", onclick: function () { list.splice(index, 1); draw(); haptic(); } }, "×")));
      });
    }
    function commit() {
      input.value.split(",").forEach(function (raw) {
        var w = raw.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_WORD);
        var lower = M.fold(w);
        if (w && list.length < max && !list.some(function (x) { return M.fold(x) === lower; })) list.push(w);
      });
      input.value = "";
      draw();
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commit(); } });
    draw();
    return h("div", { class: "field" },
      h("label", { for: id, text: label }),
      h("p", { class: "help", text: hint }),
      tags,
      h("div", { class: "addrow" }, input, h("button", { type: "button", onclick: commit }, T("words_add"))));
  }

  // ------------------------------------------------------------ настройки

  function openSettings() {
    var q = state.q;
    push({ name: "settings", l: state.l || "ru", q: q ? [q[0], q[1]] : null, mode: (q && q[2]) || "silent" });
  }

  function renderSettings(screen) {
    lang = screen.l;
    document.documentElement.lang = lang === "kk" ? "kk" : "ru";
    app.appendChild(header(T("settings_title")));

    app.appendChild(h("div", { class: "field" }, h("span", { class: "label", text: T("language") }),
      h("div", { class: "seg", style: "grid-template-columns: repeat(2, minmax(0, 1fr))" },
        chip("Русский", screen.l === "ru", function () { screen.l = "ru"; render(); }),
        chip("Қазақша", screen.l === "kk", function () { screen.l = "kk"; render(); }))));

    var q = screen.q;
    var preset = q ? QUIET_PRESETS.map(function (p) { return p[0] === q[0] && p[1] === q[1]; }).indexOf(true) : -1;
    var chips = [chip(T("quiet_off"), !q, function () { screen.q = null; render(); })];
    QUIET_PRESETS.forEach(function (p, index) {
      chips.push(chip(timeText(p[0]) + "–" + timeText(p[1]), preset === index,
        function () { screen.q = [p[0], p[1]]; screen.custom = false; render(); }));
    });
    chips.push(chip(T("quiet_custom"), q && (preset < 0 || screen.custom),
      function () { screen.q = screen.q || [22 * 60, 7 * 60]; screen.custom = true; render(); }));
    app.appendChild(h("div", { class: "field" }, h("span", { class: "label", text: T("quiet") }), h("div", { class: "chips" }, chips)));

    if (q && (preset < 0 || screen.custom)) {
      var timeBox = function (index, label) {
        var input = h("input", { id: "q-" + index, class: "input", type: "time", value: timeText(q[index]) });
        input.addEventListener("change", function () {
          var parts = input.value.split(":");
          if (parts.length === 2) screen.q[index] = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        });
        return h("div", { class: "field" }, h("label", { for: "q-" + index, text: label }), input);
      };
      app.appendChild(h("div", { class: "grid2", style: "margin-top: 12px" }, timeBox(0, T("quiet_from")), timeBox(1, T("quiet_to"))));
    }
    if (q) {
      app.appendChild(h("div", { class: "field" }, h("span", { class: "label", text: T("quiet_mode") }),
        h("div", { class: "seg", style: "grid-template-columns: repeat(2, minmax(0, 1fr))" },
          chip(T("quiet_silent"), screen.mode === "silent", function () { screen.mode = "silent"; render(); }),
          chip(T("quiet_hold"), screen.mode === "hold", function () { screen.mode = "hold"; render(); }))));
    }
    setDock(T("settings_save"), function () {
      send({ v: 1, op: "settings", l: screen.l, q: screen.q ? [screen.q[0], screen.q[1], screen.mode] : null });
    });
  }

  var SCREENS = { home: renderHome, editor: renderEditor, brands: renderBrands, models: renderModels,
                  regions: renderRegions, cities: renderCities, multi: renderMulti, choice: renderChoice,
                  volume: renderVolume, words: renderWords, settings: renderSettings };

  // ------------------------------------------------------------ данные и запуск

  function prepareDirs(dict, brands, cities) {
    var d = { dict: dict, brands: brands, cities: cities, brandBy: {}, cityBy: {}, regionBy: {} };
    brands.forEach(function (b) { d.brandBy[b.n] = b; });
    cities.forEach(function (c) { d.cityBy[c.k] = c; });
    dict.regions.forEach(function (r) { d.regionBy[r.v] = r; });
    return d;
  }

  function hashParam(key) {
    var hash = window.location.hash.replace(/^#/, "");
    var found = null;
    hash.split("&").forEach(function (part) {
      var at = part.indexOf("=");
      if (at > 0 && part.slice(0, at) === key) found = decodeURIComponent(part.slice(at + 1));
    });
    return found;
  }

  function fromBase64(text) {
    text = text.replace(/-/g, "+").replace(/_/g, "/");
    while (text.length % 4) text += "=";
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function decodeState(code) {
    var prefix = code.slice(0, 2);
    var bytes = fromBase64(code.slice(2));
    var ready;
    if (prefix === "j.") {
      ready = Promise.resolve(bytes);
    } else if (prefix === "z.") {
      if (!window.DecompressionStream) return Promise.reject(new Error("old"));
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      ready = new Response(stream).arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    } else {
      return Promise.reject(new Error("format"));
    }
    return ready.then(function (raw) { return JSON.parse(new TextDecoder().decode(raw)); });
  }

  function demoState() {
    var now = Math.floor(Date.now() / 1000);
    return {
      v: 1, l: "ru", lim: 5, u: now + 7 * 86400, tr: 0, q: [23 * 60, 8 * 60, "silent"], st: { m: 37 },
      subs: [
        { i: 1, b: "Toyota", m: ["Camry"], g: "c", gv: "almaty", yf: 2015, pt: 15000000, r: 1 },
        { i: 2, b: "Hyundai", m: [], g: "kz", yf: 2015, pt: 8000000, r: 1 },
        { i: 3, b: "ВАЗ (Lada)", m: [], g: "c", gv: "astana", pv: 1, p: 1, r: 1 }
      ]
    };
  }

  function normalize(s) {
    s.subs = (s.subs || []).map(function (sub) { return draftOf(sub); });
    s.lim = s.lim || 5;
    return s;
  }

  function fail(key) {
    app.innerHTML = "";
    app.appendChild(h("p", { class: "empty", text: T(key) }));
  }

  function getJSON(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(path + ": " + r.status);
      return r.json();
    });
  }

  function start() {
    document.getElementById("dock-button").addEventListener("click", function () { if (dockAction) dockAction(); });
    if (inTelegram) {
      tg.ready();
      tg.expand();
      tg.BackButton.onClick(pop);
      try { tg.setHeaderColor(GROUND); tg.setBackgroundColor(GROUND); } catch (e) { /* старый Telegram */ }
    }

    Promise.all([getJSON("i18n.json"), getJSON("data/dict.json"), getJSON("data/brands.json"),
                 getJSON("data/cities.json"), getJSON("data/sample.json")])
      .then(function (loaded) {
        i18n = loaded[0];
        dirs = prepareDirs(loaded[1], loaded[2], loaded[3]);
        sample = M.prepareSample(loaded[4], loaded[2]);
        var code = hashParam("s");
        if (!code) {
          if (inTelegram) { fail("open_again"); return null; }
          var banner = document.getElementById("banner");
          banner.textContent = T("demo_banner");
          banner.hidden = false;
          sample.demo = true;
          return demoState();
        }
        return decodeState(code).catch(function (e) {
          fail(e.message === "old" ? "old_telegram" : "open_again");
          return null;
        });
      })
      .then(function (loaded) {
        if (!loaded) return;
        if (loaded.v !== 1) { fail("open_again"); return; }
        state = normalize(loaded);
        lang = i18n[state.l] ? state.l : "ru";
        stack = [{ name: "home" }];
        render();
      })
      .catch(function () {
        app.innerHTML = "";
        app.appendChild(h("p", { class: "empty", text: "Не удалось загрузить приложение. Проверьте интернет. · Қосымша жүктелмеді. Интернетті тексеріңіз." }));
      });
  }

  start();
})();
