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
  {{NAV_HOUSE_LAND_ACTIVE}}, {{NAV_RENOVATIONS_ACTIVE}}, {{NAV_MULTI_UNIT_ACTIVE}},
  {{NAV_PROJECT_MGMT_ACTIVE}}, {{NAV_INSPECTIONS_ACTIVE}}, {{NAV_PROJECTS_ACTIVE}}, {{NAV_ABOUT_ACTIVE}},
  {{NAV_FAQ_ACTIVE}}, {{NAV_CONTACT_ACTIVE}}
             become ' class="is-active"' on the nav link of the page being
             built (chosen per page in PAGES below) and "" everywhere else.
  {{NAV_GROUP_BUILD_ACTIVE}}, {{NAV_GROUP_MGMT_ACTIVE}}
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

Usage:
    python build.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
PARTIALS = ROOT / "partial"

NAV_KEYS = [
    "home", "custom_homes", "knockdown", "house_land", "renovations", "multi_unit",
    "project_mgmt", "inspections", "projects", "about", "faq", "contact",
]

# Which pages live under each dropdown in the nav (so its button is highlighted).
NAV_GROUPS = {
    "BUILD": {"custom_homes", "knockdown", "house_land", "renovations", "multi_unit"},
    "MGMT": {"project_mgmt", "inspections"},
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
    ("renovations-extensions/index.html", False, "renovations"),
]


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


def build_page(page_path: str, is_home: bool, active_key) -> None:
    path = ROOT / page_path
    page_html = path.read_text(encoding="utf-8")
    header_html = (PARTIALS / "header.html").read_text(encoding="utf-8")
    footer_html = (PARTIALS / "footer.html").read_text(encoding="utf-8")

    root_prefix = "" if is_home else "../"
    header_html = header_html.replace("{{ROOT}}", root_prefix)
    footer_html = footer_html.replace("{{ROOT}}", root_prefix)

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


if __name__ == "__main__":
    for page_path, is_home, active_key in PAGES:
        build_page(page_path, is_home, active_key)
    print("Done.")
