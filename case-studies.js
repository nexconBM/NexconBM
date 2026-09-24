/* Renders extra case studies on the Projects page from a published Google Sheet, so
   someone who doesn't code can add or edit them (in English and/or Chinese) without
   touching any files here.

   ONE-TIME SETUP (do this in Google Sheets, not in this file):
     1. Create a new Google Sheet. In row 1, add exactly these column headers:
          title | title_zh | project | project_zh | location | location_zh | type |
          type_zh | overview | overview_zh | features | features_zh | role | role_zh |
          challenges | challenges_zh | result | result_zh | images | published
        (Every English column has a matching "_zh" column right after it for the
        Chinese translation of that same field. "images" has no "_zh" version, since a
        photo doesn't need translating.)
     2. Fill in one row per case study.
          - The plain columns (title, location, ...) are required -- fill those in first.
          - The matching "_zh" column is optional. Leave it blank to show the English
            text even when a visitor has switched the site to Chinese; fill it in to show
            your own Chinese translation instead, just for that field.
          - "features"/"features_zh" can hold several lines in one cell: press Alt+Enter
            (Windows) or Option+Return (Mac) to start a new line without leaving the cell
            -- each line becomes one bullet point.
          - "images" works the same way: one image link per line, in the same cell.
            The easiest ways to get a link:
              - Upload the photo to Google Drive, right-click it > Share > "Anyone with
                the link", then copy its link and paste it in as it is. (This file
                rewrites Drive links into Google's embeddable form automatically.)
              - Or upload it to a free image host such as imgur.com and use the "direct
                link" it gives you (usually ends in .jpg/.png/.webp).
          - "published" should say TRUE to show that row on the site, or FALSE (or blank)
            to hide it while it's still a draft. There's only one "published" column --
            it controls both languages of that row together.
     3. File > Share > Publish to web. Choose the sheet, choose "Comma-separated values
        (.csv)", then click Publish and copy the link it gives you.
     4. Paste that link below as SHEET_CSV_URL, replacing the placeholder text.

   After that one-time setup, editing or adding a row in the sheet updates the site
   automatically -- no rebuild, no git, no code. Changes usually show up within a minute
   or two, since the published link is cached briefly by Google.

   On the page, a row's images (if any) appear as a scrollable strip beside its text;
   clicking one opens it full-size, with arrows to step through the rest.

   Limits of this approach (worth knowing):
     - Anyone with the "Publish to web" link's sheet can be edited by anyone you've shared
       the Google Sheet with (normal Google Sheets sharing rules apply); the published CSV
       link itself is read-only and just lets the website fetch the data.
     - The Drive file must be shared as "Anyone with the link" or the photo won't show
       for visitors. Very large photos load slowly; Drive photos under about 2 MB are
       best. */
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

  // Only accept ordinary web image links -- guards against someone pasting a
  // "javascript:" or other unexpected URL scheme into the sheet.
  function isSafeImageUrl(url) {
    return /^https:\/\//i.test(url) || /^http:\/\//i.test(url);
  }

  // Google Drive's "view"/"share" links show a web page (or, for the old uc?export=view
  // address, are blocked from appearing on other sites), so they can't be used as a
  // picture directly. lh3.googleusercontent.com/d/FILE_ID is Google's embeddable address
  // for the same file, so any Drive link pasted into the sheet is rewritten to that.
  function normalizeImageUrl(url) {
    var match =
      url.match(/^https?:\/\/drive\.google\.com\/file\/d\/([\w-]+)/i) ||
      url.match(/^https?:\/\/drive\.google\.com\/(?:uc|open)\?(?:[^#]*&)?id=([\w-]+)/i) ||
      url.match(/^https?:\/\/drive\.usercontent\.google\.com\/download\?(?:[^#]*&)?id=([\w-]+)/i);
    return match ? "https://lh3.googleusercontent.com/d/" + match[1] : url;
  }

  function parseLines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map(function (v) { return v.trim(); })
      .filter(Boolean);
  }

  function renderCaseStudy(row, lang) {
    var features = parseLines(field(row, "features", lang));
    var images = parseLines(row.images).filter(isSafeImageUrl).map(normalizeImageUrl);
    var project = field(row, "project", lang);
    var location = field(row, "location", lang);
    var type = field(row, "type", lang);
    var overview = field(row, "overview", lang);
    var role = field(row, "role", lang);
    var challenges = field(row, "challenges", lang);
    var result = field(row, "result", lang);
    var title = field(row, "title", lang);

    var contentHtml = "";
    contentHtml += '<p class="eyebrow" data-i18n="' + LABELS.eyebrow + '">' + esc(label("eyebrow")) + "</p>";
    contentHtml += '<h2 class="heading" style="font-size:1.4rem; margin-bottom:0;">' + esc(title) + "</h2>";

    contentHtml += '<dl class="case-meta">';
    if (project) {
      contentHtml += "<div><dt data-i18n=\"" + LABELS.project + "\">" + esc(label("project")) + "</dt><dd>" + esc(project) + "</dd></div>";
    }
    if (location) {
      contentHtml += "<div><dt data-i18n=\"" + LABELS.location + "\">" + esc(label("location")) + "</dt><dd>" + esc(location) + "</dd></div>";
    }
    if (type) {
      contentHtml += "<div><dt data-i18n=\"" + LABELS.type + "\">" + esc(label("type")) + "</dt><dd>" + esc(type) + "</dd></div>";
    }
    contentHtml += "</dl>";

    if (overview) {
      contentHtml += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.overview + '">' + esc(label("overview")) + '</p><p class="body-copy">' + escLines(overview) + "</p></div>";
    }
    if (features.length) {
      contentHtml += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.features + '">' + esc(label("features")) + '</p><ul class="check-list" style="margin-top:0.6rem;">';
      features.forEach(function (f) { contentHtml += "<li>" + esc(f) + "</li>"; });
      contentHtml += "</ul></div>";
    }
    if (role) {
      contentHtml += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.role + '">' + esc(label("role")) + '</p><p class="body-copy">' + escLines(role) + "</p></div>";
    }
    if (challenges) {
      contentHtml += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.challenges + '">' + esc(label("challenges")) + '</p><p class="body-copy">' + escLines(challenges) + "</p></div>";
    }
    if (result) {
      contentHtml += '<div class="case-section"><p class="detail-label" data-i18n="' + LABELS.result + '">' + esc(label("result")) + '</p><p class="body-copy">' + escLines(result) + "</p></div>";
    }

    var article = document.createElement("article");
    article.className = "case-study reveal is-visible";
    article.style.marginTop = "2.5rem";

    var layout = document.createElement("div");
    layout.className = "case-study-layout" + (images.length ? "" : " no-media");

    if (images.length) {
      var media = document.createElement("div");
      media.className = "case-study-media";
      var gallery = document.createElement("div");
      gallery.className = "case-gallery";
      images.forEach(function (src, i) {
        var img = document.createElement("img");
        img.className = "case-gallery-img";
        img.src = src;
        img.loading = "lazy";
        img.alt = title ? title + " – photo " + (i + 1) : "Project photo " + (i + 1);
        img.tabIndex = 0;
        img.addEventListener("click", function () { openLightbox(images, i, title); });
        img.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(images, i, title); }
        });
        gallery.appendChild(img);
      });
      media.appendChild(gallery);
      layout.appendChild(media);
    }

    var content = document.createElement("div");
    content.className = "case-study-content";
    content.innerHTML = contentHtml;
    layout.appendChild(content);

    article.appendChild(layout);
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

  // --- Lightbox: one shared full-screen viewer, reused by every case study's gallery ---
  var lightbox = null, lightboxImg = null, lightboxCaption = null, lightboxImages = [], lightboxIndex = 0, lightboxTitle = "";

  function buildLightbox() {
    if (lightbox) return;
    lightbox = document.createElement("div");
    lightbox.className = "case-lightbox";
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    lightbox.hidden = true;
    lightbox.innerHTML =
      '<button type="button" class="case-lightbox-close" aria-label="Close">&times;</button>' +
      '<button type="button" class="case-lightbox-prev" aria-label="Previous photo">&#10094;</button>' +
      '<img class="case-lightbox-img" alt="">' +
      '<button type="button" class="case-lightbox-next" aria-label="Next photo">&#10095;</button>' +
      '<p class="case-lightbox-caption"></p>';
    document.body.appendChild(lightbox);
    lightboxImg = lightbox.querySelector(".case-lightbox-img");
    lightboxCaption = lightbox.querySelector(".case-lightbox-caption");

    lightbox.querySelector(".case-lightbox-close").addEventListener("click", closeLightbox);
    lightbox.querySelector(".case-lightbox-prev").addEventListener("click", function () { stepLightbox(-1); });
    lightbox.querySelector(".case-lightbox-next").addEventListener("click", function () { stepLightbox(1); });
    lightbox.addEventListener("click", function (e) {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", function (e) {
      if (lightbox.hidden) return;
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    });
  }

  function showLightboxImage() {
    lightboxImg.src = lightboxImages[lightboxIndex];
    var multi = lightboxImages.length > 1;
    lightbox.querySelector(".case-lightbox-prev").hidden = !multi;
    lightbox.querySelector(".case-lightbox-next").hidden = !multi;
    lightboxCaption.textContent = multi ? (lightboxTitle + " (" + (lightboxIndex + 1) + "/" + lightboxImages.length + ")") : lightboxTitle;
  }

  function stepLightbox(delta) {
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    showLightboxImage();
  }

  function openLightbox(images, index, title) {
    buildLightbox();
    lightboxImages = images;
    lightboxIndex = index;
    lightboxTitle = title || "";
    showLightboxImage();
    lightbox.hidden = false;
  }

  function closeLightbox() {
    if (lightbox) lightbox.hidden = true;
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
