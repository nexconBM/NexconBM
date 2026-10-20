/* Nexcon inspection booking widget. Renders a month-view calendar on the Building
   Inspections page; picking an enabled day shows its AM (10:00-1:00) and PM (2:00-5:00)
   slots below it.
   Backed by a Google Sheet through a small Google Apps Script "Web App" (see
   booking-apps-script.gs for that script and full setup instructions) -- free, no
   calendar login needed on the visitor's side, and the script uses a lock so two people
   booking the same slot at once can't both succeed.

   ONE-TIME SETUP:
     1. Create a Google Sheet with a tab named "Bookings" and header row:
          date | slot | name | email | phone | address | status | created
     2. Paste booking-apps-script.gs into that Sheet's Extensions > Apps Script editor.
     3. Deploy it as a Web App (Execute as: Me, Who has access: Anyone).
     4. Paste the deployment URL below as WEBAPP_URL, replacing the placeholder.

   The booking form also asks about the property (type, bedrooms, bathrooms, pool, Practical
   Completion) and shows the inspection fee live, using the table in pricing.js. Those answers
   are sent with the booking; the Apps Script works the fee out again itself and puts it in the
   emails and on the Contacts tab.

   Rules enforced both here (for a responsive UI) and again inside the Apps Script (so
   nothing relies on the visitor's browser playing fair):
     - A slot can only be booked at least 3 business days (Mon-Fri) ahead, e.g. today
       being Friday, the earliest bookable day is next Wednesday.
     - A slot can't be booked more than 30 days ahead.
     - No inspections on Saturday or Sunday.

   There's no self-service cancellation on the site (a self-cancel link turned out to be
   unreliable: some email apps, notably Outlook, render emailed links inside their own
   embedded frame, which Google's pages refuse to load inside, and email+date+time alone
   isn't a real credential either). Instead the booking note tells visitors to email the
   business to cancel; staff then just change that row's "status" to "cancelled" directly
   in the Sheet.

   One more rule is enforced ONLY here, not in the Apps Script: at most 3 active
   bookings per browser, tracked in localStorage the same way the enquiry form tracks
   its daily message limit. It's a courtesy limit, not a real security control -- someone
   clearing their browser storage or using a different browser isn't stopped by it. Since
   a cancellation happens by staff editing the Sheet directly (not through this browser at
   all), this browser's list is reconciled against the live sheet on every load/refresh,
   dropping any entry the sheet no longer shows as booked.

   A note on how slot buttons update: after a booking, a race-condition warning, or a
   cancellation, this script never re-renders the whole calendar in one go -- that would
   wipe out whatever success/warning message was just shown before anyone could read it.
   Instead each slot button has a stable id ("slot-YYYY-MM-DD-AM"), and swapping a single
   slot between "open" and "taken" just replaces that one button. A background refetch
   keeps the full list in sync for next time the calendar is redrawn (e.g. on a language
   switch). */
(function () {
  var WEBAPP_URL = "https://script.google.com/macros/s/AKfycbwVwnFCEoUFW2af6UNKjDgD9rJiawx79QUXpHPcbdRQ59AxBuukAo_o-sbrHgbk5VTa/exec";

  var widget = document.getElementById("booking-widget");
  if (!widget) return;
  if (WEBAPP_URL.indexOf("PASTE_YOUR") === 0) return; // not set up yet
  var P = window.NexconPricing; // the inspection fee table and maths (pricing.js, loaded just before this file)
  if (!P) return;

  var SLOT_LABELS = { AM: "10:00 AM – 1:00 PM", PM: "2:00 PM – 5:00 PM" };
  var MAX_DAYS_AHEAD = 30;
  var MIN_LEAD_BUSINESS_DAYS = 3; // weekends don't count towards the notice period
  var MAX_MY_BOOKINGS = 3; // active (not cancelled) bookings allowed from one browser
  var MAX_LEN = { name: 100, email: 254, phone: 15, address: 200 };
  // Exactly one address: no spaces, commas or semicolons (MailApp treats a comma-separated
  // string as several recipients).
  var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

  // Trims, caps the length, and drops leading = + - @ characters. Google Sheets treats a
  // cell starting with one of those as a formula, and no real name or address needs them.
  // Browser-side only, so it protects honest visitors' rows, not against someone calling
  // the Apps Script directly -- that check belongs in booking-apps-script.gs as well.
  function cleanText(value, max) {
    return value.trim().replace(/^[=+\-@\s]+/, "").slice(0, max);
  }

  // A courtesy limit only, tracked in this browser's own storage -- same spirit as the
  // enquiry form's daily cap. It stops one visitor holding lots of slots at once, but
  // someone clearing site data or using a different browser isn't blocked by it.
  function getMyBookings() {
    try { return JSON.parse(localStorage.getItem("nexconMyBookings") || "[]"); } catch (e) { return []; }
  }
  function saveMyBookings(list) {
    try { localStorage.setItem("nexconMyBookings", JSON.stringify(list)); } catch (e) { /* storage blocked: limit just isn't tracked */ }
  }
  function addMyBooking(date, slot) {
    var list = getMyBookings();
    list.push({ date: date, slot: slot });
    saveMyBookings(list);
  }
  var bookedSet = {}; // "YYYY-MM-DD_AM" -> true
  var selected = null; // { date, slot }
  var bookingCaptcha = null; // the "I'm not a robot" check on the open booking form
  var selectedDate = null; // "YYYY-MM-DD" of the day currently expanded under the calendar

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function slotStart(dateStr, slot) {
    var parts = dateStr.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], slot === "AM" ? 10 : 14, 0, 0);
  }
  function slotId(date, slot) { return "slot-" + date + "-" + slot; }

  // "Today" starts as this device's clock, then is replaced by the server's Melbourne date
  // as soon as the booking sheet answers (see fetchBooked), so a wrong laptop/phone clock
  // can't shift which days are offered.
  var todayDateOnly, earliestDateOnly, maxDateOnly, viewYear, viewMonth;
  function setToday(y, m, d) { // m is 0-indexed
    todayDateOnly = new Date(y, m, d);
    // Earliest bookable day: today plus 3 weekdays (Fri -> Wed, Mon -> Thu).
    earliestDateOnly = new Date(y, m, d);
    for (var added = 0; added < MIN_LEAD_BUSINESS_DAYS; ) {
      earliestDateOnly.setDate(earliestDateOnly.getDate() + 1);
      var dayOfWeek = earliestDateOnly.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) added++;
    }
    maxDateOnly = new Date(y, m, d + MAX_DAYS_AHEAD);
  }
  var deviceNow = new Date();
  setToday(deviceNow.getFullYear(), deviceNow.getMonth(), deviceNow.getDate());
  var viewSynced = false;
  viewYear = todayDateOnly.getFullYear();
  viewMonth = todayDateOnly.getMonth(); // 0-indexed, persists across re-renders (e.g. a language switch) so navigating months isn't lost
  function esc(value) {
    var div = document.createElement("div");
    div.textContent = value || "";
    return div.innerHTML;
  }

  function currentLang() {
    try { return localStorage.getItem("nexcon-lang") || "en"; } catch (e) { return "en"; }
  }
  function t(key, fallback) {
    var dict = (typeof translations !== "undefined" && translations[currentLang()]) || {};
    return dict[key] || fallback;
  }

  function fetchBooked() {
    return fetch(WEBAPP_URL)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        bookedSet = {};
        (data.booked || []).forEach(function (key) { bookedSet[key] = true; });
        var serverToday = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.today || "");
        if (serverToday) {
          setToday(+serverToday[1], +serverToday[2] - 1, +serverToday[3]);
          if (!viewSynced) { viewYear = todayDateOnly.getFullYear(); viewMonth = todayDateOnly.getMonth(); viewSynced = true; }
        }
        // A booking tracked locally may have been cancelled from elsewhere (the email
        // link works from any device), so drop anything the sheet no longer shows as
        // booked -- otherwise this browser's limit could stay stuck at 3 forever.
        var mine = getMyBookings();
        var stillBooked = mine.filter(function (b) { return bookedSet[b.date + "_" + b.slot]; });
        if (stillBooked.length !== mine.length) saveMyBookings(stillBooked);
      });
  }

  function slotsForDate(dateStr) {
    var parts = dateStr.split("-").map(Number);
    var dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay(); // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) return []; // no inspections on weekends
    var slots = [];
    if (new Date(parts[0], parts[1] - 1, parts[2]) < earliestDateOnly) return slots; // too soon: don't offer it at all
    ["AM", "PM"].forEach(function (slot) {
      slots.push({ slot: slot, taken: !!bookedSet[dateStr + "_" + slot] });
    });
    return slots;
  }

  function dateInRange(dateObj) {
    return dateObj >= todayDateOnly && dateObj <= maxDateOnly;
  }

  function formatDay(d) {
    return d.toLocaleDateString(currentLang() === "zh" ? "zh-Hant" : "en-AU", { weekday: "short", day: "numeric", month: "short" });
  }

  function monthLabel(year, month) {
    return new Date(year, month, 1).toLocaleDateString(currentLang() === "zh" ? "zh-Hant" : "en-AU", { month: "long", year: "numeric" });
  }
  var WEEKDAY_LABELS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var WEEKDAY_LABELS_ZH = ["一", "二", "三", "四", "五", "六", "日"];

  function slotButtonHtml(date, slot, taken) {
    var id = slotId(date, slot);
    if (taken) {
      return '<button type="button" id="' + id + '" class="booking-slot is-taken" disabled>' + esc(SLOT_LABELS[slot]) +
        '<span class="booking-slot-tag">' + esc(t("book_taken", "Booked")) + "</span></button>";
    }
    return '<button type="button" id="' + id + '" class="booking-slot" data-date="' + date + '" data-slot="' + slot + '">' + esc(SLOT_LABELS[slot]) + "</button>";
  }

  function bindSlotClick(btn) {
    btn.addEventListener("click", function () {
      if (getMyBookings().length >= MAX_MY_BOOKINGS) {
        renderLimitReached();
        return;
      }
      selected = { date: btn.getAttribute("data-date"), slot: btn.getAttribute("data-slot") };
      widget.querySelectorAll(".booking-slot").forEach(function (b) { b.classList.remove("is-selected"); });
      btn.classList.add("is-selected");
      renderBookingForm();
    });
  }

  function renderLimitReached() {
    var wrap = document.getElementById("booking-form-wrap");
    wrap.hidden = false;
    wrap.innerHTML = '<p class="contact-warning">' + esc(t("book_limit_reached", "You've reached the limit of " + MAX_MY_BOOKINGS + " active bookings from this device. Please cancel one below first, or call us on +61 411 330 962.")) + "</p>";
    wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function render() {
    var html = '<p class="booking-cancel-note">' + esc(t("book_cancel_note", "Need to cancel or reschedule? Email us at building@nexcongroup.com.au at least 24 hours beforehand and we'll take care of it.")) + "</p>";
    html += '<div class="booking-calendar" id="booking-calendar"></div>';
    html += '<div class="booking-slots-wrap" id="booking-slots-wrap" hidden></div>';
    html += '<div class="booking-form-wrap" id="booking-form-wrap" hidden></div>';
    widget.innerHTML = html;

    renderCalendar();
    if (selectedDate) renderSlotsForSelectedDate();
  }

  function renderCalendar() {
    var calWrap = document.getElementById("booking-calendar");
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var leading = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7; // Monday-first grid

    var canPrev = new Date(viewYear, viewMonth, 1) > new Date(todayDateOnly.getFullYear(), todayDateOnly.getMonth(), 1);
    // Browsing ahead is allowed one month past the bookable window (those days just show
    // disabled) so visitors can see what's coming next, without scrolling indefinitely.
    var canNext = new Date(viewYear, viewMonth, 1) < new Date(todayDateOnly.getFullYear(), todayDateOnly.getMonth() + 1, 1);

    var html = '<div class="booking-cal-header">' +
      '<button type="button" class="booking-cal-nav" id="calPrev"' + (canPrev ? "" : " disabled") + ' aria-label="Previous month">‹</button>' +
      '<p class="booking-cal-month">' + esc(monthLabel(viewYear, viewMonth)) + "</p>" +
      '<button type="button" class="booking-cal-nav" id="calNext"' + (canNext ? "" : " disabled") + ' aria-label="Next month">›</button>' +
      "</div>";
    html += '<div class="booking-cal-weekdays">';
    (currentLang() === "zh" ? WEEKDAY_LABELS_ZH : WEEKDAY_LABELS_EN).forEach(function (w) { html += "<span>" + w + "</span>"; });
    html += "</div>";
    html += '<div class="booking-cal-grid">';
    for (var i = 0; i < leading; i++) html += '<div class="booking-cal-day is-empty"></div>';
    for (var day = 1; day <= daysInMonth; day++) {
      var dateObj = new Date(viewYear, viewMonth, day);
      var dateStr = isoDate(dateObj);
      var bookable = dateInRange(dateObj) && slotsForDate(dateStr).length > 0;
      var cls = "booking-cal-day" + (dateStr === selectedDate ? " is-selected" : "");
      html += bookable
        ? '<button type="button" class="' + cls + '" data-date="' + dateStr + '">' + day + "</button>"
        : '<button type="button" class="' + cls + '" disabled>' + day + "</button>";
    }
    html += "</div>";
    calWrap.innerHTML = html;

    if (canPrev) {
      document.getElementById("calPrev").addEventListener("click", function () {
        viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        renderCalendar();
      });
    }
    if (canNext) {
      document.getElementById("calNext").addEventListener("click", function () {
        viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        renderCalendar();
      });
    }
    calWrap.querySelectorAll(".booking-cal-day[data-date]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedDate = btn.getAttribute("data-date");
        selected = null;
        document.getElementById("booking-form-wrap").hidden = true;
        calWrap.querySelectorAll(".booking-cal-day.is-selected").forEach(function (b) { b.classList.remove("is-selected"); });
        btn.classList.add("is-selected");
        renderSlotsForSelectedDate();
      });
    });
  }

  function renderSlotsForSelectedDate() {
    var wrap = document.getElementById("booking-slots-wrap");
    var slots = slotsForDate(selectedDate);
    var parts = selectedDate.split("-").map(Number);
    var dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
    var html = '<p class="booking-date">' + esc(formatDay(dateObj)) + '</p><div class="booking-slots">';
    slots.forEach(function (s) { html += slotButtonHtml(selectedDate, s.slot, s.taken); });
    html += "</div>";
    wrap.hidden = false;
    wrap.innerHTML = html;
    wrap.querySelectorAll(".booking-slot:not(.is-taken)").forEach(bindSlotClick);
    wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Swaps one already-rendered slot button between "open" and "taken" by its stable id,
  // WITHOUT touching the rest of the widget -- used right after a booking or
  // cancellation so any success/warning message just shown stays on screen instead of
  // being wiped out by a full re-render.
  function setSlotState(date, slot, taken) {
    var btn = document.getElementById(slotId(date, slot));
    if (!btn) return; // slot isn't currently rendered (e.g. scrolled out of the 30-day window)
    var temp = document.createElement("div");
    temp.innerHTML = slotButtonHtml(date, slot, taken);
    var next = temp.firstChild;
    btn.replaceWith(next);
    if (!taken) bindSlotClick(next);
  }

  // The "About the property" part of the booking form: type, bedrooms, bathrooms, pool, PCI, and
  // the fee worked out live from them. The server works the fee out again itself from the same
  // answers (see handleBook_ in booking-apps-script.gs), so this is only to show the visitor the price.
  function propertyFieldsHtml() {
    var pick = '<option value="">' + esc(t("price_select", "Select…")) + "</option>";
    var types = pick;
    P.TYPES.forEach(function (ty) { types += '<option value="' + ty[0] + '">' + esc(t(ty[1], ty[2])) + "</option>"; });
    function numbers(max) {
      var html = pick;
      for (var i = 1; i <= max; i++) html += '<option value="' + i + '">' + i + "</option>";
      return html;
    }
    return '<p class="detail-label" style="margin-top:1.2rem;">' + esc(t("book_property_heading", "About the property")) + "</p>" +
      '<div class="field"><label for="bookType">' + esc(t("price_label_type", "Property type")) + '</label><select id="bookType" name="property_type">' + types + "</select></div>" +
      '<div class="field-row" id="bookSizeRow">' +
      '<div class="field"><label for="bookBeds">' + esc(t("price_label_beds", "Bedrooms")) + '</label><select id="bookBeds" name="bedrooms">' + numbers(6) + "</select></div>" +
      '<div class="field"><label for="bookBaths">' + esc(t("price_label_baths", "Bathrooms")) + '</label><select id="bookBaths" name="bathrooms">' + numbers(5) + "</select></div></div>" +
      '<div class="field" id="bookPoolField" hidden><label class="check-option"><input type="checkbox" id="bookPool"><span>' + esc(t("price_pool_label", "Swimming pool inspection")) + "</span></label></div>" +
      '<div class="field" id="bookPciField"><label class="check-option"><input type="checkbox" id="bookPci"><span>' + esc(t("price_pci_label", "Practical Completion Inspection (PCI) of a new house or apartment (+$50)")) + "</span></label></div>" +
      '<div class="price-result" id="bookFee" style="margin-bottom:1.2rem;" aria-live="polite" hidden></div>';
  }

  // Shows/hides the property fields that only apply to some types, and redraws the fee.
  function syncProperty() {
    var type = document.getElementById("bookType").value;
    var pest = P.isPest(type);
    var pci = document.getElementById("bookPci");
    var pool = document.getElementById("bookPool");
    document.getElementById("bookSizeRow").style.display = pest ? "none" : "";
    document.getElementById("bookPciField").hidden = pest;
    document.getElementById("bookPoolField").hidden = !P.poolAvailable(type);
    if (pest) pci.checked = false;
    if (!P.poolAvailable(type)) pool.checked = false;
    var beds = parseInt(document.getElementById("bookBeds").value, 10);
    var baths = parseInt(document.getElementById("bookBaths").value, 10);
    var fee = document.getElementById("bookFee");
    if (type && (pest || (beds && baths))) {
      P.render(fee, P.calculate(type, beds, baths, pci.checked, pool.checked), t);
      fee.hidden = false;
    } else {
      fee.textContent = "";
      fee.hidden = true;
    }
  }

  function renderBookingForm() {
    var wrap = document.getElementById("booking-form-wrap");
    var dateLabel = formatDay(slotStart(selected.date, selected.slot));
    wrap.hidden = false;
    wrap.innerHTML =
      '<form class="contact-form booking-form" id="bookingForm" style="margin-top:1.5rem;">' +
      '<p class="detail-label">' + esc(t("book_selected_label", "Selected")) + ": " + esc(dateLabel) + ", " + esc(SLOT_LABELS[selected.slot]) + "</p>" +
      propertyFieldsHtml() +
      '<p class="detail-label">' + esc(t("book_contact_heading", "Your details")) + "</p>" +
      '<div class="field-row"><div class="field"><label>' + esc(t("contact_label_name", "Name")) + '</label><input type="text" name="name" id="bookName" autocomplete="name" maxlength="' + MAX_LEN.name + '" required></div>' +
      '<div class="field"><label>' + esc(t("contact_label_email", "Email")) + '</label><input type="email" name="email" id="bookEmail" autocomplete="email" maxlength="' + MAX_LEN.email + '"></div></div>' +
      '<div class="field-row"><div class="field"><label>' + esc(t("contact_label_phone", "Phone")) + '</label><input type="tel" name="phone" id="bookPhone" autocomplete="tel" inputmode="numeric" pattern="[0-9]+" title="Numbers only" maxlength="' + MAX_LEN.phone + '"></div>' +
      '<div class="field"><label>' + esc(t("book_address_label", "Property address")) + ' <span class="optional">' + esc(t("contact_optional", "optional")) + '</span></label><input type="text" name="address" id="bookAddress" maxlength="' + MAX_LEN.address + '"></div></div>' +
      '<p class="field-hint">' + esc(t("contact_either_hint", "Please give us an email address or a phone number (you only need one).")) + "</p>" +
      '<div class="captcha-box" id="bookCaptcha"></div>' +
      '<button type="submit" class="pill pill-primary booking-submit">' + esc(t("book_submit_btn", "Confirm booking")) + "</button>" +
      '<p class="contact-error" id="bookError" style="display:none;"></p>' +
      '<div class="contact-success" id="bookSuccess" style="display:none;"><p class="contact-success-title">' + esc(t("book_success_title", "Booking confirmed")) + '</p><p class="contact-success-body">' + esc(t("book_success_body", "We've emailed you the details.")) + "</p></div>" +
      "</form>";
    wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });

    // Each time the form is rebuilt (another slot picked) the old check is thrown away first.
    if (bookingCaptcha) bookingCaptcha.remove();
    bookingCaptcha = window.NexconCaptcha ? window.NexconCaptcha.mount(document.getElementById("bookCaptcha")) : null;

    ["bookType", "bookBeds", "bookBaths", "bookPci", "bookPool"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", syncProperty);
    });
    syncProperty();

    document.getElementById("bookingForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var thisSelection = selected; // capture now: selected is cleared as soon as this resolves
      var error = document.getElementById("bookError");
      var success = document.getElementById("bookSuccess");
      var submitBtn = e.target.querySelector(".booking-submit");
      error.style.display = "none";

      // The property details decide the fee, so they come first: a type, plus bedrooms and
      // bathrooms unless it is pest control (a flat fee).
      var propType = document.getElementById("bookType").value;
      var propPest = P.isPest(propType);
      var propBeds = parseInt(document.getElementById("bookBeds").value, 10) || 0;
      var propBaths = parseInt(document.getElementById("bookBaths").value, 10) || 0;
      if (!propType || (!propPest && (!propBeds || !propBaths))) {
        error.textContent = bookErrorMessage("bad_property");
        error.style.display = "block";
        return;
      }

      var name = cleanText(document.getElementById("bookName").value, MAX_LEN.name);
      var email = document.getElementById("bookEmail").value.trim();
      var phone = document.getElementById("bookPhone").value.replace(/\D/g, "").slice(0, MAX_LEN.phone);
      var address = cleanText(document.getElementById("bookAddress").value, MAX_LEN.address);
      if (!name) {
        error.textContent = bookErrorMessage("missing_fields");
        error.style.display = "block";
        return;
      }
      if (!email && !phone) {
        error.textContent = bookErrorMessage("need_contact");
        error.style.display = "block";
        return;
      }
      if (email && (!EMAIL_RE.test(email) || email.length > MAX_LEN.email)) {
        error.textContent = t("book_error_email", "Please enter one valid email address.");
        error.style.display = "block";
        return;
      }
      var captchaToken = bookingCaptcha ? bookingCaptcha.token() : "";
      if (!captchaToken) {
        error.textContent = bookErrorMessage("captcha_failed");
        error.style.display = "block";
        return;
      }
      submitBtn.disabled = true;

      fetch(WEBAPP_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "book",
          date: thisSelection.date,
          slot: thisSelection.slot,
          name: name,
          email: email,
          phone: phone,
          address: address,
          property_type: propType,
          bedrooms: propPest ? 0 : propBeds,
          bathrooms: propPest ? 0 : propBaths,
          pci: !propPest && document.getElementById("bookPci").checked,
          pool: !propPest && P.poolAvailable(propType) && document.getElementById("bookPool").checked,
          captcha: captchaToken
        })
      })
        .then(function (res) { return res.json(); })
        .then(function (result) {
          bookedSet[thisSelection.date + "_" + thisSelection.slot] = result.ok || result.error === "taken";
          if (result.ok) {
            e.target.querySelectorAll(".field, .field-hint, .detail-label, .booking-submit").forEach(function (el) { el.style.display = "none"; });
            // No email address means no confirmation email, so say something that is still true.
            if (!email) success.querySelector(".contact-success-body").textContent = t("book_success_body_phone", "Your booking is confirmed. If your plans change, please call us on +61 411 330 962 or email building@nexcongroup.com.au at least 24 hours beforehand.");
            success.style.display = "block";
            setSlotState(thisSelection.date, thisSelection.slot, true);
            addMyBooking(thisSelection.date, thisSelection.slot);
            selected = null;
            fetchBooked(); // background refresh, doesn't touch the DOM itself
            return;
          }
          error.textContent = bookErrorMessage(result.error);
          error.style.display = "block";
          if (bookingCaptcha) bookingCaptcha.reset(); // a check only works once
          if (result.error === "taken") {
            setSlotState(thisSelection.date, thisSelection.slot, true);
            selected = null;
            e.target.querySelectorAll(".field, .detail-label, .price-result, .booking-submit").forEach(function (el) { el.style.display = "none"; });
            error.insertAdjacentHTML("afterend", '<p><button type="button" class="text-link" id="bookPickAnother" style="background:none;border:0;cursor:pointer;padding:0;">' + esc(t("book_pick_another", "Choose another slot ↑")) + "</button></p>");
            document.getElementById("bookPickAnother").addEventListener("click", function () {
              document.getElementById("booking-calendar").scrollIntoView({ block: "start", behavior: "smooth" });
            });
            fetchBooked();
          } else {
            submitBtn.disabled = false;
          }
        })
        .catch(function () {
          error.textContent = t("book_error_generic", "Something went wrong. Please try again, or call us on +61 411 330 962.");
          error.style.display = "block";
          if (bookingCaptcha) bookingCaptcha.reset();
          submitBtn.disabled = false;
        });
    });
  }

  function bookErrorMessage(code) {
    var map = {
      taken: t("book_error_taken", "Sorry — that slot was just booked by someone else. Please choose another below."),
      too_soon: t("book_error_too_soon", "That time is less than 3 business days away. Please choose a later slot."),
      too_far: t("book_error_too_far", "That date is more than a month away. Please choose a closer slot."),
      weekend: t("book_error_weekend", "Inspections aren't available on weekends. Please choose a weekday."),
      missing_fields: t("book_error_missing", "Please enter your name."),
      need_contact: t("contact_error_either", "Please give us an email address or a phone number so we can reach you."),
      bad_email: t("book_error_email", "Please enter one valid email address."),
      bad_phone: t("book_error_phone", "Please enter a phone number using digits only."),
      bad_property: t("book_error_property", "Please choose the property type, bedrooms and bathrooms so we can work out the fee."),
      email_limit: t("contact_error_today", "We've reached our daily limit for online requests. Please try again tomorrow, or call us on +61 411 330 962."),
      captcha_failed: t("contact_error_captcha", "Please complete the robot check (tick the box if one appears) and try again."),
      limit: t("book_error_limit", "You already have 3 upcoming bookings. Please email us if you need to change one."),
      busy: t("book_error_generic", "Something went wrong. Please try again, or call us on +61 411 330 962.")
    };
    return map[code] || t("book_error_generic", "Something went wrong. Please try again, or call us on +61 411 330 962.");
  }

  fetchBooked()
    .then(render)
    .catch(function () {
      widget.innerHTML = '<p class="contact-error">' + esc(t("book_error_generic", "Something went wrong. Please try again, or call us on +61 411 330 962.")) + "</p>";
    });

  // The language toggle re-applies data-i18n text globally, but this widget's slot
  // labels and messages aren't static data-i18n elements, so re-render for the new
  // language too -- only when nothing is mid-flow (a selection or open form).
  var toggle = document.getElementById("langToggle");
  // setTimeout so this runs after i18n.js's own click handler has saved the new language;
  // this script's listener is registered first, so redrawing immediately would still read the old one.
  if (toggle) toggle.addEventListener("click", function () { setTimeout(function () { if (!selected) render(); }, 0); });
})();
