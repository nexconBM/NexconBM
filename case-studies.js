/* Renders extra case studies on the Projects page from a published Google Sheet, so
   someone who doesn't code can add or edit them (in English and/or Chinese) without
   touching any files here.

   ONE-TIME SETUP (do this in Google Sheets, not in this file):
     1. Create a new Google Sheet. In row 1, add exactly these column headers:
          title | title_zh | project | project_zh | location | location_zh | type |
          type_zh | overview | overview_zh | features | features_zh | role | role_zh |
          challenges | challenges_zh | result | result_zh | published
        (Every English column has a matching "_zh" column right after it for the
        Chinese translation of that same field.)
     2. Fill in one row per case study.
          - The plain columns (title, location, ...) are required -- fill those in first.
          - The matching "_zh" column is optional. Leave it blank to show the English
            text even when a visitor has switched the site to Chinese; fill it in to show
            your own Chinese translation instead, just for that field.
          - "features"/"features_zh" can hold several lines in one cell: press Alt+Enter
            (Windows) or Option+Return (Mac) to start a new line without leaving the cell
            -- each line becomes one bullet point.
          - "published" should say TRUE to show that row on the site, or FALSE (or blank)
            to hide it while it's still a draft. There's only one "published" column --
            it controls both languages of that row together.
     3. File > Share > Publish to web. Choose the sheet, choose "Comma-separated values
        (.csv)", then click Publish and copy the link it gives you.
     4. Paste that link below as SHEET_CSV_URL, replacing the placeholder text.

   After that one-time setup, editing or adding a row in the sheet updates the site
   automatically -- no rebuild, no git, no code. Changes usually show up within a minute
   or two, since the published link is cached briefly by Google.

   Limits of this approach (worth knowing):
     - There's no image support yet -- this only renders text. Ask if you'd like photos
       added; it needs a small extra step (an "image_url" column with a public link to
       each photo, e.g. uploaded to the site itself or an image host).
     - Anyone with the "Publish to web" link's sheet can be edited by anyone you've shared
       the Google Sheet with (normal Google Sheets sharing rules apply); the published CSV
       link itself is read-only and just lets the website fetch the data. */
(function () {
  var SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQccxPTfwtI-uH-VfqqOeYURM7eaKlh_-scpBXwA67zGUXJklUubeirST07ozkfn4pXkkXDJo_W757D/pub?gid=0&single=true&output=csv";

  var container = document.getElementById("sheet-projects");
  if (!container) return;
  if (SHEET_CSV_URL.indexOf("PASTE_YOUR") === 0) return; // not set up yet

  var LABELS = {
    eyebrow: "proj_case_eyebrow",
    project: "proj_label_project",
    location: "proj_label_location",
    type: "proj_label_type",
    overview: "proj_overview_label",
    features: "proj_features_label",
    role: "proj_role_label",
    challenges: "proj_challenges_label",
    result: "proj_result_label"
  };

  var publishedRows = []; // filled in once the sheet has loaded

  function currentLang() {
    try {
      return localStorage.getItem("nexcon-lang") || "en";
    } catch (e) {
      return "en";
    }
  }

  function label(key) {
    // translations.js declares `const translations`, which (unlike `var`) doesn't
    // attach to `window`, so it's read here as a plain identifier instead.
    var dict = (typeof translations !== "undefined" && translations[currentLang()]) || {};
    return dict[LABELS[key]] || LABELS[key];
  }

  // Reads a sheet field for the current language, falling back to the English column
  // (e.g. "overview") when the "_zh" column is missing or was left blank.
  function field(row, name, lang) {
    if (lang === "zh") {
      var zhValue = row[name + "_zh"];
      if (zhValue && zhValue.trim()) return zhValue;
    }
    return row[name] || "";
  }

  // Escapes text via the DOM (never trusts sheet content as HTML), for a single line.
  function esc(value) {
    var div = document.createElement("div");
    div.textContent = value || "";
    return div.innerHTML;
  }

  // Same, but keeps line breaks typed inside a cell as <br>.
  function escLines(value) {
    return esc(value).replace(/\r?\n/g, "<br>");
  }

  function renderCaseStudy(row, lang) {
    var features = String(field(row, "features", lang))
      .split(/\r?\n/)
      .map(function (f) { return f.trim(); })
      .filter(Boolean);
    var project = field(row, "project", lang);
    var location = field(row, "location", lang);
    var type = field(row, "type", lang);
    var overview = field(row, "overview", lang);
    var role = field(row, "role", lang);
    var challenges = field(row, "challenges", lang);
    var result = field(row, "result", lang);

    var html = "";
    html += '<p class="eyebrow" data-i18n="' + LABELS.eyebrow + '">' + esc(label("eyebrow")) + "</p>";
    html += '<h2 class="heading" style="font-size:1.4rem; margin-bottom:0;">' + esc(field(row, "title", lang)) + "</h2>";

    html += '<dl class="case-meta">';
    if (project) {
      html += "<div><dt data-i18n=\"" + LABELS.project + "\">" + esc(label("project")) + "</dt><dd>" + esc(project) + "</dd></div>";
    }
    if (location) {
      html += "<div><dt data-i18n=\"" + LABELS.location + "\">" + esc(label("location")) + "</dt><dd>" + esc(location) + "</dd></div>";
    }
    if (type) {
      html += "<div><dt data-i18n=\"" + LABELS.type + "\">" + esc(label("type")) + "</dt><dd>" + esc(type) + "</dd></div>";
    }
    html += "</dl>";

    if (overview) {
      html += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.overview + '">' + esc(label("overview")) + '</p><p class="body-copy">' + escLines(overview) + "</p></div>";
    }
    if (features.length) {
      html += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.features + '">' + esc(label("features")) + '</p><ul class="check-list" style="margin-top:0.6rem;">';
      features.forEach(function (f) { html += "<li>" + esc(f) + "</li>"; });
      html += "</ul></div>";
    }
    if (role) {
      html += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.role + '">' + esc(label("role")) + '</p><p class="body-copy">' + escLines(role) + "</p></div>";
    }
    if (challenges) {
      html += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.challenges + '">' + esc(label("challenges")) + '</p><p class="body-copy">' + escLines(challenges) + "</p></div>";
    }
    if (result) {
      html += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.result + '">' + esc(label("result")) + '</p><p class="body-copy">' + escLines(result) + "</p></div>";
    }

    var article = document.createElement("article");
    article.className = "case-study reveal is-visible";
    article.style.marginTop = "2.5rem";
    article.innerHTML = html;
    return article;
  }

  function isPublished(row) {
    return String(row.published || "").trim().toUpperCase() === "TRUE";
  }

  function renderAll() {
    var lang = currentLang();
    container.innerHTML = "";
    publishedRows.forEach(function (row) {
      container.appendChild(renderCaseStudy(row, lang));
    });
  }

  fetch(SHEET_CSV_URL)
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    })
    .then(function (csv) {
      if (!window.Papa) throw new Error("PapaParse did not load");
      var rows = window.Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
      publishedRows = rows.filter(function (row) { return row.title && isPublished(row); });
      renderAll();

      // The site's language button already re-applies data-i18n text; it doesn't know
      // about the sheet's own per-language columns, so re-render this section too.
      var toggle = document.getElementById("langToggle");
      if (toggle) toggle.addEventListener("click", renderAll);
    })
    .catch(function (err) {
      console.error("Nexcon: could not load case studies from the Google Sheet.", err);
    });
})();
