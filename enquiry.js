/* Nexcon enquiry form. Sends the form to FormSubmit (https://formsubmit.co) in the
   background, so the visitor stays on the page. FormSubmit is free with no signup and
   no send limit; the first enquiry to a new address triggers a one-time confirmation
   email that someone has to click before real submissions start arriving.

   For each <form data-enquiry> this script:
     - joins the ticked project-type checkboxes into one hidden field before sending
     - reveals a text box when a checkbox with data-detail="some-id" is ticked
       (its text is added to the joined value, e.g. "Other: solar installation")
     - allows at most DAILY_LIMIT enquiries per day from one browser
     - shows the thank-you message on success, or an error message if sending fails

   The daily limit is kept in the visitor's browser (localStorage), so it stops accidental
   or casual repeat sending but not a determined spammer. FormSubmit's own spam filtering
   (the hidden "_honey" box) still applies on their side.

   Markup it expects, per form:
     input[data-project-type]         the checkboxes
     input[name="project_type"]       hidden field that receives the joined value
     .contact-submit / .contact-error / .contact-warning   button and messages (inside the form)
     .contact-success                 thank-you message (in the form's parent element) */
(function () {
  var DAILY_LIMIT = 15;
  var STORAGE_KEY = 'nexconEnquiries';

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

      var data = {};
      new FormData(form).forEach(function (value, key) { data[key] = value; });

      submit.disabled = true;
      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (response) {
          return response.json().then(function (json) {
            return { ok: response.ok && json.success !== false };
          });
        })
        .then(function (result) {
          if (!result.ok) { error.style.display = 'block'; return; }
          recordSend();
          form.reset();
          syncTypes();
          success.style.display = 'block';
          success.scrollIntoView({ block: 'nearest' });
        })
        .catch(function () { error.style.display = 'block'; })
        .then(function () { submit.disabled = false; });
    });
  });
})();
