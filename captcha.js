/* Nexcon "I'm not a robot" check, using Cloudflare Turnstile (free).
   Loaded on the pages with a form: the booking page and both enquiry forms. booking.js and
   enquiry.js call NexconCaptcha.mount(box) to draw the check, ask the handle for its token()
   when the visitor presses Send, and reset() it afterwards (a token only works once).

   The token is useless on its own: the Apps Script web app (booking-apps-script.gs) sends it to
   Cloudflare and refuses the booking or enquiry unless Cloudflare confirms it. The secret key
   that does that lives in Google's private Script properties, never in this repository.

   ONE-TIME SETUP: create a free Turnstile widget at https://dash.cloudflare.com (Turnstile in
   the menu), allow the hostname nexconbm.com.au, and paste its SITE KEY below. The site key is
   public by design; only the secret key must stay private. The Cloudflare script is loaded from
   challenges.cloudflare.com (allowed in partial/csp.html) and cannot be pinned with an
   integrity hash, because Cloudflare changes it to keep ahead of robots. */
(function () {
  var SITE_KEY = "0x4AAAAAAFXOEzUrJP-AkMLF";
  var loading = null;

  function load() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = function () { resolve(window.turnstile); };
      s.onerror = function () { loading = null; reject(new Error("captcha script failed to load")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function language() {
    return document.documentElement.lang.indexOf("zh") === 0 ? "zh-tw" : "auto";
  }

  window.NexconCaptcha = {
    // Draws the check inside `box`. Returns { token(), reset(), remove() }.
    mount: function (box) {
      var state = { id: null, value: "" };
      if (SITE_KEY.indexOf("PASTE_YOUR") === 0) {
        if (window.console) console.warn("captcha.js: no Turnstile site key set yet, so forms cannot be sent.");
      } else {
        load().then(function (turnstile) {
          state.id = turnstile.render(box, {
            sitekey: SITE_KEY,
            language: language(),
            callback: function (token) { state.value = token; },
            "expired-callback": function () { state.value = ""; },
            "error-callback": function () { state.value = ""; }
          });
        }).catch(function () { /* blocked or offline: token stays empty and the form explains on Send */ });
      }
      return {
        token: function () { return state.value; },
        reset: function () {
          state.value = "";
          if (window.turnstile && state.id !== null) window.turnstile.reset(state.id);
        },
        remove: function () {
          state.value = "";
          if (window.turnstile && state.id !== null) { try { window.turnstile.remove(state.id); } catch (e) { /* already gone */ } }
          state.id = null;
        }
      };
    }
  };
})();
