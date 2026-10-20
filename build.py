"""
Build script for the Nexcon site.

Instead of copy-pasting the header and footer into every page by hand,
this script keeps ONE copy of each (in partial/header.html and
partial/footer.html) and writes them into every page listed in PAGES.

Every page has a marked header block and a marked footer block:

  <!-- HEADER:START -->  ...generated, don't edit by hand...  <!-- HEADER:END -->
  <!-- FOOTER:START -->  ...generated, don't edit by hand...  <!-- FOOTER:END -->

Each run REPLACES whatever is between the markers, so you can edit
partial/header.html or partial/footer.html, run this script, and every page
is updated. A brand new page can start with a bare <!-- HEADER --> and
<!-- FOOTER --> placeholder; the first run turns those into marked blocks.

Tokens used inside the partials:
  {{ROOT}}   "" on the home page (index.html), "../" on every other page,
             so links work from any folder depth.
  {{NAV_HOME_ACTIVE}}, {{NAV_CUSTOM_HOMES_ACTIVE}}, {{NAV_KNOCKDOWN_ACTIVE}},
  {{NAV_HOUSE_LAND_ACTIVE}}, {{NAV_MULTI_UNIT_ACTIVE}},
  {{NAV_PROJECT_MGMT_ACTIVE}}, {{NAV_INSPECTIONS_ACTIVE}}, {{NAV_PROP_MGMT_ACTIVE}}, {{NAV_PROP_MAINT_ACTIVE}},
  {{NAV_PROP_RENO_ACTIVE}}, {{NAV_ABOUT_ACTIVE}},
  {{NAV_FAQ_ACTIVE}}, {{NAV_CONTACT_ACTIVE}}
             become ' class="is-active"' on the nav link of the page being
             built (chosen per page in PAGES below) and "" everywhere else.
  {{NAV_GROUP_BUILD_ACTIVE}}, {{NAV_GROUP_MGMT_ACTIVE}}, {{NAV_GROUP_CONNECT_ACTIVE}}
             become " is-active" on a dropdown's button when the current page
             is one of that dropdown's pages (see NAV_GROUPS below).

WARNING: everything between <!-- FOOTER:START --> and <!-- FOOTER:END --> is
overwritten on every run. Page-specific <script> tags (enquiry.js, case-studies.js,
PapaParse) must go AFTER <!-- FOOTER:END -->, or the next build silently deletes them.

To add a new page (e.g. "contact"):
  1. Create contact/index.html containing <!-- HEADER --> and <!-- FOOTER -->.
  2. Add it to PAGES below (and a NAV_KEYS entry + nav link in
     partial/header.html if it should appear in the menu).
  3. Run: python build.py

Content-Security-Policy: the <meta http-equiv="Content-Security-Policy"> tag lives in ONE
place, partial/csp.html, and is written into every page's <head> between
<!-- CSP:START --> and <!-- CSP:END --> markers (added automatically on first run, right after
the viewport meta tag). The policy forbids inline <script> and only allows scripts from this
site and cdnjs. If you add a new third-party script, font, image host, or fetch() target,
add its origin to partial/csp.html or the browser will silently block it.

Chinese pages (/zh/...): after the English pages are built, every page in PAGES is copied to
zh/<same path> with each data-i18n element's text swapped for its zh value from translations.js,
the Chinese title/description from ZH_META, lang="zh-Hant", and links rewritten so pages point
at other zh pages while images/CSS/JS still load from the site root. These are real URLs that
Google can index (the old toggle-only translation was invisible to search engines). Never edit
files under zh/ by hand -- they are regenerated (and stale ones deleted) on every run. Every
page also gets hreflang <link> tags between <!-- HREFLANG:START --> / <!-- HREFLANG:END -->,
and sitemap.xml is rewritten to list both languages.

Usage:
    python build.py
"""

import html
import json
import posixpath
import re
import shutil
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).parent
PARTIALS = ROOT / "partial"
SITE = "https://nexconbm.com.au"
ZH_DIR = "zh"

NAV_KEYS = [
    "home", "custom_homes", "knockdown", "house_land", "multi_unit",
    "project_mgmt", "inspections", "prop_mgmt", "prop_maint", "prop_reno",
    "about", "faq", "contact",
]

# Which pages live under each dropdown in the nav (so its button is highlighted).
NAV_GROUPS = {
    "BUILD": {"custom_homes", "knockdown", "house_land", "multi_unit"},
    "MGMT": {"project_mgmt", "inspections", "prop_mgmt", "prop_maint", "prop_reno", "projects"},
    "CONNECT": {"about", "faq", "contact"},
}

# Each page: (path to its index.html, is this the homepage?, which nav
# item is active on it -- one of NAV_KEYS, or None)
PAGES = [
    ("index.html", True, "home"),
    ("about/index.html", False, "about"),
    ("contact/index.html", False, "contact"),
    ("custom-homes/index.html", False, "custom_homes"),
    ("faq/index.html", False, "faq"),
    ("house-and-land/index.html", False, "house_land"),
    ("building-inspections/index.html", False, "inspections"),
    ("knockdown-rebuild/index.html", False, "knockdown"),
    ("multi-unit-development/index.html", False, "multi_unit"),
    ("projects/index.html", False, "projects"),
    ("project-management/index.html", False, "project_mgmt"),
    ("renovations-extensions/index.html", False, "prop_reno"),
    ("property-management/index.html", False, "prop_mgmt"),
    ("property-maintenance/index.html", False, "prop_maint"),
]

# Chinese <title> and meta description for each page's /zh/ copy. These are what Google shows
# in Chinese search results, so they lead with the words people search for (墨爾本 + service)
# and keep "Nexcon" so a search for the English brand name still matches.
ZH_META = {
    "index.html": (
        "墨爾本度身訂造住宅及建築管理 | 世代建築管理 Nexcon",
        "世代建築管理（Nexcon）提供墨爾本度身訂造住宅、屋地套餐、拆卸重建及樓宇檢驗服務，每個項目均享7年結構保養。歡迎聯絡我們。",
    ),
    "about/index.html": (
        "關於我們 | 墨爾本世代建築管理 Nexcon",
        "認識世代建築管理（Nexcon）的墨爾本團隊：住宅建築、項目管理及樓宇檢驗，由合資格土木工程師帶領。",
    ),
    "contact/index.html": (
        "聯絡我們 | 墨爾本世代建築管理 Nexcon",
        "告訴我們您在墨爾本的度身訂造住宅、拆卸重建、翻新或檢驗項目。歡迎發送查詢或致電我們。",
    ),
    "custom-homes/index.html": (
        "墨爾本度身訂造住宅建築商 | 世代建築管理 Nexcon",
        "按照您的生活方式、地塊及預算設計及興建度身訂造的家。世代建築管理在墨爾本為您統籌設計、審批、施工及交樓。",
    ),
    "faq/index.html": (
        "常見問題 | 墨爾本世代建築管理 Nexcon",
        "解答有關度身訂造住宅、拆卸重建、樓宇檢驗、固定價格屋地套餐及施工管理的常見問題。",
    ),
    "house-and-land/index.html": (
        "墨爾本及維多利亞省屋地套餐 | 世代建築管理 Nexcon",
        "瀏覽世代建築管理的固定價格屋地套餐，精選住宅設計及地點，切合不同生活方式及預算。",
    ),
    "building-inspections/index.html": (
        "墨爾本新屋樓宇檢驗（驗樓）| 世代建築管理 Nexcon",
        "維多利亞省專業樓宇檢驗服務，包括各施工階段檢驗及竣工檢驗（PCI）。",
    ),
    "knockdown-rebuild/index.html": (
        "墨爾本拆卸重建 | 度身訂造新屋 | 世代建築管理 Nexcon",
        "以全新度身訂造的住宅取代舊屋。世代建築管理在墨爾本全程管理拆卸重建項目，由規劃、審批到交樓。",
    ),
    "multi-unit-development/index.html": (
        "墨爾本多單位發展項目 | 世代建築管理 Nexcon",
        "世代建築管理為墨爾本的住宅及多單位發展項目提供項目統籌及施工管理支援。",
    ),
    "projects/index.html": (
        "項目案例 | 墨爾本世代建築管理 Nexcon",
        "瀏覽世代建築管理在墨爾本的精選項目，了解我們如何處理設計、施工、統籌及解決問題。",
    ),
    "project-management/index.html": (
        "墨爾本建築項目管理 | 世代建築管理 Nexcon",
        "墨爾本住宅建築項目管理：統籌建築商、審閱報價、施工檢驗及進度監察。",
    ),
    "renovations-extensions/index.html": (
        "墨爾本翻新及加建 | 世代建築管理 Nexcon",
        "為墨爾本自住及投資物業規劃及管理翻新及加建工程：工程範圍、預算、統籌技工及進度報告。",
    ),
    "property-management/index.html": (
        "墨爾本物業管理 | 世代建築管理 Nexcon",
        "以樓宇狀況為本的墨爾本物業管理：狀況評估、保養規劃、統籌技工及清晰報告。",
    ),
    "property-maintenance/index.html": (
        "墨爾本物業保養及維修 | 世代建築管理 Nexcon",
        "墨爾本物業保養及維修服務：一般維修、屋頂及簷槽保養、統籌技工及定期保養。",
    ),
}

CJK_FONT = '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;600;700;800&display=swap" rel="stylesheet">'


def stitch(html: str, name: str, content: str, page_path: str) -> str:
    start = f"<!-- {name}:START -->"
    end = f"<!-- {name}:END -->"
    block = f"{start}\n{content.rstrip()}\n{end}"

    marked = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    if marked.search(html):
        return marked.sub(lambda m: block, html)

    placeholder = f"<!-- {name} -->"
    if placeholder in html:
        return html.replace(placeholder, block)

    sys.exit(f"ERROR: {page_path} has no {start} block or {placeholder} placeholder.")


def inject_csp(page_path: str) -> None:
    path = ROOT / page_path
    html = path.read_text(encoding="utf-8")
    csp = (PARTIALS / "csp.html").read_text(encoding="utf-8").rstrip()
    block = "<!-- CSP:START -->" + "\n" + csp + "\n" + "<!-- CSP:END -->"

    marked = re.compile(r"<!-- CSP:START -->.*?<!-- CSP:END -->", re.S)
    if marked.search(html):
        new_html = marked.sub(lambda m: block, html)
    else:
        viewport = re.search(r'<meta name="viewport"[^>]*>' + r'\n?', html)
        if not viewport:
            sys.exit(f"ERROR: {page_path} has no viewport meta tag to insert the CSP after.")
        new_html = html[: viewport.end()] + block + "\n" + html[viewport.end():]

    if new_html != html:
        path.write_text(new_html, encoding="utf-8")
        print(f"Updated CSP in {page_path}")


def build_page(page_path: str, is_home: bool, active_key) -> None:
    path = ROOT / page_path
    page_html = path.read_text(encoding="utf-8")
    header_html = (PARTIALS / "header.html").read_text(encoding="utf-8")
    footer_html = (PARTIALS / "footer.html").read_text(encoding="utf-8")

    root_prefix = "" if is_home else "../"
    header_html = header_html.replace("{{ROOT}}", root_prefix)
    footer_html = footer_html.replace("{{ROOT}}", root_prefix)
    # The English page's toggle points at its /zh/ copy (make_zh_page flips it back).
    en_path = url_path(page_path)
    header_html = header_html.replace("{{LANG_ALT_HREF}}", relative_url("/" + ZH_DIR + en_path, en_path))

    for key in NAV_KEYS:
        token = "{{NAV_" + key.upper() + "_ACTIVE}}"
        value = ' class="is-active"' if key == active_key else ""
        header_html = header_html.replace(token, value)

    for group, members in NAV_GROUPS.items():
        token = "{{NAV_GROUP_" + group + "_ACTIVE}}"
        value = " is-active" if active_key in members else ""
        header_html = header_html.replace(token, value)

    for label, text in (("header", header_html), ("footer", footer_html)):
        if "{{" in text:
            sys.exit(f"ERROR: unresolved {{{{token}}}} left in partial/{label}.html")

    final_html = stitch(page_html, "HEADER", header_html, page_path)
    final_html = stitch(final_html, "FOOTER", footer_html, page_path)

    if final_html != page_html:
        path.write_text(final_html, encoding="utf-8")
        print(f"Updated {page_path}")
    else:
        print(f"Unchanged {page_path}")


# ---------------------------------------------------------------------------
# Chinese (/zh/) pages, hreflang and sitemap
# ---------------------------------------------------------------------------

def url_path(page_path: str) -> str:
    """'index.html' -> '/', 'about/index.html' -> '/about/'."""
    folder = posixpath.dirname(page_path)
    return "/" + folder + "/" if folder else "/"


def relative_url(target: str, from_dir: str) -> str:
    """A site-absolute path like '/zh/about/#x' written relative to the folder from_dir."""
    parts = urlsplit(target)
    path = parts.path
    rel = posixpath.relpath(path.rstrip("/") or "/", from_dir.rstrip("/") or "/")
    if rel == ".":
        rel = "./"
    elif path.endswith("/"):
        rel += "/"
    if parts.query:
        rel += "?" + parts.query
    if parts.fragment:
        rel += "#" + parts.fragment
    return rel


def load_zh_translations() -> dict:
    """Read the zh object out of translations.js (a JS literal of plain double-quoted strings)."""
    src = (ROOT / "translations.js").read_text(encoding="utf-8")
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    start = re.search(r"^\s*zh\s*:\s*\{", src, re.M)
    if not start:
        sys.exit("ERROR: no zh: { ... } block found in translations.js")
    pairs = re.findall(r'([A-Za-z0-9_]+)\s*:\s*("(?:[^"\\\n]|\\.)*")', src[start.end():])
    # JSON accepts every JS escape used here except \' -- turn that into a plain quote first.
    return {key: json.loads(value.replace("\\'", "'")) for key, value in pairs}


class I18nRanges(HTMLParser):
    """Finds the inner-content span of every element carrying data-i18n."""

    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.line_starts = [0]
        for m in re.finditer("\n", source):
            self.line_starts.append(m.end())
        self.open = []    # [tag, nesting depth, content start, key, is_html]
        self.ranges = []  # (content start, content end, key, is_html)

    def char_index(self) -> int:
        line, col = self.getpos()
        return self.line_starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        for item in self.open:
            if item[0] == tag:
                item[1] += 1
        attrs = dict(attrs)
        if "data-i18n" in attrs:
            start = self.char_index() + len(self.get_starttag_text())
            self.open.append([tag, 0, start, attrs["data-i18n"], "data-i18n-html" in attrs])

    def handle_endtag(self, tag):
        for item in reversed(self.open):
            if item[0] != tag:
                continue
            if item[1] == 0:
                self.open.remove(item)
                self.ranges.append((item[2], self.char_index(), item[3], item[4]))
            else:
                item[1] -= 1
            break


def translate_i18n(page_html: str, zh: dict, page_path: str) -> str:
    """Do at build time what i18n.js does in the browser: swap data-i18n text for its zh value."""
    parser = I18nRanges(page_html)
    parser.feed(page_html)
    parser.close()
    # An outer data-i18n element replaces its whole content, so drop any nested ones.
    ranges = sorted(parser.ranges)
    outer = [r for r in ranges if not any(o[0] <= r[0] and r[1] <= o[1] and o != r for o in ranges)]
    missing = sorted({key for _, _, key, _ in outer if key not in zh})
    if missing:
        print(f"  note: {page_path} has no zh text for {', '.join(missing)} (left in English)")
    for start, end, key, is_html in sorted(outer, reverse=True):
        if key in zh:
            text = zh[key] if is_html else html.escape(zh[key], quote=False)
            page_html = page_html[:start] + text + page_html[end:]
    return page_html


def page_url_set() -> set:
    paths = set()
    for page_path, _, _ in PAGES:
        p = url_path(page_path)
        paths.update({p, p + "index.html"})
    return paths


def rewrite_links(page_html: str, en_dir: str, zh_dir: str) -> str:
    """Relative href/src values: links to other pages go to their zh copy, assets stay at the root."""
    pages = page_url_set()

    def fix(m):
        attr, url = m.group(1), m.group(2)
        if not url or url.startswith(("#", "//", "{")) or re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", url):
            return m.group(0)  # same-page anchor, absolute URL, mailto:, tel:, data: ...
        parts = urlsplit(urljoin(SITE + en_dir, url))
        target = parts.path
        if target in pages:
            target = "/" + ZH_DIR + target
        if parts.query:
            target += "?" + parts.query
        if parts.fragment:
            target += "#" + parts.fragment
        return f'{attr}="{relative_url(target, zh_dir)}"'

    return re.sub(r'(?<![\w-])(href|src)="([^"]*)"', fix, page_html)


def hreflang_block(en_path: str) -> str:
    en_url, zh_url = SITE + en_path, SITE + "/" + ZH_DIR + en_path
    return "\n".join([
        "<!-- HREFLANG:START -->",
        f'<link rel="alternate" hreflang="en" href="{en_url}">',
        f'<link rel="alternate" hreflang="zh-Hant" href="{zh_url}">',
        f'<link rel="alternate" hreflang="x-default" href="{en_url}">',
        "<!-- HREFLANG:END -->",
    ])


def with_hreflang(page_html: str, en_path: str, page_path: str) -> str:
    block = hreflang_block(en_path)
    marked = re.compile(r"<!-- HREFLANG:START -->.*?<!-- HREFLANG:END -->", re.S)
    if marked.search(page_html):
        return marked.sub(lambda m: block, page_html)
    if "<!-- SEO:END -->" in page_html:
        return page_html.replace("<!-- SEO:END -->", "<!-- SEO:END -->\n" + block, 1)
    if "</head>" not in page_html:
        sys.exit(f"ERROR: {page_path} has no </head> to put the hreflang links before.")
    return page_html.replace("</head>", block + "\n</head>", 1)


def inject_hreflang(page_path: str) -> None:
    path = ROOT / page_path
    page_html = path.read_text(encoding="utf-8")
    new_html = with_hreflang(page_html, url_path(page_path), page_path)
    if new_html != page_html:
        path.write_text(new_html, encoding="utf-8")
        print(f"Updated hreflang in {page_path}")


def set_meta(page_html: str, pattern: str, value: str, page_path: str) -> str:
    new_html, count = re.subn(pattern, lambda m: m.group(1) + html.escape(value) + m.group(2), page_html, count=1)
    if not count:
        print(f"  note: {page_path} has no tag matching {pattern!r}")
    return new_html


def make_zh_page(page_path: str, zh: dict) -> str:
    """Build the /zh/ copy of an (already built) English page and return its new path."""
    if page_path not in ZH_META:
        sys.exit(f"ERROR: add a Chinese title and description for {page_path} to ZH_META in build.py")
    title, description = ZH_META[page_path]
    en_path = url_path(page_path)
    zh_path = "/" + ZH_DIR + en_path
    out = (ROOT / page_path).read_text(encoding="utf-8")

    out = translate_i18n(out, zh, page_path)
    out = rewrite_links(out, en_path, zh_path)
    out = re.sub(r'<html lang="[^"]*"', '<html lang="zh-Hant"', out, count=1)

    out = set_meta(out, r"(<title>)[^<]*(</title>)", title, page_path)
    out = set_meta(out, r'(<meta name="description" content=")[^"]*(")', description, page_path)
    out = set_meta(out, r'(<meta property="og:title" content=")[^"]*(")', title, page_path)
    out = set_meta(out, r'(<meta property="og:description" content=")[^"]*(")', description, page_path)
    out = set_meta(out, r'(<meta property="og:locale" content=")[^"]*(")', "zh_HK", page_path)
    out = set_meta(out, r'(<link rel="canonical" href=")[^"]*(")', SITE + zh_path, page_path)
    out = set_meta(out, r'(<meta property="og:url" content=")[^"]*(")', SITE + zh_path, page_path)

    # The language toggle on a Chinese page says "EN" and goes back to the English page.
    out = re.sub(
        r'<button id="langToggle"[^>]*>[^<]*</button>',
        lambda m: '<button id="langToggle" class="lang-toggle" type="button" aria-label="Switch to English" '
                  f'data-alt-href="{relative_url(en_path, zh_path)}">EN</button>',
        out, count=1,
    )
    # Load the Chinese font up front instead of waiting for i18n.js to request it.
    out = out.replace("</head>", CJK_FONT + "\n</head>", 1)

    zh_file = ROOT / ZH_DIR / page_path
    zh_file.parent.mkdir(parents=True, exist_ok=True)
    zh_file.write_text(out, encoding="utf-8")
    print(f"Built {ZH_DIR}/{page_path}")
    return f"{ZH_DIR}/{page_path}"


def clean_zh_dir(keep: set) -> None:
    """Delete generated zh pages whose English page is no longer in PAGES."""
    zh_root = ROOT / ZH_DIR
    if not zh_root.exists():
        return
    for file in zh_root.rglob("index.html"):
        rel = file.relative_to(ROOT).as_posix()
        if rel not in keep:
            file.unlink()
            print(f"Removed stale {rel}")
    for folder in sorted(zh_root.rglob("*"), reverse=True):
        if folder.is_dir() and not any(folder.iterdir()):
            shutil.rmtree(folder)


def write_sitemap() -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generated by build.py: edit PAGES there, not this file. -->',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for page_path, _, _ in PAGES:
        en_path = url_path(page_path)
        en_url, zh_url = SITE + en_path, SITE + "/" + ZH_DIR + en_path
        alternates = (
            f'<xhtml:link rel="alternate" hreflang="en" href="{en_url}"/>'
            f'<xhtml:link rel="alternate" hreflang="zh-Hant" href="{zh_url}"/>'
            f'<xhtml:link rel="alternate" hreflang="x-default" href="{en_url}"/>'
        )
        for loc in (en_url, zh_url):
            lines.append(f"  <url><loc>{loc}</loc>{alternates}</url>")
    lines.append("</urlset>")
    new = "\n".join(lines) + "\n"
    path = ROOT / "sitemap.xml"
    if not path.exists() or path.read_text(encoding="utf-8") != new:
        path.write_text(new, encoding="utf-8")
        print("Updated sitemap.xml")


if __name__ == "__main__":
    for page_path, is_home, active_key in PAGES:
        build_page(page_path, is_home, active_key)
    for page_path in [p for p, _, _ in PAGES] + ["404.html"]:
        inject_csp(page_path)
    for page_path, _, _ in PAGES:
        inject_hreflang(page_path)

    zh = load_zh_translations()
    built = {make_zh_page(page_path, zh) for page_path, _, _ in PAGES}
    clean_zh_dir(built)
    write_sitemap()
    print("Done.")
