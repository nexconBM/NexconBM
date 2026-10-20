/* Nexcon enquiry form. Sends the form to the same Google Apps Script web app the booking
   calendar uses (action "contact"), in the background, so the visitor stays on the page.
   All the spam filtering happens THERE (see handleContact_ in booking-apps-script.gs): it
   refuses links and spam wording, enforces length and rate limits, and drops anything where
   the hidden "website" box was filled in. The checks in this file only exist to give a real
   visitor a friendly message before they press Send; they can be skipped by anyone who
   calls the web app directly, which is exactly why the server repeats them.

   WEBAPP_URL below must be the same address as WEBAPP_URL in booking.js. Change both together.

   For each <form data-enquiry> this script:
     - joins the ticked project-type checkboxes into one hidden field before sending
     - reveals a text box when a checkbox with data-detail="some-id" is ticked
       (its text is added to the joined value, e.g. "Other: solar installation")
     - strips anything but digits, single spaces and a leading + from any type="tel" field as the visitor types
     - allows at most DAILY_LIMIT enquiries per day from one browser
     - shows the thank-you message on success, or an error message if sending fails

   The daily limit is kept in the visitor's browser (localStorage), so it stops accidental
   or casual repeat sending but not a determined spammer; the server's own limits do that.

   Markup it expects, per form:
     input[data-project-type]         the checkboxes
     input[name="project_type"]       hidden field that receives the joined value
     input[name="website"]            the hidden spam-trap box (must stay empty)
     textarea[name="message"]         the message / note box (add `required` to make it compulsory, as on Contact)
     (the "I'm not a robot" check is added automatically above the Send button; see captcha.js)
     data-enquiry-type="..."          optional: which form this is (default "contact"); the server
                                      keeps a list of the fields each type may carry
     .contact-submit / .contact-error / .contact-warning   button and messages (inside the form)
     .contact-success                 thank-you message (in the form's parent element) */
(function () {
  var WEBAPP_URL = "https://script.google.com/macros/s/AKfycbwVwnFCEoUFW2af6UNKjDgD9rJiawx79QUXpHPcbdRQ59AxBuukAo_o-sbrHgbk5VTa/exec";
  var DAILY_LIMIT = 15;
  var STORAGE_KEY = 'nexconEnquiries';
  var MIN_MESSAGE = 5;

  // What to tell the visitor for each reason the server can refuse. Anything not listed here
  // falls back to the page's own generic error text.
  var ERROR_KEYS = {
    has_link: ['contact_error_link', 'Please remove web links from your message and describe your project in words instead.'],
    too_short: ['contact_error_short', 'Please tell us a little more about your project.'],
    too_long: ['contact_error_long', 'Your message is too long. Please shorten it to 2000 characters or fewer.'],
    spam: ['contact_error_spam', 'Your message was blocked by our spam filter. Please call us on +61 411 330 962 instead.'],
    rate_limited: ['contact_error_rate', 'We are receiving a lot of messages right now. Please try again later, or call us on +61 411 330 962.'],
    bad_email: ['book_error_email', 'Please enter one valid email address.'],
    bad_phone: ['book_error_phone', 'Please enter a valid phone number: digits and spaces, with an optional + at the start.'],
    need_contact: ['contact_error_either', 'Please give us an email address or a phone number so we can reach you.'],
    email_limit: ['contact_error_today', "We've reached our daily limit for online requests. Please try again tomorrow, or call us on +61 411 330 962."],
    captcha_failed: ['contact_error_captcha', 'Please complete the robot check (tick the box if one appears) and try again.']
  };

  function t(key, fallback) {
    try {
      var lang = document.documentElement.lang.indexOf('zh') === 0 ? 'zh' : 'en';
      var dict = (typeof translations !== 'undefined' && translations[lang]) || {};
      return dict[key] || fallback;
    } catch (err) { return fallback; }
  }

  function looksLikeLink(text) {
    var stripped = text.replace(/\S+@\S+/g, ' '); // an email address is not a web link
    return /(https?:\/\/|ftp:\/\/|www\.)/i.test(stripped) ||
      /\b[a-z0-9-]{2,}\.(com|net|org|info|biz|xyz|top|click|link|ru|cn|shop|online|site|live|club|vip|bet|win|app|io|ly|gl)\b/i.test(stripped);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function sentToday() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return saved.day === today() ? saved.count || 0 : 0;
    } catch (err) { return 0; }
  }

  function recordSend() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: today(), count: sentToday() + 1 }));
    } catch (err) { /* storage blocked: the limit simply isn't tracked */ }
  }

  document.querySelectorAll('form[data-enquiry]').forEach(function (form) {
    var success = form.parentElement.querySelector('.contact-success');
    var error = form.querySelector('.contact-error');
    var limitMsg = form.querySelector('.contact-warning');
    var submit = form.querySelector('.contact-submit');
    var typeBoxes = form.querySelectorAll('input[data-project-type]');
    var typeField = form.querySelector('input[name="project_type"]');
    var genericError = error.textContent;

    // The "I'm not a robot" check, drawn just above the Send button.
    var captchaBox = document.createElement('div');
    captchaBox.className = 'captcha-box';
    submit.parentNode.insertBefore(captchaBox, submit);
    var captcha = window.NexconCaptcha ? window.NexconCaptcha.mount(captchaBox) : null;

    function showError(reason) {
      var known = ERROR_KEYS[reason];
      error.textContent = known ? t(known[0], known[1]) : t('contact_error', genericError);
      error.style.display = 'block';
    }

    function detailInput(box) {
      var id = box.getAttribute('data-detail');
      return id ? document.getElementById(id) : null;
    }

    function syncTypes() {
      Array.prototype.forEach.call(typeBoxes, function (b) {
        var input = detailInput(b);
        if (input) {
          input.closest('.field').hidden = !b.checked;
          if (!b.checked) input.value = '';
        }
      });
      if (!typeField) return;
      typeField.value = Array.prototype.filter.call(typeBoxes, function (b) { return b.checked; })
        .map(function (b) {
          var input = detailInput(b);
          var extra = input ? input.value.trim() : '';
          return extra ? b.value + ': ' + extra : b.value;
        }).join(', ');
    }

    // Length caps so one submission can't carry pages of junk text into the inbox.
    form.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').forEach(function (field) {
      if (field.maxLength > 0) return; // markup already set its own limit
      field.maxLength = field.tagName === 'TEXTAREA' ? 2000 : field.type === 'tel' ? 15 : field.type === 'email' ? 254 : 200;
    });

    // Phone boxes take digits and single spaces, with one + allowed at the very start ("+61 411 330 962").
    form.querySelectorAll('input[type="tel"]').forEach(function (phone) {
      phone.addEventListener('input', function () {
        var cleaned = phone.value.replace(/[^\d +]/g, '').replace(/\+/g, function (m, i) { return i === 0 ? m : ''; }).replace(/ {2,}/g, ' ').replace(/^ +/, '');
        if (cleaned !== phone.value) phone.value = cleaned;
      });
    });

    typeBoxes.forEach(function (b) {
      b.addEventListener('change', function () {
        syncTypes();
        var input = detailInput(b);
        if (input && b.checked) input.focus();
      });
    });
    syncTypes();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.style.display = 'none';
      limitMsg.style.display = 'none';
      syncTypes();

      if (sentToday() >= DAILY_LIMIT) {
        limitMsg.style.display = 'block';
        return;
      }

      // Which form this is ("contact", "house_and_land", ...) tells the server what to expect.
      // A phone number needs at least one digit and no more than 15 (the international maximum).
      var phoneBox = form.querySelector('input[type="tel"]');
      var phoneDigits = phoneBox ? phoneBox.value.replace(/\D/g, '').length : 0;
      if (phoneBox && phoneBox.value.trim() !== '' && (phoneDigits < 1 || phoneDigits > 15)) { showError('bad_phone'); return; }

      var data = { action: 'contact', form: form.getAttribute('data-enquiry-type') || 'contact' };
      var typed = [];
      new FormData(form).forEach(function (value, key) {
        if (key.charAt(0) === '_' || key === 'cf-turnstile-response' || typeof value !== 'string') return;
        data[key] = value;
        if (key !== 'website') typed.push(value);
      });

      // Forms marked data-either-contact need an email OR a phone number, not both.
      if (form.hasAttribute('data-either-contact') && !(data.email || '').trim() && !(data.phone || '').trim()) { showError('need_contact'); return; }
      // A message box that is optional (the house and land note) may be left empty; if anything is typed it still has to be real.
      var messageBox = form.querySelector('textarea[name="message"]');
      var messageRequired = !!(messageBox && messageBox.required);
      if (data.message !== undefined && (messageRequired || data.message.trim() !== '') && data.message.trim().length < MIN_MESSAGE) { showError('too_short'); return; }
      if (looksLikeLink(typed.join('\n'))) { showError('has_link'); return; }

      var token = captcha ? captcha.token() : '';
      if (!token) { showError('captcha_failed'); return; }
      data.captcha = token;

      submit.disabled = true;
      fetch(WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(data)
      })
        .then(function (response) { return response.json(); })
        .then(function (result) {
          if (!result.ok) { showError(result.error); return; }
          recordSend();
          form.reset();
          syncTypes();
          success.style.display = 'block';
          success.scrollIntoView({ block: 'nearest' });
        })
        .catch(function () { showError(); })
        .then(function () {
          if (captcha) captcha.reset(); // a check only works once
          submit.disabled = false;
        });
    });
  });
})();
