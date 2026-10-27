/* Nexcon visitor analytics: Cloudflare Web Analytics (free, no cookies, no personal profile of visitors;
   it counts page views, countries, browsers, referrers and page speed). Loaded on every page from
   partial/footer.html. If TOKEN is replaced with the original PASTE_YOUR... placeholder it does nothing.

   SETUP (done): the site was added in Cloudflare Web Analytics (hostname nexconbm.com.au) and the token from
   the snippet it showed (the long string in data-cf-beacon) is TOKEN below. To use a different Cloudflare
   site, replace TOKEN. Unlike the Turnstile SECRET key, this token is PUBLIC by design (it sits in
   the page source); it only says which Cloudflare site the numbers belong to.

   The script is only added when ALL of these hold, so test visits never pollute the numbers:
     - a token has been set;
     - the page is on nexconbm.com.au (or www.), not a local preview or a staging copy;
     - the visitor has not turned on Do Not Track or Global Privacy Control (respected on purpose);
     - this browser has not opted out. To leave your own visits out, open the live site and run this once in
       the browser console:  localStorage.setItem("nexcon-no-analytics", "1")
       (and  localStorage.removeItem("nexcon-no-analytics")  to count yourself again).
   Cloudflare's beacon is loaded from static.cloudflareinsights.com and reports to cloudflareinsights.com;
   both are allowed in partial/csp.html. It can't be pinned with an integrity hash because Cloudflare
   updates it. */
(function () {
  var TOKEN = "d7f8c8a130334e82acc16da371faabfb";

  if (TOKEN.indexOf("PASTE_YOUR") === 0) return;                                  // not set up yet
  if (!/^(www\.)?nexconbm\.com\.au$/i.test(location.hostname)) return;             // only the real site
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl) return;
  try { if (localStorage.getItem("nexcon-no-analytics") === "1") return; } catch (e) { /* storage blocked: count the visit */ }

  var s = document.createElement("script");
  s.type = "module"; // matches the snippet Cloudflare gives for this site (module scripts are deferred automatically)
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: TOKEN }));
  document.head.appendChild(s);
})();
