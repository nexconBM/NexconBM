/* Nexcon inspection fees: the price table and the calculation, shared by the fee calculator
   (price-calculator.js) and the booking form (booking.js) so the two can never disagree.
   It draws nothing by itself; it only exposes window.NexconPricing.

   Prices come from the printed Nexcon fee sheet. All amounts are before GST.
   The sheet lists four base sizes per property type:
     1 bed + 1 bath | 2 bed + 1 bath | 2 bed + 2 bath | 3 bed + 2 bath
   plus +$50 for each additional bedroom (beyond 3) and each additional bath (beyond 2).
   A size the sheet doesn't list (e.g. 1 bed + 2 bath, 3 bed + 1 bath) uses the smallest
   listed size that covers it.

   THE SAME TABLE ALSO LIVES IN booking-apps-script.gs (INSPECTION_PRICES and friends), because
   the booking script works out the fee again itself and never trusts the page. If the fee sheet
   changes, update BOTH files (the harness check in the README catches a mismatch). */
(function () {
  "use strict";

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

  // Every property type, in menu order: [value, translation key, English fallback].
  var TYPES = [
    ["house_single", "price_row_single", "Single storey building"],
    ["house_double", "price_row_double", "Double storey building"],
    ["townhouse_1", "price_row_th1", "Single storey townhouse"],
    ["townhouse_2", "price_row_th2", "2 storey townhouse"],
    ["townhouse_3", "price_row_th3", "3 storey townhouse"],
    ["city_apartment", "price_row_city", "City apartment"],
    ["suburban_apartment", "price_row_sub", "Suburban apartment (no parking fee)"],
    ["pest_slab", "price_row_pest_slab", "Pest control (concrete slab floor)"],
    ["pest_sub", "price_row_pest_sub", "Pest control (sub floor)"]
  ];

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function isPest(type) { return has(PEST, type); }
  function isKnown(type) { return isPest(type) || has(PRICES, type); }
  function poolAvailable(type) { return has(POOL_AVAILABLE, type); }

  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2);
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

  // The fee for one inspection. beds/baths are ignored for pest control. Returns
  // { lines, subtotal, gst, total }; each line is { key, fallback, amount | included, count }.
  function calculate(type, beds, baths, pci, pool) {
    var lines = [];
    var subtotal;
    if (isPest(type)) {
      subtotal = PEST[type];
      lines.push({ key: "price_line_base", fallback: "Inspection fee", amount: subtotal });
    } else {
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
      if (pci) {
        subtotal += PCI_FEE;
        lines.push({ key: "price_line_pci", fallback: "Practical Completion Inspection (PCI)", amount: PCI_FEE });
      }
      if (pool && poolAvailable(type)) lines.push({ key: "price_line_pool", fallback: "Swimming pool inspection", included: true });
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

  // Draws a calculate() result into `el` (a .price-result box). t(key, fallback) supplies the
  // words in the visitor's language. Text only (textContent), never HTML.
  function render(el, result, t) {
    el.textContent = "";
    var title = document.createElement("p");
    title.className = "price-result-title";
    title.textContent = t("price_result_title", "Your inspection fee");
    el.appendChild(title);
    result.lines.forEach(function (ln) {
      var label = t(ln.key, ln.fallback);
      if (ln.count) label += " (" + ln.count + " × " + money(EXTRA_ROOM) + ")";
      el.appendChild(row(label, ln.included ? t("price_included", "Included") : money(ln.amount)));
    });
    el.appendChild(row(t("price_line_gst", "GST (10%)"), money(result.gst)));
    el.appendChild(row(t("price_line_total", "Total incl. GST"), money(result.total), "price-result-total"));
  }

  window.NexconPricing = {
    TYPES: TYPES, PRICES: PRICES, PEST: PEST, EXTRA_ROOM: EXTRA_ROOM, PCI_FEE: PCI_FEE, GST_RATE: GST_RATE,
    isPest: isPest, isKnown: isKnown, poolAvailable: poolAvailable, calculate: calculate, render: render, money: money
  };
})();
