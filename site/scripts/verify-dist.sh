#!/usr/bin/env bash
# Every public URL the built site must still serve, and nothing it must not.
# Run from site/ after `npm run build`. One copy, used by CI and by the (dispatch-only) Pages deploy.
set -u
fail=0

# Route files come from the prerender's own record, so a new page is checked without editing this list.
files=$(node -e "console.log(JSON.parse(require('fs').readFileSync('dist-prerender/routes.json','utf8')).files.join('\n'))") || { echo "::error::no dist-prerender/routes.json - build first"; exit 1; }
count=$(printf '%s\n' "$files" | grep -c . || true)
echo "  routes: $count files"
[ "$count" -ge 15 ] || { echo "::error::only $count routes rendered - expected the four sections and the docs"; fail=1; }
for f in $files 404.html index.html install/index.html docs/index.html changelog/index.html search-index.json favicon.svg robots.txt site.webmanifest apple-touch-icon.png og/home.jpg security.txt; do
  [ -s "dist/$f" ] || { echo "::error::dist/$f is missing or empty"; fail=1; }
done

# The site must work with no network: no stylesheet, script, font or image from another origin.
if grep -rEl '<(script|link|img)[^>]+(src|href)="https?://' dist --include=*.html | grep -v '^$' | while read -r f; do
     grep -Eo '<(script|link|img)[^>]+(src|href)="https?://[^"]*"' "$f" | grep -Ev 'rel="(canonical|alternate)"' | grep -q . && echo "$f"; done | grep -q .; then
  echo "::error::a page loads a resource from another origin (offline rule)"; fail=1
fi
if grep -rEq 'url\(["'"'"']?https?://|@import +["'"'"']?https?://' dist --include=*.css; then
  echo "::error::a stylesheet pulls from another origin"; fail=1
fi
# Hebrew-readiness: no physical direction in the stylesheet.
if grep -Eq '(margin|padding|border)-(left|right)|text-align: *(left|right)|(^|[^-])(left|right): ' dist/assets/*.css; then
  echo "::error::physical left/right in the stylesheet; use logical properties"; fail=1
fi
sections=$(grep -o '"id"\|"h"' dist/search-index.json | wc -l)
[ "$sections" -ge 50 ] || { echo "::error::search index has too few sections ($sections)"; fail=1; }

# The Content-Security-Policy <meta>: first in every page's head, and every inline script on the page is allowed by hash
# (and nothing is allowed by 'unsafe-inline' for scripts), so an injected script would not run.
node -e "
const fs=require('fs'),cr=require('crypto'),path=require('path');let bad=0,n=0;
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory()){if(/^(sky-spike|scene-mock|brand-mock|section-mock)\$/.test(f))continue;walk(p);}else if(f.endsWith('.html')){n++;const h=fs.readFileSync(p,'utf8');
const m=h.match(/<meta http-equiv=\"Content-Security-Policy\" content=\"([^\"]*)\"/);if(!m){console.log('::error::'+p+': no Content-Security-Policy meta');bad++;continue;}
const csp=m[1].replace(/&#39;/g,\"'\");const sc=(csp.match(/script-src([^;]*)/)||[,''])[1];
if(/unsafe-inline|unsafe-eval|\*|https?:/.test(sc)){console.log('::error::'+p+': script-src is too wide: '+sc);bad++;}
if(h.indexOf('Content-Security-Policy')>h.search(/<(script|link)[ >]/)){console.log('::error::'+p+': the CSP meta is not before the first script or link');bad++;}
for(const s of h.matchAll(/<script(?![^>]*(\bsrc=|type=\"application\/ld\+json\"))[^>]*>([\s\S]*?)<\/script>/g)){const hash=\"'sha256-\"+cr.createHash('sha256').update(s[2]).digest('base64')+\"'\";if(!csp.includes(hash)){console.log('::error::'+p+': an inline script is not in the CSP');bad++;}}}}})('dist');
console.log('  csp: '+n+' pages checked');process.exit(bad?1:0)" || fail=1

node scripts/check-links.mjs || fail=1
node scripts/check-public.mjs || fail=1
node scripts/check-seo.mjs || fail=1
[ "$fail" = 0 ] && echo "verify-dist: ok"
exit $fail
