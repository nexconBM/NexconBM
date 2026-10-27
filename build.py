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
  {{NAV_PROP_RENO_ACTIVE}}, {{NAV_OTHER_SERVICES_ACTIVE}}, {{NAV_ABOUT_ACTIVE}},
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
and sitemap.xml is rewritten to list every language.

Simplified Chinese pages (/zh-hans/...): each /zh/ page is converted from Traditional to Simplified
characters with OpenCC (pip install opencc), then HANS_WORDS swaps Hong Kong wording for the words
mainland Chinese readers use and search for (e.g. 买楼 -> 买房). Like zh/, never edit zh-hans/ by
hand. Text that scripts add after load (calculator, booking, forms) comes from translations.zh;
build.py writes a Simplified copy of it to translations-hans.js, which zh-hans pages load after
translations.js.

Site search: the magnifier in the header (partial/header.html, search.js) searches a small JSON file
per language, written by write_search_index() from the built pages' <main> text: search-index-en.json,
search-index-zh.json, search-index-hans.json (all in the site root, regenerated every run). SEARCH_EXTRA
adds keywords a page should be found by even though the words aren't in its text (they rank above
ordinary text matches).

Language switcher: {{LANG_SWITCH}} in partial/header.html becomes "Eng | 繁 | 简", three links to
this page in each language (see lang_switch), between <!-- LANGSWITCH:START/END --> markers so
the Chinese copies can re-point them.

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
HANS_DIR = "zh-hans"

# The language switcher, in display order: (data-lang key, URL prefix, lang code, label, full name).
LANGS = [
    ("en", "", "en", "Eng", "English"),
    ("zh-hant", "/" + ZH_DIR, "zh-Hant", "繁", "繁體中文"),
    ("zh-hans", "/" + HANS_DIR, "zh-Hans", "简", "简体中文"),
]

# Hong Kong wording -> mainland wording, applied after OpenCC has converted the characters
# (so the left side is already Simplified). Longest phrases first; check new Chinese text against
# this list when you add it.
HANS_WORDS = [
    ("购买前检验", "买房前验房"),
    ("业主立案法团", "业主委员会"),
    ("拆卸重建", "推倒重建"),
    ("度身订造", "量身定制"),
    ("维多利亚省", "维多利亚州"),
    ("交楼验收", "交房验收"),
    ("屋地套餐", "房地套餐"),
    ("联系资料", "联系方式"),
    ("联络资料", "联系方式"),
    ("验楼师", "验房师"),
    ("住宅升降机", "家用电梯"),
    ("升降机", "电梯"),
    ("著眼", "着眼"),
    ("意味著", "意味着"),
    ("讯息", "信息"),
    ("透过", "通过"),
    ("买楼", "买房"),
    ("交楼", "交房"),
    ("收楼", "收房"),
    ("新楼", "新房"),
    ("楼宇", "房屋"),
    ("家私", "家具"),
    ("订造", "定制"),
    ("联络", "联系"),
    ("睡房", "卧室"),
    ("视乎", "取决于"),
    ("质素", "质量"),
    ("新屋", "新房"),
    ("旧屋", "旧房"),
    ("建屋", "建房"),
    ("地台", "地板"),
    ("簷槽", "檐沟"),
    ("檐槽", "檐沟"),
    ("传送", "发送"),
    ("电邮", "电子邮箱"),
    ("搜寻", "搜索"),
    ("关键字", "关键词"),
]

NAV_KEYS = [
    "home", "custom_homes", "knockdown", "house_land", "multi_unit",
    "project_mgmt", "inspections", "prop_mgmt", "prop_maint", "prop_reno", "other_services",
    "about", "faq", "contact",
]

# Which pages live under each dropdown in the nav (so its button is highlighted).
NAV_GROUPS = {
    "BUILD": {"custom_homes", "knockdown", "house_land", "multi_unit"},
    "MGMT": {"project_mgmt", "inspections", "prop_mgmt", "prop_maint", "prop_reno", "other_services", "projects"},
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
    ("other-services/index.html", False, "other_services"),
]

# Chinese <title> and meta description for each page's /zh/ copy. These are what Google shows
# in Chinese search results, so they lead with the words people search for (墨爾本 + service)
# and keep "Nexcon" so a search for the English brand name still matches.
ZH_META = {
    "index.html": (
        "墨爾本建築商｜定製住宅、推倒重建、驗房｜世代建築管理 Nexcon",
        "世代建築管理（Nexcon）是墨爾本住宅建築商（builder），提供定製住宅、House and Land 房屋土地套餐、推倒重建（knockdown rebuild）及新房驗房服務，每個項目均享7年結構保養。",
    ),
    "about/index.html": (
        "關於我們｜墨爾本建築商 世代建築管理 Nexcon",
        "認識世代建築管理（Nexcon）的墨爾本團隊：住宅建築、項目管理及樓宇檢驗，由合資格土木工程師帶領。",
    ),
    "contact/index.html": (
        "聯絡我們｜墨爾本建築商、驗房預約｜世代建築管理 Nexcon",
        "告訴我們您在墨爾本的度身訂造住宅、拆卸重建、翻新或檢驗項目。歡迎發送查詢或致電我們。",
    ),
    "custom-homes/index.html": (
        "墨爾本定製住宅建築商｜Custom Home Builder｜世代建築管理 Nexcon",
        "墨爾本定製房屋：按照您的生活方式、地塊及預算設計及興建度身訂造的家。世代建築管理在墨爾本為您統籌設計、審批、施工及交樓。",
    ),
    "faq/index.html": (
        "墨爾本建房常見問題｜定製住宅、推倒重建、驗房｜世代建築管理 Nexcon",
        "解答有關度身訂造住宅、拆卸重建、樓宇檢驗、固定價格屋地套餐及施工管理的常見問題。",
    ),
    "house-and-land/index.html": (
        "墨爾本房屋土地套餐 House and Land｜世代建築管理 Nexcon",
        "瀏覽世代建築管理在墨爾本及維多利亞省的固定價格房屋土地套餐（House and Land），精選住宅設計及地點，切合不同生活方式及預算。",
    ),
    "building-inspections/index.html": (
        "墨爾本新房驗房｜竣工驗收 PCI｜世代建築管理 Nexcon",
        "墨爾本及維多利亞省專業新房驗房（building inspection）服務，包括各施工階段檢驗及交房前竣工驗收（PCI），可於網上預約。",
    ),
    "knockdown-rebuild/index.html": (
        "墨爾本推倒重建 Knockdown Rebuild｜世代建築管理 Nexcon",
        "墨爾本推倒重建（拆卸重建）：以全新定製住宅取代舊屋。世代建築管理在墨爾本全程管理拆卸重建項目，由規劃、審批到交樓。",
    ),
    "multi-unit-development/index.html": (
        "墨爾本多單位開發｜Townhouse 聯排別墅｜世代建築管理 Nexcon",
        "世代建築管理為墨爾本的住宅及多單位發展項目提供項目統籌及施工管理支援。",
    ),
    "projects/index.html": (
        "項目案例｜墨爾本建房作品｜世代建築管理 Nexcon",
        "瀏覽世代建築管理在墨爾本的精選項目，了解我們如何處理設計、施工、統籌及解決問題。",
    ),
    "project-management/index.html": (
        "墨爾本建築項目管理｜建房監理｜世代建築管理 Nexcon",
        "墨爾本住宅建築項目管理：統籌建築商、審閱報價、施工檢驗及進度監察。",
    ),
    "renovations-extensions/index.html": (
        "墨爾本房屋裝修及擴建｜Renovation & Extension｜世代建築管理 Nexcon",
        "為墨爾本自住及投資物業規劃及管理翻新及加建工程：工程範圍、預算、統籌技工及進度報告。",
    ),
    "property-management/index.html": (
        "墨爾本物業管理｜房屋維護規劃｜世代建築管理 Nexcon",
        "以樓宇狀況為本的墨爾本物業管理：狀況評估、保養規劃、統籌技工及清晰報告。",
    ),
    "other-services/index.html": (
        "墨爾本園藝割草及家具維修｜其他服務｜世代建築管理 Nexcon",
        "墨爾本園藝、割草、修剪樹木，以及家具製作及維修服務，由世代建築管理（Nexcon）團隊處理。",
    ),
    "property-maintenance/index.html": (
        "墨爾本房屋維修及保養｜Property Maintenance｜世代建築管理 Nexcon",
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
    header_html = header_html.replace("{{LANG_SWITCH}}", lang_switch("en", en_path, en_path))

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
    en_url, zh_url, hans_url = SITE + en_path, SITE + "/" + ZH_DIR + en_path, SITE + "/" + HANS_DIR + en_path
    return "\n".join([
        "<!-- HREFLANG:START -->",
        f'<link rel="alternate" hreflang="en" href="{en_url}">',
        f'<link rel="alternate" hreflang="zh-Hans" href="{hans_url}">',
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

    # rewrite_links pointed every switcher link at a zh page; redraw it for this page.
    out = stitch(out, "LANGSWITCH", lang_switch("zh-hant", en_path, zh_path), page_path)
    # Load the Chinese font up front instead of waiting for i18n.js to request it.
    out = out.replace("</head>", CJK_FONT + "\n</head>", 1)

    zh_file = ROOT / ZH_DIR / page_path
    zh_file.parent.mkdir(parents=True, exist_ok=True)
    zh_file.write_text(out, encoding="utf-8")
    print(f"Built {ZH_DIR}/{page_path}")
    return f"{ZH_DIR}/{page_path}"


def lang_switch(current: str, en_path: str, from_dir: str) -> str:
    """The "Eng | 繁 | 简" switcher for one page, as seen from from_dir, with current marked."""
    links = []
    for key, prefix, code, label, name in LANGS:
        href = relative_url(prefix + en_path, from_dir)
        here = ' aria-current="page"' if key == current else ""
        links.append(f'<a href="{href}" lang="{code}" hreflang="{code}" data-lang="{key}" title="{name}"{here}>{label}</a>')
    return ("<!-- LANGSWITCH:START -->\n"
            '      <div class="lang-switch" id="langSwitch" role="group" aria-label="Language / 语言 / 語言">'
            + '<span class="lang-sep" aria-hidden="true">|</span>'.join(links)
            + "</div>\n      <!-- LANGSWITCH:END -->")


def simplified_converter():
    try:
        import opencc
    except ImportError:
        sys.exit("ERROR: the Simplified Chinese pages need OpenCC. Run: pip install opencc")
    converter = opencc.OpenCC("hk2s")

    def to_hans(text: str) -> str:
        text = converter.convert(text)
        for hk, mainland in HANS_WORDS:
            text = text.replace(hk, mainland)
        return text

    return to_hans


def make_hans_page(page_path: str, to_hans) -> str:
    """Build the /zh-hans/ copy of a page from its (already built) /zh/ copy and return its path."""
    en_path = url_path(page_path)
    hans_path = "/" + HANS_DIR + en_path
    # zh/ and zh-hans/ have the same folder depth, so every relative link carries over unchanged.
    out = to_hans((ROOT / ZH_DIR / page_path).read_text(encoding="utf-8"))

    out = re.sub(r'<html lang="[^"]*"', '<html lang="zh-Hans"', out, count=1)
    out = set_meta(out, r'(<meta property="og:locale" content=")[^"]*(")', "zh_CN", page_path)
    out = set_meta(out, r'(<link rel="canonical" href=")[^"]*(")', SITE + hans_path, page_path)
    out = set_meta(out, r'(<meta property="og:url" content=")[^"]*(")', SITE + hans_path, page_path)
    out = stitch(out, "LANGSWITCH", lang_switch("zh-hans", en_path, hans_path), page_path)
    out = out.replace("family=Noto+Sans+TC:", "family=Noto+Sans+SC:")
    # Script-added text reads translations.zh: load the Simplified copy over it.
    out = re.sub(r'(<script src="([^"]*)translations\.js"></script>)',
                 lambda m: m.group(1) + f'\n<script src="{m.group(2)}translations-hans.js"></script>', out, count=1)

    hans_file = ROOT / HANS_DIR / page_path
    hans_file.parent.mkdir(parents=True, exist_ok=True)
    hans_file.write_text(out, encoding="utf-8")
    print(f"Built {HANS_DIR}/{page_path}")
    return f"{HANS_DIR}/{page_path}"


def write_hans_translations(zh: dict, to_hans) -> None:
    """translations-hans.js: translations.zh in Simplified, loaded by zh-hans pages after translations.js."""
    hans = {key: to_hans(value) for key, value in zh.items()}
    new = ("/* Generated by build.py from the zh block of translations.js: edit that, not this file.\n"
           "   Loaded after translations.js on /zh-hans/ pages so script-added text is Simplified too. */\n"
           "translations.zh = " + json.dumps(hans, ensure_ascii=False, indent=2) + ";\n")
    path = ROOT / "translations-hans.js"
    if not path.exists() or path.read_text(encoding="utf-8") != new:
        path.write_text(new, encoding="utf-8")
        print("Updated translations-hans.js")


def clean_zh_dir(keep: set, folder_name: str = ZH_DIR) -> None:
    """Delete generated Chinese pages whose English page is no longer in PAGES."""
    zh_root = ROOT / folder_name
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


# sitemap-en.xml lists the English pages and sitemap-zh.xml both Chinese versions (so Search
# Console reports their indexing separately); sitemap.xml is the index that lists the two, and
# is the only one robots.txt and Search Console need.
SITEMAPS = [("sitemap-en.xml", [""]), ("sitemap-zh.xml", ["/" + HANS_DIR, "/" + ZH_DIR])]


def write_if_changed(name: str, text: str) -> None:
    path = ROOT / name
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")
        print(f"Updated {name}")


# Extra words each page should be found by (in the page's own language), added to its search entry.
SEARCH_EXTRA = {
    "building-inspections/index.html": {
        "en": "price prices pricing cost fee fees quote book booking calendar appointment pest control PCI practical completion pool",
        "zh": "價錢 價格 收費 費用 報價 預約 預訂 日曆 蟲害 竣工驗收 泳池",
    },
}


class _TextExtractor(HTMLParser):
    """The visible text of an HTML fragment (no scripts, styles or tags)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.skip += 1
        if tag in ("p", "div", "li", "h1", "h2", "h3", "br", "section"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self.skip:
            self.skip -= 1
        if tag in ("p", "div", "li", "h1", "h2", "h3", "section"):
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.parts)).strip()


def write_search_index(to_hans) -> None:
    """One JSON file per language: [{u: path, t: title, d: description, b: body text}, ...]."""
    for name, folder, lang in (("search-index-en.json", "", "en"), ("search-index-zh.json", ZH_DIR, "zh"),
                               ("search-index-hans.json", HANS_DIR, "hans")):
        entries = []
        for page_path, _, _ in PAGES:
            built = (folder + "/" if folder else "") + page_path
            page_html = (ROOT / built).read_text(encoding="utf-8")
            main = re.search(r'<main id="main">(.*?)</main>', page_html, re.S)
            if not main:
                continue
            h1 = re.search(r"<h1[^>]*>(.*?)</h1>", main.group(1), re.S)
            title_src = h1.group(1) if h1 else re.search(r"<title>(.*?)</title>", page_html, re.S).group(1)
            title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html.unescape(title_src))).strip()
            desc_match = re.search(r'<meta name="description" content="([^"]*)"', page_html)
            desc = html.unescape(desc_match.group(1)) if desc_match else ""
            extractor = _TextExtractor()
            extractor.feed(main.group(1))
            body = extractor.text()
            extra = SEARCH_EXTRA.get(page_path, {}).get("en" if lang == "en" else "zh", "")
            entry = {"u": (("/" + folder) if folder else "") + url_path(page_path), "t": title, "d": desc, "b": body}
            if extra:
                entry["k"] = to_hans(extra) if lang == "hans" else extra  # keywords: found by these even if not in the text
            entries.append(entry)
        write_if_changed(name, json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_sitemap() -> None:
    for name, prefixes in SITEMAPS:
        lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!-- Generated by build.py: edit PAGES there, not this file. -->',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        ]
        for prefix in prefixes:
            for page_path, _, _ in PAGES:
                en_path = url_path(page_path)
                en_url, zh_url, hans_url = SITE + en_path, SITE + "/" + ZH_DIR + en_path, SITE + "/" + HANS_DIR + en_path
                alternates = (
                    f'<xhtml:link rel="alternate" hreflang="en" href="{en_url}"/>'
                    f'<xhtml:link rel="alternate" hreflang="zh-Hans" href="{hans_url}"/>'
                    f'<xhtml:link rel="alternate" hreflang="zh-Hant" href="{zh_url}"/>'
                    f'<xhtml:link rel="alternate" hreflang="x-default" href="{en_url}"/>'
                )
                lines.append(f"  <url><loc>{SITE}{prefix}{en_path}</loc>{alternates}</url>")
        lines.append("</urlset>")
        write_if_changed(name, "\n".join(lines) + "\n")

    index = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generated by build.py: lists the English and Chinese sitemaps. -->',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ] + [f"  <sitemap><loc>{SITE}/{name}</loc></sitemap>" for name, _ in SITEMAPS] + ["</sitemapindex>"]
    write_if_changed("sitemap.xml", "\n".join(index) + "\n")


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

    to_hans = simplified_converter()
    write_hans_translations(zh, to_hans)
    built = {make_hans_page(page_path, to_hans) for page_path, _, _ in PAGES}
    clean_zh_dir(built, HANS_DIR)
    write_search_index(to_hans)
    write_sitemap()
    print("Done.")
