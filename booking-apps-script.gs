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
   from "booked" to "cancelled" directly in this Sheet.

   The website's contact (enquiry) form posts here too, as action "contact". It used to go to
   a third-party form service whose address, and the business email, sat in the page source,
   so spammers could post to it directly and skip every check on the page. Every filter for
   it now lives in handleContact_ below, where it can't be bypassed from the browser.

   Bookings and enquiries both also need a Cloudflare Turnstile ("I'm not a robot") token, which
   this script checks with Cloudflare before doing anything. The secret key is NOT in this file.
   Store it under Project Settings (gear icon) > Script properties as TURNSTILE_SECRET. Until it
   is stored, every booking and enquiry is refused on purpose, so a missing key can never
   silently switch the check off. After adding it, run checkSetup once from the editor.

   Google lets this account send only so many emails a day (about 100 on a free Gmail account).
   When 20 or fewer are left, ONE warning email goes to NOTIFY_EMAIL (once a day). When fewer
   than a request needs are left, new bookings and enquiries are refused up front, before
   anything is saved, and the visitor is told to try again tomorrow or phone. That way a booking
   is never saved while its emails can't be sent, and an enquiry is never silently lost.

   Enquiries that are refused for a link, spam wording, the hidden trap box or the rate limit are
   listed on a tab called "Blocked" (created automatically) in this same Sheet: time, reason, form,
   name, email, phone and what they wrote. Check it now and then in case a real customer was caught
   by mistake (then phone them, and tell the developer so the filter can be loosened). It keeps the
   newest 300 lines and logs at most 30 an hour. Robot-check failures are not listed.

   Phone numbers may contain single spaces and one + at the very start (cleanPhone_), with 1 to 15
   digits. The 3-bookings limit treats "0400 000 000" and "0400000000" as the same number.

   The customer's confirmation email carries the notice that the inspection report is released
   upon receipt of full payment (the website shows it prominently too).

   A booking also carries the property answers (type, bedrooms, bathrooms, pool, Practical Completion).
   This script works the inspection fee out from them itself (INSPECTION_PRICES below, a copy of
   pricing.js on the website) and puts it in both emails and on the Contacts line. The answers are
   optional here, so an older cached page can still book; a bad answer is refused as bad_property.

   A second automatic tab, "Contacts", gets one line for every accepted enquiry (a backup copy of the
   email) and every inspection booking (with its date, slot and address). It is never trimmed. It is
   only a record: the calendar and the booking limits read the "Bookings" tab alone, so nothing on
   "Contacts" can hold a time slot or stop anyone booking the same one. */

const SHEET_NAME = 'Bookings';
const NOTIFY_EMAIL = 'building@nexcongroup.com.au'; // where booking emails go
const SLOT_LABELS = { AM: '10:00 AM - 1:00 PM', PM: '2:00 PM - 5:00 PM' };
const MAX_DAYS_AHEAD = 30;
const MIN_BUSINESS_DAYS = 3; // notice needed, counting Mon-Fri only
const TIME_ZONE = 'Australia/Melbourne'; // "today" for every rule below, whatever the script's own setting is

// Limits on what a visitor may send. These mirror booking.js, but the browser's copy of the
// rules can be skipped by anyone who calls this script directly, so they are enforced here too.
const MAX_LEN = { name: 100, email: 254, phone: 25, address: 200 }; // phone: up to 15 digits plus spaces and a leading +
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/; // exactly one plain address
const MAX_ACTIVE_PER_EMAIL = 3; // future bookings one email address may hold at once
const MAX_BODY_CHARS = 8000;    // anything bigger than a normal booking/enquiry request is refused

// Inspection fees (AUD, before GST). THIS TABLE IS A COPY of the one in pricing.js on the website, and the
// two must always match: the page shows the visitor a fee, and this script works the same fee out again
// itself (never trusting the page) for the emails and the Contacts tab. Change both together.
const INSPECTION_PRICES = {      // [1 bed 1 bath, 2 bed 1 bath, 2 bed 2 bath, 3 bed 2 bath]
  house_single: [550, 550, 600, 650],
  house_double: [550, 550, 600, 650],
  townhouse_1: [550, 550, 600, 600],
  townhouse_2: [550, 550, 600, 650],
  townhouse_3: [550, 550, 600, 650],
  city_apartment: [550, 550, 600, 650],
  suburban_apartment: [500, 500, 550, 600]
};
const INSPECTION_TIERS = [[1, 1], [2, 1], [2, 2], [3, 2]]; // [bedrooms, bathrooms] each price above covers
const PEST_PRICES = { pest_slab: 300, pest_sub: 350 };     // flat fee
const POOL_TYPES = { house_single: true, house_double: true }; // swimming pool inspection: houses only, no extra charge
const EXTRA_ROOM_FEE = 50;       // each bedroom beyond 3 and each bathroom beyond 2
const PCI_FEE = 50;              // Practical Completion Inspection of a new house or apartment
const GST_RATE = 0.10;
const PROPERTY_LABELS = {
  house_single: 'House (single storey)', house_double: 'House (double storey)', townhouse_1: 'Single storey townhouse',
  townhouse_2: '2 storey townhouse', townhouse_3: '3 storey townhouse', city_apartment: 'City apartment',
  suburban_apartment: 'Suburban apartment', pest_slab: 'Pest control (concrete slab floor)', pest_sub: 'Pest control (sub floor)'
};

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Contact form limits.
const CONTACT_EMAIL = NOTIFY_EMAIL;     // where enquiries are sent
const MIN_MESSAGE_CHARS = 5;
const MAX_MESSAGE_CHARS = 2000;
const CONTACT_PER_HOUR = 20;            // accepted enquiries per hour, from everyone
const CONTACT_PER_EMAIL_PER_HOUR = 3;   // accepted enquiries per hour from one email address
const CONTACT_PER_DAY = 40;             // accepted enquiries per day, leaving mail quota for bookings

// Refused enquiries are listed on a tab called "Blocked" in this same Sheet (created automatically),
// so staff can spot a real customer who was caught by mistake. No email is used for this.
const BLOCKED_SHEET_NAME = 'Blocked';
const BLOCKED_HEADER = ['time', 'reason', 'form', 'name', 'email', 'phone', 'what they wrote'];
const BLOCKED_KEEP = 300;               // newest rows kept; older ones are deleted
const BLOCKED_PER_HOUR = 30;            // at most this many logged per hour, so a flood of junk can't fill the Sheet or slow real visitors

// Every enquiry that gets through, and every inspection booking, is also written as one line on a tab
// called "Contacts" (created automatically): a searchable record of everyone who got in touch. For an
// enquiry this is a backup copy of the email. This tab is only a record. The booking calendar never
// reads it, so a line here can never hold a time slot, count towards a booking limit, or block anyone.
const CONTACTS_SHEET_NAME = 'Contacts';
const CONTACTS_HEADER = ['received', 'type', 'name', 'email', 'phone', 'inspection date', 'slot', 'address', 'details', 'message', 'note'];

// Daily email allowance.
const EMAIL_WARN_AT = 20;   // email NOTIFY_EMAIL once a day when this many or fewer sends remain
const EMAIL_RESERVE = 6;    // never spend the last few on customers, so our own warning can always go out

// A genuine enquiry never contains these. Each pattern is specific enough that an ordinary
// building enquiry won't trip it (a dollar budget, for example, is deliberately NOT here).
const SPAM_PATTERNS = [
  /casino/i, /jackpot/i, /promo\s*code/i, /giveaway/i, /bitcoin/i, /crypto(currency)?\b/i,
  /forex/i, /viagra|cialis/i, /porn|escort/i, /backlinks?/i, /lotter(y|ies)/i,
  /spin the reels/i, /randomly (chosen|selected)/i, /click here/i, /\bseo (service|expert|package)/i
];

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

// True if the text contains a web link. Email addresses are ignored first, so someone who
// writes "reply to me@gmail.com" isn't refused.
function hasLink_(text) {
  const t = String(text).replace(/\S+@\S+/g, ' ');
  return /(https?:\/\/|ftp:\/\/|www\.)/i.test(t) ||
    /\b[a-z0-9-]{2,}\.(com|net|org|info|biz|xyz|top|click|link|ru|cn|shop|online|site|live|club|vip|bet|win|app|io|ly|gl)\b/i.test(t);
}

function money_(n) {
  return '$' + (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2);
}

// Reads the property answers that came with a booking (all optional, so a page that is still the
// older version can still book) and works the fee out. Returns:
//   { none: true }            no property answers were sent
//   { bad: true }             something is not allowed (unknown type, rooms out of range, wrong tick box)
//   { description, feeText }  e.g. "House (single storey), 3 bedrooms, 2 bathrooms"
//                             and  "$650 + GST $65 = $715 total"
function propertyFromRequest_(data) {
  if (data.property_type === undefined) return { none: true };
  const type = data.property_type;
  const has = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
  if (typeof type !== 'string' || !(has(INSPECTION_PRICES, type) || has(PEST_PRICES, type))) return { bad: true };
  for (const f of ['pci', 'pool']) {
    if (data[f] !== undefined && typeof data[f] !== 'boolean') return { bad: true };
  }
  let subtotal, description;
  if (has(PEST_PRICES, type)) {
    if (data.pci === true || data.pool === true) return { bad: true }; // pest control has neither
    subtotal = PEST_PRICES[type];
    description = PROPERTY_LABELS[type];
  } else {
    const beds = data.bedrooms, baths = data.bathrooms;
    if (!Number.isInteger(beds) || beds < 1 || beds > 6 || !Number.isInteger(baths) || baths < 1 || baths > 5) return { bad: true };
    if (data.pool === true && !has(POOL_TYPES, type)) return { bad: true };
    const cb = Math.min(beds, 3), cr = Math.min(baths, 2);
    const list = INSPECTION_PRICES[type];
    let base = list[list.length - 1];
    for (let i = 0; i < INSPECTION_TIERS.length; i++) {
      if (cb <= INSPECTION_TIERS[i][0] && cr <= INSPECTION_TIERS[i][1]) { base = list[i]; break; }
    }
    subtotal = base + Math.max(0, beds - 3) * EXTRA_ROOM_FEE + Math.max(0, baths - 2) * EXTRA_ROOM_FEE + (data.pci === true ? PCI_FEE : 0);
    description = PROPERTY_LABELS[type] + ', ' + beds + (beds === 1 ? ' bedroom, ' : ' bedrooms, ') + baths + (baths === 1 ? ' bathroom' : ' bathrooms') +
      (data.pci === true ? ', Practical Completion Inspection' : '') + (data.pool === true ? ', swimming pool inspection' : '');
  }
  const gst = subtotal * GST_RATE;
  return { description: description, feeText: money_(subtotal) + ' + GST ' + money_(gst) + ' = ' + money_(subtotal + gst) + ' total' };
}

function hasSpamWords_(text) {
  return SPAM_PATTERNS.some(function (re) { return re.test(text); });
}

// Phone numbers may have single spaces and one + at the very start ("+61 411 330 962", "0411 330 962"),
// and 1 to 15 digits (the international maximum). Returns '' when none was given, null when it is
// not allowed, otherwise the number with repeated spaces tidied. Nothing else gets through, so a
// leading + can never be part of a spreadsheet formula.
function cleanPhone_(raw) {
  const p = String(raw).trim().replace(/ {2,}/g, ' ');
  if (p === '') return '';
  if (!/^\+?\d[\d ]*$/.test(p)) return null;
  return p.replace(/\D/g, '').length <= 15 && p.length <= MAX_LEN.phone ? p : null;
}

// A phone number with the spaces taken out, so "0400 000 000" and "0400000000" count as the same number.
function phoneKey_(p) {
  return String(p).replace(/ /g, '');
}

// For the log tabs: keeps only digits, spaces and a leading +, since what was typed may not have been validated.
function logPhone_(p) {
  return String(p || '').replace(/[^\d +]/g, '').slice(0, MAX_LEN.phone);
}

function md5hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)
    .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

// Asks Cloudflare whether the "I'm not a robot" token the page sent is genuine. A token works
// once. Returns 'ok', 'missing' (no usable token), 'failed' (Cloudflare says no), 'unavailable'
// (couldn't reach Cloudflare) or 'not_configured' (no TURNSTILE_SECRET stored yet).
function verifyCaptcha_(token) {
  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) return 'not_configured';
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return 'missing';
  try {
    const res = UrlFetchApp.fetch(TURNSTILE_VERIFY_URL, {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    const out = JSON.parse(res.getContentText());
    return out && out.success === true ? 'ok' : 'failed';
  } catch (err) {
    return 'unavailable';
  }
}

function captchaError_(result) {
  return json_({ ok: false, error: result === 'missing' || result === 'failed' ? 'captcha_failed' : 'captcha_error' });
}

// Run this once from the editor (pick checkSetup in the toolbar, click Run, then View > Logs)
// after storing TURNSTILE_SECRET. It sends Cloudflare a deliberately fake token. The answer
// should be success false with "invalid-input-response". "invalid-input-secret" means the
// stored secret key is wrong.
function checkSetup() {
  Logger.log('TURNSTILE_SECRET stored: ' + !!PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET'));
  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET') || 'missing';
  const res = UrlFetchApp.fetch(TURNSTILE_VERIFY_URL, { method: 'post', payload: { secret: secret, response: 'a-deliberately-fake-token' }, muteHttpExceptions: true });
  Logger.log('Cloudflare answered: ' + res.getContentText());
}

// Is there enough of today's email allowance left to finish a request that sends `needed` emails,
// while keeping a small reserve? Asking costs nothing.
function emailAllowanceOk_(needed) {
  return MailApp.getRemainingDailyQuota() >= needed + EMAIL_RESERVE;
}

// Sends ONE warning a day to NOTIFY_EMAIL when the allowance is running low. Never lets a
// problem with the warning itself break the booking or enquiry that triggered it.
function warnIfLowOnEmail_() {
  try {
    const remaining = MailApp.getRemainingDailyQuota();
    if (remaining > EMAIL_WARN_AT) return;
    const props = PropertiesService.getScriptProperties();
    const key = 'quota_warned_' + todayString_();
    if (props.getProperty(key)) return;
    props.setProperty(key, '1');
    props.getKeys().forEach(function (k) {   // forget earlier days' markers
      if (k.indexOf('quota_warned_') === 0 && k !== key) props.deleteProperty(k);
    });
    MailApp.sendEmail(NOTIFY_EMAIL,
      'Nexcon website: daily email allowance is running low',
      'The website can only send a limited number of emails a day, and only about ' + remaining +
      ' are left today.\n\n' +
      'When they run out, new online bookings and enquiries are paused automatically. Visitors are ' +
      'told to try again tomorrow or call +61 411 330 962. Nothing already booked is affected, and ' +
      'the allowance refills within about a day.\n\n' +
      'If this keeps happening, tell your web developer: it usually means a lot of genuine traffic ' +
      'or someone testing the forms repeatedly.\n\n' +
      'You will get at most one of these warnings per day.');
  } catch (err) {
    // a failed warning must never stop a real booking
  }
}

// Counts accepted enquiries per hour (everyone), per hour per email address, and per day, and
// says whether one more is allowed. The hourly counts live in the cache (best effort, they
// expire by themselves); the daily count is stored properly so a restart can't reset it.
// Runs inside doPost's lock, so two simultaneous enquiries can't both slip under a limit.
function contactAllowed_(email) {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const hour = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyyMMddHH');
  const day = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyyMMdd');
  const hourKey = 'contact_hour_' + hour;
  const emailKey = 'contact_email_' + hour + '_' + md5hex_(email.toLowerCase());
  const dayKey = 'contact_day_' + day;

  const inHour = Number(cache.get(hourKey) || 0);
  const fromEmail = Number(cache.get(emailKey) || 0);
  const inDay = Number(props.getProperty(dayKey) || 0);
  if (inHour >= CONTACT_PER_HOUR || fromEmail >= CONTACT_PER_EMAIL_PER_HOUR || inDay >= CONTACT_PER_DAY) return false;

  cache.put(hourKey, String(inHour + 1), 3600);
  cache.put(emailKey, String(fromEmail + 1), 3600);
  props.setProperty(dayKey, String(inDay + 1));
  props.getKeys().forEach(function (k) {   // forget previous days' counters
    if (k.indexOf('contact_day_') === 0 && k !== dayKey) props.deleteProperty(k);
  });
  return true;
}

// Adds one line to the "Blocked" tab: when, why it was refused ('link', 'spam wording', 'trap box',
// 'rate limit'), which form, and what the sender typed. Runs inside doPost's lock. Anything that goes
// wrong here is swallowed on purpose: keeping this list must never change what the visitor sees.
function logBlocked_(reason, formName, name, email, phone, text) {
  try {
    const cache = CacheService.getScriptCache();
    const hourKey = 'blocked_hour_' + Utilities.formatDate(new Date(), TIME_ZONE, 'yyyyMMddHH');
    const logged = Number(cache.get(hourKey) || 0);
    if (logged >= BLOCKED_PER_HOUR) return;
    cache.put(hourKey, String(logged + 1), 3600);
    appendLogRow_(BLOCKED_SHEET_NAME, BLOCKED_HEADER, [Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'), reason, formName,
      cleanText_(name, MAX_LEN.name), cleanText_(email, MAX_LEN.email), logPhone_(phone), cleanText_(text, 600)], BLOCKED_KEEP);
  } catch (err) { /* see above */ }
}

// Adds one line to the "Contacts" tab: an accepted enquiry (type "contact" or "house_and_land") or a
// booking (type "booking", with its date, slot and address). Never trimmed: it is the customer record.
// "note" is blank, or says that the email to staff failed. Like logBlocked_, any failure here is
// swallowed so it can never change what the visitor sees, and nothing on this tab is ever read by
// the booking rules.
function logContact_(type, name, email, phone, date, slot, address, details, message, note) {
  try {
    appendLogRow_(CONTACTS_SHEET_NAME, CONTACTS_HEADER, [Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'), type,
      cleanText_(name, MAX_LEN.name), cleanText_(email, MAX_LEN.email), logPhone_(phone), date, slot,
      cleanText_(address, MAX_LEN.address), cleanText_(details, 700),
      String(message || '').replace(/^[=+\-@\s]+/, '').slice(0, MAX_MESSAGE_CHARS), note || ''], 0);
  } catch (err) { /* see above */ }
}

// Appends one row of text to a log tab, creating the tab (with a frozen header row) the first time.
// keepNewest > 0 deletes the oldest rows beyond that many; 0 keeps everything.
function appendLogRow_(sheetName, header, row, keepNewest) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  const range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
  range.setNumberFormat('@'); // plain text, so nothing a sender typed can run as a formula (or turn a date into a number)
  range.setValues([row]);
  const surplus = sheet.getLastRow() - 1 - keepNewest;
  if (keepNewest > 0 && surplus > 0) sheet.deleteRows(2, surplus);
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
    if (data.action === 'contact') return handleContact_(data);
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
  const phone = cleanPhone_(data.phone); // '' = none given, null = not an allowed phone number
  const address = cleanText_(data.address, MAX_LEN.address);

  // Name is required, and at least one way to reach the customer (email OR phone). The
  // property address is optional.
  if (!date || !slot || !name) return json_({ ok: false, error: 'missing_fields' });
  if (!email && !data.phone.trim()) return json_({ ok: false, error: 'need_contact' });
  if (slot !== 'AM' && slot !== 'PM') return json_({ ok: false, error: 'bad_slot' });
  if (!isRealDate_(date)) return json_({ ok: false, error: 'bad_date' });
  if (email && (email.length > MAX_LEN.email || !EMAIL_RE.test(email))) return json_({ ok: false, error: 'bad_email' });
  if (phone === null) return json_({ ok: false, error: 'bad_phone' });
  const property = propertyFromRequest_(data); // the fee comes from the answers, worked out here, never from the page
  if (property.bad) return json_({ ok: false, error: 'bad_property' });

  const slotStart = slotStartDate_(date, slot);
  const dow = slotStart.getDay(); // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) return json_({ ok: false, error: 'weekend' });
  if (slotStart < earliestBookable_()) return json_({ ok: false, error: 'too_soon' });
  const [ty, tm, td] = todayString_().split('-').map(Number);
  const maxDate = new Date(ty, tm - 1, td + MAX_DAYS_AHEAD, 23, 59, 59);
  if (slotStart > maxDate) return json_({ ok: false, error: 'too_far' });

  // Staff always get an email; the customer only gets one if they gave an address.
  if (!emailAllowanceOk_(email ? 2 : 1)) return json_({ ok: false, error: 'email_limit' });

  const captcha = verifyCaptcha_(data.captcha);
  if (captcha !== 'ok') return captchaError_(captcha);

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
    // The cap follows whichever contact detail was given: same email, or same phone number.
    const sameEmail = email && String(rows[i][col.email]).trim().toLowerCase() === email.toLowerCase();
    const samePhone = phone && phoneKey_(String(rows[i][col.phone]).trim()) === phoneKey_(phone); // spaces don't make a different number
    if (rowDate >= today && (sameEmail || samePhone)) activeForEmail++;
  }
  if (activeForEmail >= MAX_ACTIVE_PER_EMAIL) return json_({ ok: false, error: 'limit' });

  // Format the new row as plain text BEFORE writing it. Otherwise Sheets reinterprets what it
  // is given: "2026-10-03" silently becomes a date (which broke the "already taken" check),
  // and anything starting with "=" would run as a formula.
  const newRow = sheet.getLastRow() + 1;
  const range = sheet.getRange(newRow, 1, 1, 8);
  range.setNumberFormat('@');
  range.setValues([[date, slot, name, email, phone, address, 'booked', Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss')]]);
  const propertyDetails = property.none ? '' : 'Property: ' + property.description + '; Fee: ' + property.feeText;
  logContact_('booking', name, email, phone, date, slot, address, propertyDetails, '', ''); // a record only; the calendar never reads the Contacts tab

  const slotLabel = SLOT_LABELS[slot];

  // The booking is saved by now, so it IS confirmed whatever happens to the emails. If one
  // fails (the allowance can run out between the check above and here), say "ok" anyway: staff
  // can still see the booking in the Sheet, and an error would only make the customer rebook.
  try {
    MailApp.sendEmail(NOTIFY_EMAIL,
      'New inspection booking: ' + date + ' (' + slotLabel + ')',
      'Name: ' + name + '\nEmail: ' + (email || '-') + '\nPhone: ' + (phone || '-') + '\nAddress: ' + (address || '-') +
      '\nDate: ' + date + '\nTime: ' + slotLabel +
      (property.none ? '' : '\nProperty: ' + property.description + '\nFee: ' + property.feeText));
  } catch (err) { /* see note above */ }
  if (email) try {
    MailApp.sendEmail(email,
      'Your Nexcon inspection booking is confirmed',
      'Hi ' + name + ',\n\nYour building inspection is booked for:\n' + date + ', ' + slotLabel +
      (address ? '\nAddress: ' + address : '') +
      (property.none ? '' : '\nProperty: ' + property.description + '\nInspection fee: ' + property.feeText) +
      '\n\nIMPORTANT: The inspection report will be released upon receipt of full payment.' +
      '\n\nNeed to cancel or reschedule? Just reply to this email or call us, at least 24 ' +
      'hours before the appointment.' +
      '\n\nQuestions? Call +61 411 330 962 or reply to this email.' +
      '\n\nThanks,\nNexcon Building Management');
  } catch (err) { /* see note above */ }

  warnIfLowOnEmail_();
  return json_({ ok: true });
}

// Every enquiry form on the website, and what it may carry besides name, email and phone.
// Each field is [key sent by the page, label shown in the email, maximum length]. A form the
// website doesn't know about is refused, and so is any field not listed here.
const ENQUIRY_FORMS = {
  contact: {
    subject: 'New enquiry from Nexcon website',
    messageRequired: true,
    fields: [['project_location', 'Project location', 150], ['project_type', 'Planning', 300],
             ['approximate_budget', 'Approximate budget', 60], ['preferred_timeframe', 'Preferred timeframe', 60]]
  },
  house_and_land: {
    subject: 'New house & land enquiry from Nexcon website',
    messageRequired: false,
    fields: [['location', 'Location', 150], ['budget', 'Budget', 60], ['bedrooms', 'Bedrooms', 40],
             ['bathrooms', 'Bathrooms', 40], ['garage', 'Garage', 40], ['land_size', 'Land size', 60]]
  }
};

// The enquiry forms. Refuses links, spam wording, too-short/too-long messages, bad emails and
// phone numbers, and anything over the rate limits. Sends the enquiry to CONTACT_EMAIL with the
// visitor's address as the reply-to, so "Reply" answers the customer directly.
function handleContact_(data) {
  // Hidden "website" box: people never see it, robots fill everything. Say "ok" so the robot
  // learns nothing, but send nothing.
  if (typeof data.website === 'string' && data.website.trim() !== '') {
    const str = function (v) { return typeof v === 'string' ? v : ''; };
    logBlocked_('trap box', str(data.form) || 'contact', str(data.name), str(data.email), str(data.phone), str(data.website) + ' ' + str(data.message));
    return json_({ ok: true });
  }

  const formName = data.form === undefined ? 'contact' : data.form;
  if (typeof formName !== 'string' || !Object.prototype.hasOwnProperty.call(ENQUIRY_FORMS, formName)) {
    return json_({ ok: false, error: 'bad_request' });
  }
  const spec = ENQUIRY_FORMS[formName];

  for (const f of ['name', 'email', 'phone']) {
    if (typeof data[f] !== 'string') return json_({ ok: false, error: 'missing_fields' });
  }
  for (const field of spec.fields) {
    if (data[field[0]] !== undefined && typeof data[field[0]] !== 'string') return json_({ ok: false, error: 'missing_fields' });
  }
  if (data.message !== undefined && typeof data.message !== 'string') return json_({ ok: false, error: 'missing_fields' });
  if (spec.messageRequired && typeof data.message !== 'string') return json_({ ok: false, error: 'missing_fields' });

  const name = cleanText_(data.name, MAX_LEN.name);
  const email = data.email.trim();
  const phone = cleanPhone_(data.phone); // '' = none given, null = not an allowed phone number
  const extras = spec.fields.map(function (field) { return [field[1], cleanText_(data[field[0]] || '', field[2])]; });
  const message = String(data.message || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();

  // Name is required, plus at least one way to reply: an email address OR a phone number.
  if (!name) return json_({ ok: false, error: 'missing_fields' });
  if (!email && !data.phone.trim()) return json_({ ok: false, error: 'need_contact' });
  if (email && (email.length > MAX_LEN.email || !EMAIL_RE.test(email))) return json_({ ok: false, error: 'bad_email' });
  if (phone === null) return json_({ ok: false, error: 'bad_phone' });
  if (spec.messageRequired || message) {
    if (message.length < MIN_MESSAGE_CHARS) return json_({ ok: false, error: 'too_short' });
    if (message.length > MAX_MESSAGE_CHARS) return json_({ ok: false, error: 'too_long' });
  }

  const everything = [name].concat(extras.map(function (x) { return x[1]; }), [message]).join('\n');
  if (hasLink_(everything)) { logBlocked_('link', formName, name, email, phone, everything); return json_({ ok: false, error: 'has_link' }); }
  if (hasSpamWords_(everything)) { logBlocked_('spam wording', formName, name, email, phone, everything); return json_({ ok: false, error: 'spam' }); }

  if (!emailAllowanceOk_(1)) return json_({ ok: false, error: 'email_limit' });

  const captcha = verifyCaptcha_(data.captcha);
  if (captcha !== 'ok') return captchaError_(captcha);

  if (!contactAllowed_(email || phoneKey_(phone))) { // limit per email, or per phone number (spaces ignored) if no email
    logBlocked_('rate limit', formName, name, email, phone, everything);
    return json_({ ok: false, error: 'rate_limited' });
  }

  const enquiryDetails = extras.filter(function (x) { return x[1]; }).map(function (x) { return x[0] + ': ' + x[1]; }).join('; ');

  // The email is the main copy of an enquiry (the Contacts tab keeps a second). If it can't be sent, tell the visitor so they can
  // try again or phone, rather than letting them think it arrived.
  try {
    const mail = {
      to: CONTACT_EMAIL,
      name: 'Nexcon website',
      subject: spec.subject + ': ' + name,
      body: 'Name: ' + name + '\nEmail: ' + (email || '-') + '\nPhone: ' + (phone || '-') + '\n' +
        extras.map(function (x) { return x[0] + ': ' + (x[1] || '-'); }).join('\n') +
        (message ? '\n\nMessage:\n' + message : '')
    };
    if (email) mail.replyTo = email; // "Reply" answers the customer directly; with no email, ring them
    MailApp.sendEmail(mail);
  } catch (err) {
    // The visitor is told it failed (and may try again), but keep what they wrote so staff can still follow up.
    logContact_(formName, name, email, phone, '', '', '', enquiryDetails, message, 'EMAIL FAILED: visitor was told to try again or phone');
    return json_({ ok: false, error: 'email_limit' });
  }
  logContact_(formName, name, email, phone, '', '', '', enquiryDetails, message, '');

  warnIfLowOnEmail_();
  return json_({ ok: true });
}

function slotStartDate_(dateStr, slot) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hour = slot === 'AM' ? 10 : 14;
  return new Date(y, m - 1, d, hour, 0, 0);
}
