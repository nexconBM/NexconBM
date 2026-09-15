/* Nexcon site language toggle: English <-> Traditional Chinese.
   Relies on translations.js being loaded first.
   Elements opt in with data-i18n="key" (sets textContent)
   or data-i18n data-i18n-html="key" (sets innerHTML, for text containing tags). */
(function () {
  var STORAGE_KEY = "nexcon-lang";
  var memoryLang = "en"; // fallback if localStorage is unavailable (e.g. some file:// or private-browsing contexts)

  function safeGet() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v || memoryLang;
    } catch (e) {
      return memoryLang;
    }
  }

  function safeSet(lang) {
    memoryLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* storage unavailable: the toggle still works for this page view via memoryLang */
    }
  }

  function currentLang() {
    return safeGet();
  }

  function applyLang(lang) {
    var dict = translations[lang] || translations.en;

    document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] === undefined) return;
      if (el.hasAttribute("data-i18n-html")) {
        el.innerHTML = dict[key];
      } else {
        el.textContent = dict[key];
      }
    });

    var toggle = document.getElementById("langToggle");
    if (toggle) {
      toggle.textContent = lang === "zh" ? "EN" : "中文";
      toggle.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切換至中文");
    }

    safeSet(lang);
  }

  document.addEventListener("DOMContentLoaded", function () {
    applyLang(currentLang());

    var toggle = document.getElementById("langToggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        applyLang(currentLang() === "en" ? "zh" : "en");
      });
    }
  });
})();