/* Nexcon inspection fee calculator (Building Inspections page).
   The visitor picks a property type, bedrooms and bathrooms; "Calculate price" shows the fee.
   Leaving anything unselected shows an error instead of a price.

   Prices come from the printed Nexcon fee sheet. All amounts are before GST.
   The sheet lists four base sizes per property type:
     1 bed + 1 bath | 2 bed + 1 bath | 2 bed + 2 bath | 3 bed + 2 bath
   plus +$50 for each additional bedroom (beyond 3) and each additional bath (beyond 2).
   A size the sheet doesn't list (e.g. 1 bed + 2 bath, 3 bed + 1 bath) uses the smallest
   listed size that covers it. Update PRICES / the constants below if the sheet changes. */
(function () {
  "use strict";

  var form = document.getElementById("price-calc");
  if (!form) return;

  var TIERS = [ // [bedrooms, bathrooms] each base price covers, smallest first
    [1, 1], [2, 1], [2, 2], [3, 2]
  ];
  var PRICES = {
    house_single: [550, 550, 600, 650],
    house_double: [550, 550, 600, 650],
    townhouse_1: [550, 550, 600, 600],
    townhouse_2: [550, 550, 600, 650],
    townhouse_3: [550, 550, 600, 650],
    city_apartment: [550, 550, 600, 650],
    suburban_apartment: [500, 500, 550, 600]
  };
  var PEST = { pest_slab: 300, pest_sub: 350 }; // flat fee, no bedroom/bathroom sizing
  var EXTRA_ROOM = 50; // each additional bedroom or bathroom
  var PCI_FEE = 50; // Practical Completion stage inspection of a new house/apartment
  var POOL_AVAILABLE = { house_single: true, house_double: true }; // pool inspection is only offered for houses, at no extra charge
  var GST_RATE = 0.10;

  var typeSel = document.getElementById("price-type");
  var bedSel = document.getElementById("price-beds");
  var bathSel = document.getElementById("price-baths");
  var pciBox = document.getElementById("price-pci");
  var sizeFields = form.querySelectorAll("[data-size-field]");
  var pciField = document.getElementById("price-pci-field");
  var poolBox = document.getElementById("price-pool");
  var poolField = document.getElementById("price-pool-field");
  var errorEl = document.getElementById("price-error");
  var resultEl = document.getElementById("price-result");

  var lastResult = null; // kept so the result can be redrawn in the other language
  var showingError = false;

  function currentLang() {
    try { return localStorage.getItem("nexcon-lang") || "en"; } catch (e) { return "en"; }
  }
  function t(key, fallback) {
    var dict = (typeof translations !== "undefined" && translations[currentLang()]) || {};
    return dict[key] || fallback;
  }
  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2);
  }

  function isPest() { return PEST.hasOwnProperty(typeSel.value); }

  // Pest control is a flat fee, so hide the bedroom/bathroom/Practical Completion fields for it.
  function syncFields() {
    var pest = isPest();
    for (var i = 0; i < sizeFields.length; i++) sizeFields[i].hidden = pest;
    pciField.hidden = pest;
    poolField.hidden = !POOL_AVAILABLE[typeSel.value];
    if (poolField.hidden) poolBox.checked = false;
  }

  function baseFor(type, beds, baths) {
    var list = PRICES[type];
    var cb = Math.min(beds, TIERS[TIERS.length - 1][0]);
    var cr = Math.min(baths, TIERS[TIERS.length - 1][1]);
    for (var i = 0; i < TIERS.length; i++) {
      if (cb <= TIERS[i][0] && cr <= TIERS[i][1]) return list[i];
    }
    return list[list.length - 1];
  }

  function calculate() {
    var type = typeSel.value;
    var lines = [];
    var subtotal;
    if (PEST.hasOwnProperty(type)) {
      subtotal = PEST[type];
      lines.push({ key: "price_line_base", fallback: "Inspection fee", amount: subtotal });
    } else {
      var beds = parseInt(bedSel.value, 10);
      var baths = parseInt(bathSel.value, 10);
      var base = baseFor(type, beds, baths);
      subtotal = base;
      lines.push({ key: "price_line_base", fallback: "Inspection fee", amount: base });
      var extraBeds = Math.max(0, beds - 3);
      var extraBaths = Math.max(0, baths - 2);
      if (extraBeds) {
        subtotal += extraBeds * EXTRA_ROOM;
        lines.push({ key: "price_line_beds", fallback: "Additional bedrooms", count: extraBeds, amount: extraBeds * EXTRA_ROOM });
      }
      if (extraBaths) {
        subtotal += extraBaths * EXTRA_ROOM;
        lines.push({ key: "price_line_baths", fallback: "Additional bathrooms", count: extraBaths, amount: extraBaths * EXTRA_ROOM });
      }
      if (pciBox.checked) {
        subtotal += PCI_FEE;
        lines.push({ key: "price_line_pci", fallback: "Practical Completion Inspection (PCI)", amount: PCI_FEE });
      }
      if (POOL_AVAILABLE[type] && poolBox.checked) lines.push({ key: "price_line_pool", fallback: "Swimming pool inspection", included: true });
    }
    var gst = subtotal * GST_RATE;
    return { lines: lines, subtotal: subtotal, gst: gst, total: subtotal + gst };
  }

  function row(label, value, className) {
    var div = document.createElement("div");
    div.className = "price-result-row" + (className ? " " + className : "");
    var l = document.createElement("span");
    l.textContent = label;
    var v = document.createElement("span");
    v.textContent = value;
    div.appendChild(l);
    div.appendChild(v);
    return div;
  }

  function renderResult() {
    resultEl.textContent = "";
    if (!lastResult) { resultEl.hidden = true; return; }
    var r = lastResult;
    var title = document.createElement("p");
    title.className = "price-result-title";
    title.textContent = t("price_result_title", "Your inspection fee");
    resultEl.appendChild(title);
    r.lines.forEach(function (ln) {
      var label = t(ln.key, ln.fallback);
      if (ln.count) label += " (" + ln.count + " × " + money(EXTRA_ROOM) + ")";
      resultEl.appendChild(row(label, ln.included ? t("price_included", "Included") : money(ln.amount)));
    });
    resultEl.appendChild(row(t("price_line_gst", "GST (10%)"), money(r.gst)));
    resultEl.appendChild(row(t("price_line_total", "Total incl. GST"), money(r.total), "price-result-total"));
    resultEl.hidden = false;
  }

  function renderError() {
    errorEl.hidden = !showingError;
    errorEl.textContent = showingError ? t("price_error", "Please choose an option in every field above to see the price.") : "";
  }

  function markInvalid(sel, bad) {
    if (bad) sel.setAttribute("aria-invalid", "true"); else sel.removeAttribute("aria-invalid");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var needSize = !isPest();
    var badType = !typeSel.value;
    var badBeds = needSize && !bedSel.value;
    var badBaths = needSize && !bathSel.value;
    markInvalid(typeSel, badType);
    markInvalid(bedSel, badBeds);
    markInvalid(bathSel, badBaths);
    if (badType || badBeds || badBaths) {
      showingError = true;
      lastResult = null;
      renderError();
      renderResult();
      return;
    }
    showingError = false;
    lastResult = calculate();
    renderError();
    renderResult();
  });

  // Changing any choice makes a shown price stale, so clear it rather than show a wrong number.
  function onChange(e) {
    if (e.target === typeSel) syncFields();
    markInvalid(e.target, false);
    lastResult = null;
    showingError = false;
    renderError();
    renderResult();
  }
  form.addEventListener("change", onChange);

  syncFields();

  // setTimeout so this runs after i18n.js's own click handler has saved the new language.
  var toggle = document.getElementById("langToggle");
  if (toggle) toggle.addEventListener("click", function () { setTimeout(function () { renderError(); renderResult(); }, 0); });
})();
