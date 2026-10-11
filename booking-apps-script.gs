/* Nexcon inspection booking backend.
   The Sheet needs one tab named exactly "Bookings" with this header row (row 1),
   in this exact order:
     date | slot | name | email | phone | address | status | created

   "date" is stored as YYYY-MM-DD text, "slot" is "AM" or "PM", "status" is "booked" or
   "cancelled". Don't type anything into those columns yourself -- the script fills them
   in as people book.

   There's no self-service cancellation here -- that was tried via a one-time link in the
   confirmation email, but turned out unreliable in practice: some email apps (notably
   Outlook) render emailed links inside their own embedded frame, and Google's pages
   refuse to load inside a foreign frame, breaking the link for exactly the people who
   needed it. Instead, the booking confirmation email just asks the customer to email the
   business to cancel; staff then cancel it manually by changing that row's "status" cell
   from "booked" to "cancelled" directly in this Sheet. */

const SHEET_NAME = 'Bookings';
const NOTIFY_EMAIL = 'building@nexcongroup.com.au'; // where booking emails go
const SLOT_LABELS = { AM: '10:00 AM - 1:00 PM', PM: '2:00 PM - 5:00 PM' };
const MAX_DAYS_AHEAD = 30;
const MIN_BUSINESS_DAYS = 3; // notice needed, counting Mon-Fri only
const TIME_ZONE = 'Australia/Melbourne'; // "today" for every rule below, whatever the script's own setting is

// Today's date in Melbourne as YYYY-MM-DD. The website asks for this (see doGet) so it
// never has to trust the visitor's own device clock.
function todayString_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

// Earliest bookable day = today + 3 business days (Fri -> Wed, Mon -> Thu), at 00:00.
function earliestBookable_() {
  const [y, m, d0] = todayString_().split('-').map(Number);
  const d = new Date(y, m - 1, d0);
  let added = 0;
  while (added < MIN_BUSINESS_DAYS) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No sheet tab named "' + SHEET_NAME + '" was found.');
  return sheet;
}

function columnIndex_(header) {
  const map = {};
  header.forEach((h, i) => { map[h] = i; });
  return map;
}

// Google Sheets silently converts a "2026-10-03"-shaped string into its own Date value
// when a row is written, unless the cell is explicitly forced to stay plain text. Once
// that happens, a value read back is a Date object, not the original string, so a plain
// "===" comparison against an incoming date string would never match -- which is exactly
// what broke the "is this slot already taken" check. This normalizes either shape back to
// a plain YYYY-MM-DD string before anything compares dates, so it's safe either way.
function normalizeDate_(value) {
  if (value instanceof Date) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  }
  return String(value).trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// GET: returns which date+slot combinations are currently booked, so the site can grey
// them out before anyone tries to click one.
function doGet(e) {
  const sheet = getSheet_();
  const rows = sheet.getDataRange().getValues();
  const col = columnIndex_(rows[0]);
  const booked = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.status] === 'booked') {
      booked.push(normalizeDate_(rows[i][col.date]) + '_' + rows[i][col.slot]);
    }
  }
  return json_({ ok: true, booked: booked, today: todayString_() });
}

// POST: makes a new booking. Uses a script-wide lock so two people clicking "book" on
// the same slot at the same moment can't both succeed -- whichever request gets the lock
// first checks and writes; the second sees it's already taken.
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'book') return handleBook_(data);
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: 'server_error' });
  } finally {
    lock.releaseLock();
  }
}

function handleBook_(data) {
  const { date, slot, name, email, phone, address } = data;
  if (!date || !slot || !name || !email || !phone || !address) {
    return json_({ ok: false, error: 'missing_fields' });
  }
  if (SLOT_LABELS[slot] === undefined) return json_({ ok: false, error: 'bad_slot' });

  const slotStart = slotStartDate_(date, slot);
  const dow = slotStart.getDay(); // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) return json_({ ok: false, error: 'weekend' });
  if (slotStart < earliestBookable_()) return json_({ ok: false, error: 'too_soon' });
  const [ty, tm, td] = todayString_().split('-').map(Number);
  const maxDate = new Date(ty, tm - 1, td + MAX_DAYS_AHEAD, 23, 59, 59);
  if (slotStart > maxDate) return json_({ ok: false, error: 'too_far' });

  const sheet = getSheet_();
  const rows = sheet.getDataRange().getValues();
  const col = columnIndex_(rows[0]);

  for (let i = 1; i < rows.length; i++) {
    if (normalizeDate_(rows[i][col.date]) === date && rows[i][col.slot] === slot && rows[i][col.status] === 'booked') {
      return json_({ ok: false, error: 'taken' });
    }
  }

  sheet.appendRow([date, slot, name, email, phone, address, 'booked', new Date()]);
  // Force the date cell we just wrote to stay plain text, so it reads back exactly as
  // typed rather than being silently reinterpreted as a Sheets date.
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, col.date + 1).setNumberFormat('@').setValue(date);

  const slotLabel = SLOT_LABELS[slot];

  MailApp.sendEmail(NOTIFY_EMAIL,
    'New inspection booking: ' + date + ' (' + slotLabel + ')',
    'Name: ' + name + '\nEmail: ' + email + '\nPhone: ' + phone + '\nAddress: ' + address +
    '\nDate: ' + date + '\nTime: ' + slotLabel);
  MailApp.sendEmail(email,
    'Your Nexcon inspection booking is confirmed',
    'Hi ' + name + ',\n\nYour building inspection is booked for:\n' + date + ', ' + slotLabel +
    '\nAddress: ' + address +
    '\n\nNeed to cancel or reschedule? Just reply to this email or call us, at least 24 ' +
    'hours before the appointment.' +
    '\n\nQuestions? Call +61 411 330 962 or reply to this email.' +
    '\n\nThanks,\nNexcon Building Management');

  return json_({ ok: true });
}

function slotStartDate_(dateStr, slot) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hour = slot === 'AM' ? 10 : 14;
  return new Date(y, m - 1, d, hour, 0, 0);
}
