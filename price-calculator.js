/* Nexcon inspection fee calculator (Building Inspections page).
   The visitor picks a property type, bedrooms and bathrooms; "Calculate price" shows the fee.
   Leaving anything unselected shows an error instead of a price.

   The price table and the maths live in pricing.js (shared with the booking form), which must
   be loaded before this file. To change a fee, edit pricing.js and booking-apps-script.gs. */
(function () {
  "use strict";

  var form = document.getElementById("price-calc");
  if (!form || !window.NexconPricing) return;
  var P = window.NexconPricing;

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

  function isPest() { return P.isPest(typeSel.value); }

  // Pest control is a flat fee, so hide the bedroom/bathroom/Practical Completion fields for it.
  function syncFields() {
    var pest = isPest();
    for (var i = 0; i < sizeFields.length; i++) sizeFields[i].hidden = pest;
    pciField.hidden = pest;
    poolField.hidden = !P.poolAvailable(typeSel.value);
    if (poolField.hidden) poolBox.checked = false;
  }

  function calculate() {
    return P.calculate(typeSel.value, parseInt(bedSel.value, 10), parseInt(bathSel.value, 10), pciBox.checked, poolBox.checked);
  }

  function renderResult() {
    if (!lastResult) { resultEl.textContent = ""; resultEl.hidden = true; return; }
    P.render(resultEl, lastResult, t);
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
