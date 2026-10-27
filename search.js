/* Nexcon site search. The header has a magnifier button (.search-toggle; there are two, see below) that opens a panel
   (#searchPanel) with a search box and a results list. Nothing is sent anywhere: the search runs
   in the browser over a small file that build.py writes for each language, listing every page's
   title, description and text (search-index-en.json, search-index-zh.json, search-index-hans.json,
   in the site root). The file for the page's own language is fetched the first time the panel opens.

   Matching: the "Match all words" tick box (#searchAll, ticked by default and remembered in this browser)
   decides how several words are combined. Ticked: every word the visitor types must appear somewhere on
   the page (title, description or text). Unticked: a page with ANY one of the words is enough, and pages
   containing more of the words rank higher. A title match ranks highest either way. Chinese has no spaces
   between words, so it is matched as plain substrings (one character is enough; separate words with a
   space to use the tick box). Latin words need at least 2 letters.

   Results are built with textContent (never innerHTML), so nothing typed or indexed can inject HTML.
   Esc, the x button, or a click outside closes the panel; Enter opens the first result.
   Words shown to the visitor come from translations.js (search_* keys); the English text in the
   markup is only a fallback. This file is loaded on every page from partial/footer.html. */
(function () {
  // Two magnifier buttons: one in the header bar (phones and tablets) and one in the menu in front of the
  // language switcher (desktop). CSS shows one at a time; both open the same panel.
  var toggles = Array.prototype.slice.call(document.querySelectorAll(".search-toggle"));
  var panel = document.getElementById("searchPanel");
  if (!toggles.length || !panel) return;

  var form = panel.querySelector("form");
  var input = panel.querySelector("input[type=search]");
  var closeBtn = panel.querySelector(".search-close");
  var statusEl = panel.querySelector(".search-status");
  var allBox = panel.querySelector("#searchAll"); // "Match all words"
  var STORAGE_KEY = "nexcon-search-all";
  var listEl = panel.querySelector(".search-results");
  var MAX_RESULTS = 8;
  var SNIPPET_BEFORE = 55;
  var SNIPPET_LENGTH = 150;

  // Where this script was loaded from: the site root, wherever the page is (so links work from any folder).
  var base = (document.currentScript && document.currentScript.src) || (location.origin + "/search.js");
  var root = new URL(".", base).href; // the site root itself, e.g. https://nexconbm.com.au/

  function language() {
    var l = (document.documentElement.lang || "en").toLowerCase();
    return l.indexOf("zh-hans") === 0 ? "hans" : l.indexOf("zh") === 0 ? "zh" : "en";
  }
  function t(key, fallback) {
    var dict = (typeof translations !== "undefined" && translations[language() === "en" ? "en" : "zh"]) || {};
    return dict[key] || fallback;
  }

  // Put the visitor's language on the controls that data-i18n can't reach (attributes).
  toggles.forEach(function (b) { b.setAttribute("aria-label", t("search_label", "Search")); });
  input.setAttribute("placeholder", t("search_placeholder", "Search the site…"));
  input.setAttribute("aria-label", t("search_label", "Search"));
  closeBtn.setAttribute("aria-label", t("search_close", "Close search"));
  if (allBox) {
    allBox.parentNode.setAttribute("title", t("search_match_all_hint", allBox.parentNode.getAttribute("title") || ""));
    try { if (localStorage.getItem(STORAGE_KEY) === "0") allBox.checked = false; } catch (e) { /* storage blocked: stays ticked */ }
  }

  var entries = null;     // the loaded index
  var loading = null;     // the in-flight request
  var current = [];       // results on screen, in order

  function loadIndex() {
    if (entries) return Promise.resolve(entries);
    if (loading) return loading;
    var file = { en: "search-index-en.json", zh: "search-index-zh.json", hans: "search-index-hans.json" }[language()];
    loading = fetch(new URL(file, base).href)
      .then(function (res) { if (!res.ok) throw new Error("index " + res.status); return res.json(); })
      .then(function (data) {
        entries = data.map(function (e) {
          return { url: e.u, title: e.t, desc: e.d, body: e.b, lt: e.t.toLowerCase(), ld: e.d.toLowerCase(), lb: e.b.toLowerCase(), lk: (e.k || "").toLowerCase() };
        });
        return entries;
      })
      .catch(function (err) { loading = null; throw err; });
    return loading;
  }

  var CJK = /[㐀-鿿]/;
  function usable(query) {
    var q = query.trim();
    return CJK.test(q) || q.replace(/\s+/g, "").length >= 2;
  }

  function countIn(haystack, needle, cap) {
    var n = 0, i = haystack.indexOf(needle);
    while (i !== -1 && n < cap) { n++; i = haystack.indexOf(needle, i + needle.length); }
    return n;
  }

  function matchAll() { return !allBox || allBox.checked; }

  function run(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    function score(e, all) {
      var total = 0, matched = 0;
      terms.forEach(function (term) {
        var inTitle = e.lt.indexOf(term) !== -1, inDesc = e.ld.indexOf(term) !== -1, inKeywords = e.lk.indexOf(term) !== -1, inBody = countIn(e.lb, term, 6);
        if (inTitle || inDesc || inKeywords || inBody) {
          matched++;
          total += (inTitle ? 12 : 0) + (inKeywords ? 9 : 0) + (inDesc ? 5 : 0) + inBody;
        }
      });
      return (all ? matched === terms.length : matched > 0) ? total : 0;
    }
    function rank(all) {
      return entries.map(function (e) { return { e: e, s: score(e, all) }; })
        .filter(function (r) { return r.s > 0; })
        .sort(function (a, b) { return b.s - a.s; });
    }
    var ranked = rank(matchAll());
    return ranked.slice(0, MAX_RESULTS).map(function (r) { return r.e; });
  }

  // Text around the first match, with each searched word wrapped in <mark> (built as DOM nodes, not HTML).
  function snippet(e, terms) {
    var source = e.body, lower = e.lb, at = -1;
    terms.forEach(function (term) {
      var i = lower.indexOf(term);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    });
    if (at === -1) { source = e.desc; lower = e.ld; at = 0; }
    var start = Math.max(0, at - SNIPPET_BEFORE);
    var piece = source.slice(start, start + SNIPPET_LENGTH);
    var lowerPiece = lower.slice(start, start + SNIPPET_LENGTH);
    var span = document.createElement("span");
    span.className = "search-result-snippet";
    if (start > 0) piece = "…" + piece, lowerPiece = "…" + lowerPiece;
    if (start + SNIPPET_LENGTH < source.length) piece += "…", lowerPiece += "…";
    var marks = [];
    terms.forEach(function (term) {
      var i = lowerPiece.indexOf(term);
      while (i !== -1) { marks.push([i, i + term.length]); i = lowerPiece.indexOf(term, i + term.length); }
    });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var pos = 0;
    marks.forEach(function (m) {
      if (m[0] < pos) return; // overlaps one already marked
      span.appendChild(document.createTextNode(piece.slice(pos, m[0])));
      var mark = document.createElement("mark");
      mark.textContent = piece.slice(m[0], m[1]);
      span.appendChild(mark);
      pos = m[1];
    });
    span.appendChild(document.createTextNode(piece.slice(pos)));
    return span;
  }

  function show(message) { statusEl.textContent = message; }

  function render() {
    var query = input.value;
    listEl.textContent = "";
    current = [];
    if (!query.trim()) { show(""); return; }
    if (!usable(query)) { show(t("search_hint", "Type a word to search.")); return; }
    if (!entries) return; // still loading; render() runs again when it arrives
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    current = run(query);
    if (!current.length && terms.length > 1 && matchAll()) {
      show(t("search_none_all", "No page contains all of “%q”. Untick “Match all words” to see pages with any of those words.").replace("%q", query.trim()));
      return;
    }
    if (!current.length) {
      show(t("search_none", "No results for “%q”. Try another word, or call us on +61 411 330 962.").replace("%q", query.trim()));
      return;
    }
    show(current.length === 1 ? t("search_count_one", "1 result") : t("search_count_many", "%n results").replace("%n", current.length));
    current.forEach(function (e) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = new URL(e.url.replace(/^\//, ""), root).href;
      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = e.title;
      a.appendChild(title);
      a.appendChild(snippet(e, terms));
      li.appendChild(a);
      listEl.appendChild(li);
    });
  }

  function open() {
    panel.hidden = false;
    setExpanded("true");
    input.focus();
    if (!entries) {
      show(t("search_loading", "Loading…"));
      loadIndex().then(render).catch(function () { show(t("search_error", "Search isn't available right now. Please try again later.")); });
    } else {
      render();
    }
  }
  function close(returnFocus) {
    panel.hidden = true;
    setExpanded("false");
    if (returnFocus) {
      var visible = toggles.filter(function (b) { return b.offsetParent !== null; })[0]; // whichever button is showing
      if (visible) visible.focus();
    }
  }

  function setExpanded(value) { toggles.forEach(function (b) { b.setAttribute("aria-expanded", value); }); }

  toggles.forEach(function (b) {
    b.addEventListener("click", function () { if (panel.hidden) open(); else close(true); });
  });
  closeBtn.addEventListener("click", function () { close(true); });
  input.addEventListener("input", render);
  if (allBox) {
    allBox.addEventListener("change", function () {
      try { localStorage.setItem(STORAGE_KEY, allBox.checked ? "1" : "0"); } catch (e) { /* not remembered */ }
      render();
    });
  }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var first = listEl.querySelector("a");
    if (first) window.location.href = first.href;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) close(true);
  });
  document.addEventListener("click", function (e) {
    if (!panel.hidden && !panel.contains(e.target) && !toggles.some(function (b) { return b.contains(e.target); })) close(false);
  });
})();
