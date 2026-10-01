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

   Rules enforced both here (for a responsive UI) and again inside the Apps Script (so
   nothing relies on the visitor's browser playing fair):
     - A slot can only be booked at least 24 hours before it starts.
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
  var WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxxMu4t1qX6kxvqTSVsy56tOpYVj9D-uZylQ7xrmFdbLUxdNwiGm_tBOy7PBiXuu9YZkQ/exec";

  var widget = document.getElementById("booking-widget");
  if (!widget) return;
  if (WEBAPP_URL.indexOf("PASTE_YOUR") === 0) return; // not set up yet

  var SLOT_LABELS = { AM: "10:00 AM – 1:00 PM", PM: "2:00 PM – 5:00 PM" };
  var MAX_DAYS_AHEAD = 30;
  var MIN_LEAD_HOURS = 24;
  var MAX_MY_BOOKINGS = 3; // active (not cancelled) bookings allowed from one browser

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
  var selectedDate = null; // "YYYY-MM-DD" of the day currently expanded under the calendar

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function slotStart(dateStr, slot) {
    var parts = dateStr.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], slot === "AM" ? 10 : 14, 0, 0);
  }
  function slotId(date, slot) { return "slot-" + date + "-" + slot; }

  var todayDateOnly = new Date();
  todayDateOnly.setHours(0, 0, 0, 0);
  var maxDateOnly = new Date(todayDateOnly.getFullYear(), todayDateOnly.getMonth(), todayDateOnly.getDate() + MAX_DAYS_AHEAD);
  var viewYear = todayDateOnly.getFullYear();
  var viewMonth = todayDateOnly.getMonth(); // 0-indexed, persists across re-renders (e.g. a language switch) so navigating months isn't lost
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
    var now = new Date();
    var slots = [];
    ["AM", "PM"].forEach(function (slot) {
      var start = slotStart(dateStr, slot);
      var hoursUntil = (start - now) / 3600000;
      if (hoursUntil < MIN_LEAD_HOURS) return; // too soon: don't offer it at all
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

  function renderBookingForm() {
    var wrap = document.getElementById("booking-form-wrap");
    var dateLabel = formatDay(slotStart(selected.date, selected.slot));
    wrap.hidden = false;
    wrap.innerHTML =
      '<form class="contact-form booking-form" id="bookingForm" style="margin-top:1.5rem;">' +
      '<p class="detail-label">' + esc(t("book_selected_label", "Selected")) + ": " + esc(dateLabel) + ", " + esc(SLOT_LABELS[selected.slot]) + "</p>" +
      '<div class="field-row"><div class="field"><label>' + esc(t("contact_label_name", "Name")) + '</label><input type="text" name="name" id="bookName" autocomplete="name" required></div>' +
      '<div class="field"><label>' + esc(t("contact_label_email", "Email")) + '</label><input type="email" name="email" id="bookEmail" autocomplete="email" required></div></div>' +
      '<div class="field-row"><div class="field"><label>' + esc(t("contact_label_phone", "Phone")) + '</label><input type="tel" name="phone" id="bookPhone" autocomplete="tel" inputmode="numeric" pattern="[0-9]+" title="Numbers only" required></div>' +
      '<div class="field"><label>' + esc(t("book_address_label", "Property address")) + '</label><input type="text" name="address" id="bookAddress" required></div></div>' +
      '<button type="submit" class="pill pill-primary booking-submit">' + esc(t("book_submit_btn", "Confirm booking")) + "</button>" +
      '<p class="contact-error" id="bookError" style="display:none;"></p>' +
      '<div class="contact-success" id="bookSuccess" style="display:none;"><p class="contact-success-title">' + esc(t("book_success_title", "Booking confirmed")) + '</p><p class="contact-success-body">' + esc(t("book_success_body", "We've emailed you the details.")) + "</p></div>" +
      "</form>";
    wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });

    document.getElementById("bookingForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var thisSelection = selected; // capture now: selected is cleared as soon as this resolves
      var error = document.getElementById("bookError");
      var success = document.getElementById("bookSuccess");
      var submitBtn = e.target.querySelector(".booking-submit");
      error.style.display = "none";
      submitBtn.disabled = true;

      fetch(WEBAPP_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "book",
          date: thisSelection.date,
          slot: thisSelection.slot,
          name: document.getElementById("bookName").value,
          email: document.getElementById("bookEmail").value,
          phone: document.getElementById("bookPhone").value,
          address: document.getElementById("bookAddress").value
        })
      })
        .then(function (res) { return res.json(); })
        .then(function (result) {
          bookedSet[thisSelection.date + "_" + thisSelection.slot] = result.ok || result.error === "taken";
          if (result.ok) {
            e.target.querySelectorAll(".field, .detail-label, .booking-submit").forEach(function (el) { el.style.display = "none"; });
            success.style.display = "block";
            setSlotState(thisSelection.date, thisSelection.slot, true);
            addMyBooking(thisSelection.date, thisSelection.slot);
            selected = null;
            fetchBooked(); // background refresh, doesn't touch the DOM itself
            return;
          }
          error.textContent = bookErrorMessage(result.error);
          error.style.display = "block";
          if (result.error === "taken") {
            setSlotState(thisSelection.date, thisSelection.slot, true);
            selected = null;
            e.target.querySelectorAll(".field, .detail-label, .booking-submit").forEach(function (el) { el.style.display = "none"; });
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
          submitBtn.disabled = false;
        });
    });
  }

  function bookErrorMessage(code) {
    var map = {
      taken: t("book_error_taken", "Sorry — that slot was just booked by someone else. Please choose another below."),
      too_soon: t("book_error_too_soon", "That time is less than 24 hours away. Please choose a later slot."),
      too_far: t("book_error_too_far", "That date is more than a month away. Please choose a closer slot."),
      weekend: t("book_error_weekend", "Inspections aren't available on weekends. Please choose a weekday."),
      missing_fields: t("book_error_missing", "Please fill in every field."),
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
  if (toggle) toggle.addEventListener("click", function () { if (!selected) render(); });
})();
