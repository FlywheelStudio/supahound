# End-to-end check of every public page on a running build (see docs/features/marketing-site.md).
# Usage: python3 -I scripts/check-pages.py [base-url] [extra paths that must also pass...]

import json, re, sys, urllib.request
base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8788"
sm = urllib.request.urlopen(base + "/sitemap.xml").read().decode()
paths = [u.replace("https://supahound.com", "") or "/" for u in re.findall(r"<loc>(.*?)</loc>", sm)] + sys.argv[2:]
bad = 0
for p in paths:
    r = urllib.request.urlopen(base + p)
    html = r.read().decode()
    probs = []
    canon = re.search(r'<link rel="canonical" href="([^"]+)"', html)
    want = "https://supahound.com" + ("" if p == "/" else p)
    if not canon or canon.group(1) != want: probs.append(f"canonical={canon and canon.group(1)}")
    title = re.search(r"<title>(.*?)</title>", html)
    if not title: probs.append("no title")
    if not re.search(r'<meta name="description" content="[^"]{50,}"', html): probs.append("no description")
    if html.count("<h1") != 1: probs.append(f"h1 count={html.count('<h1')}")
    lds = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    types = []
    for ld in lds:
        try: types.append(json.loads(ld)["@type"])
        except Exception as e: probs.append(f"bad json-ld {e}")
    if "Organization" not in types: probs.append("no Organization LD")
    if p != "/" and "BreadcrumbList" not in types: probs.append("no breadcrumb")
    if 'href="https://flywheel.so"' not in html or "flywheel.so</a>" not in html: probs.append("no flywheel footer")
    if 'og:image' not in html: probs.append("no og:image")
    if r.headers.get("set-cookie"): probs.append("set-cookie!")
    if probs: bad += 1
    print(("FAIL " if probs else "ok   ") + p, (title.group(1) if title else ""), "|", ",".join(types), "|", "; ".join(probs))
print(f"\n{len(paths)} pages, {bad} with problems")
sys.exit(1 if bad else 0)
