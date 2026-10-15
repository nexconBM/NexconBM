/** @OnlyCurrentDoc */
// ^ Limits the permission this script asks for to the one Sheet it belongs to, rather
//   than every spreadsheet in the Google account. Keep this line.

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

// Limits on what a visitor may send. These mirror booking.js, but the browser's copy of the
// rules can be skipped by anyone who calls this script directly, so they are enforced here too.
const MAX_LEN = { name: 100, email: 254, phone: 15, address: 200 };
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/; // exactly one plain address
const MAX_ACTIVE_PER_EMAIL = 3; // future bookings one email address may hold at once
const MAX_BODY_CHARS = 4000;    // anything bigger than a normal booking request is refused

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

// Free text from a visitor (name, address): one line, no leading = + - @ (those can turn a
// Sheets cell into a formula), and no longer than allowed.
function cleanText_(value, max) {
  return String(value).trim().replace(/^[=+\-@\s]+/, '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

// True only for a real calendar date written as YYYY-MM-DD ("2026-02-31" is not one).
function isRealDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
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
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > MAX_BODY_CHARS) return json_({ ok: false, error: 'bad_request' });
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return json_({ ok: false, error: 'bad_request' });
    if (data.action === 'book') return handleBook_(data);
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: 'server_error' });
  } finally {
    lock.releaseLock();
  }
}

function handleBook_(data) {
  // Every field must arrive as a plain string -- not a number, list or object.
  for (const f of ['date', 'slot', 'name', 'email', 'phone', 'address']) {
    if (typeof data[f] !== 'string') return json_({ ok: false, error: 'missing_fields' });
  }
  const date = data.date.trim();
  const slot = data.slot; // must be exactly AM or PM, checked below
  const name = cleanText_(data.name, MAX_LEN.name);
  const email = data.email.trim();
  const phone = data.phone.trim();
  const address = cleanText_(data.address, MAX_LEN.address);

  if (!date || !slot || !name || !email || !phone || !address) {
    return json_({ ok: false, error: 'missing_fields' });
  }
  if (slot !== 'AM' && slot !== 'PM') return json_({ ok: false, error: 'bad_slot' });
  if (!isRealDate_(date)) return json_({ ok: false, error: 'bad_date' });
  if (email.length > MAX_LEN.email || !EMAIL_RE.test(email)) return json_({ ok: false, error: 'bad_email' });
  if (!/^\d{1,15}$/.test(phone)) return json_({ ok: false, error: 'bad_phone' });

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

  const today = todayString_();
  let activeForEmail = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.status] !== 'booked') continue;
    const rowDate = normalizeDate_(rows[i][col.date]);
    if (rowDate === date && rows[i][col.slot] === slot) return json_({ ok: false, error: 'taken' });
    // Only upcoming bookings count towards the cap, so a returning customer isn't blocked
    // by inspections that have already happened.
    if (rowDate >= today && String(rows[i][col.email]).trim().toLowerCase() === email.toLowerCase()) activeForEmail++;
  }
  if (activeForEmail >= MAX_ACTIVE_PER_EMAIL) return json_({ ok: false, error: 'limit' });

  // Format the new row as plain text BEFORE writing it. Otherwise Sheets reinterprets what it
  // is given: "2026-10-03" silently becomes a date (which broke the "already taken" check),
  // and anything starting with "=" would run as a formula.
  const newRow = sheet.getLastRow() + 1;
  const range = sheet.getRange(newRow, 1, 1, 8);
  range.setNumberFormat('@');
  range.setValues([[date, slot, name, email, phone, address, 'booked', Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss')]]);

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
