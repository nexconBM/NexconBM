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
   silently switch the check off. After adding it, run checkSetup once from the editor. */

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
const MAX_BODY_CHARS = 8000;    // anything bigger than a normal booking/enquiry request is refused

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Contact form limits.
const CONTACT_EMAIL = NOTIFY_EMAIL;     // where enquiries are sent
const MIN_MESSAGE_CHARS = 5;
const MAX_MESSAGE_CHARS = 2000;
const CONTACT_PER_HOUR = 20;            // accepted enquiries per hour, from everyone
const CONTACT_PER_EMAIL_PER_HOUR = 3;   // accepted enquiries per hour from one email address
const CONTACT_PER_DAY = 40;             // accepted enquiries per day, leaving mail quota for bookings

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

function hasSpamWords_(text) {
  return SPAM_PATTERNS.some(function (re) { return re.test(text); });
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
  if (typeof data.website === 'string' && data.website.trim() !== '') return json_({ ok: true });

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
  const phone = data.phone.trim();
  const extras = spec.fields.map(function (field) { return [field[1], cleanText_(data[field[0]] || '', field[2])]; });
  const message = String(data.message || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();

  if (!name || !email || !phone) return json_({ ok: false, error: 'missing_fields' });
  if (email.length > MAX_LEN.email || !EMAIL_RE.test(email)) return json_({ ok: false, error: 'bad_email' });
  if (!/^\d{1,15}$/.test(phone)) return json_({ ok: false, error: 'bad_phone' });
  if (spec.messageRequired || message) {
    if (message.length < MIN_MESSAGE_CHARS) return json_({ ok: false, error: 'too_short' });
    if (message.length > MAX_MESSAGE_CHARS) return json_({ ok: false, error: 'too_long' });
  }

  const everything = [name].concat(extras.map(function (x) { return x[1]; }), [message]).join('\n');
  if (hasLink_(everything)) return json_({ ok: false, error: 'has_link' });
  if (hasSpamWords_(everything)) return json_({ ok: false, error: 'spam' });

  const captcha = verifyCaptcha_(data.captcha);
  if (captcha !== 'ok') return captchaError_(captcha);

  if (!contactAllowed_(email)) return json_({ ok: false, error: 'rate_limited' });

  MailApp.sendEmail({
    to: CONTACT_EMAIL,
    replyTo: email,
    name: 'Nexcon website',
    subject: spec.subject + ': ' + name,
    body: 'Name: ' + name + '\nEmail: ' + email + '\nPhone: ' + phone + '\n' +
      extras.map(function (x) { return x[0] + ': ' + (x[1] || '-'); }).join('\n') +
      (message ? '\n\nMessage:\n' + message : '')
  });

  return json_({ ok: true });
}

function slotStartDate_(dateStr, slot) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hour = slot === 'AM' ? 10 : 14;
  return new Date(y, m - 1, d, hour, 0, 0);
}
