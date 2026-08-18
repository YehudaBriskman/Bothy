// Serve a HOSTILE SVG through the sandbox origin and try, from inside it, to do
// the things it must not be able to do. This is the one place in the design
// where an untested assumption would be an actual vulnerability: the whole
// argument for rendering SVG and HTML at all is "sandbox + opaque origin stops
// it", and that is a claim about browser behaviour, not about our code.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// WHERE PLAYWRIGHT COMES FROM, and why it is not an import at the top.
//
// This used to be a literal path into one person's npx cache, hash and all
// (`/home/<user>/.npm/_npx/705bc6b22212b352/...`), which is unrunnable anywhere
// else and is not even stable HERE - npx recomputes that hash from the package
// set it was invoked with. A static `import` of a missing module is also a
// parse-time failure, so it could not be caught: run.sh had to stat that same
// literal path first and print the SKIP itself. Resolving dynamically moves the
// decision into this file, where the reason for it lives.
//
// SKIP, NOT FAIL, when nothing is found. A browser is a heavy dependency the
// rest of the suite does not need, and "the machine has no chromium" is not a
// finding about the sandbox. Exit 0 so run.sh's `|| fail=1` stays quiet - that
// is the behaviour this replaced and it is deliberate.
const require = createRequire(import.meta.url);

// Every place a playwright-core could be, most legitimate first.
function candidates() {
  const out = [];
  // A real dependency, if this repo ever grows one. `require.resolve` from
  // import.meta.url walks node_modules upwards exactly like an ordinary import.
  try { out.push(require.resolve('playwright-core')); } catch { /* not a dependency here */ }
  // The npx cache, because on the box this check was written for that is the
  // only copy - portal-files ships no third-party dependencies on purpose, so
  // there is no package.json to put playwright in. SCANNED, not named: the hash
  // directory is derived from the package set npx was invoked with, so a literal
  // one goes stale the next time anyone runs npx differently. Sorted so the
  // choice does not depend on directory order.
  const cache = join(process.env.npm_config_cache || join(homedir(), '.npm'), '_npx');
  let entries = [];
  try { entries = readdirSync(cache).sort(); } catch { return out; }
  for (const e of entries) {
    const mods = join(cache, e, 'node_modules');
    if (!existsSync(join(mods, 'playwright-core'))) continue;
    try { out.push(require.resolve('playwright-core', { paths: [mods] })); }
    catch { /* a half-removed cache entry - keep looking */ }
  }
  return out;
}

// PICK ONE THAT CAN ACTUALLY LAUNCH, which is a separate question from "is
// playwright installed". Each playwright-core pins one browser BUILD NUMBER and
// downloads it into ~/.cache/ms-playwright; a cache entry left behind by an old
// `npx playwright` still imports perfectly and then dies with "Executable
// doesn't exist at .../chromium-1234/...". That is exactly what the hardcoded
// path this replaced had rotted into - it named a copy whose browser had been
// cleaned up, so the check FAILED the suite every run while looking like a
// finding about the sandbox. Ask for executablePath() and require the file.
let chromium = null;
for (const entry of candidates()) {
  let mod;
  try { mod = await import(pathToFileURL(entry).href); }
  catch { continue; }
  // `?? .default` because playwright-core's main entry is CommonJS and node only
  // sometimes detects its named exports.
  const c = mod.chromium ?? mod.default?.chromium;
  if (!c) continue;
  try { if (!existsSync(c.executablePath())) continue; } catch { continue; }
  chromium = c;
  break;
}
if (!chromium) {
  console.log('  SKIP: playwright-core not installed');
  process.exit(0);
}

const [U,P]=[process.env.DEV_LOGIN_USER,process.env.DEV_LOGIN_PASSWORD];
// Resolved ONCE, by checks/env.py, and handed here through the environment by
// run.sh. A second implementation of the same four-rung lookup in javascript
// would drift, and the first symptom would be this check probing an origin
// nobody is serving and reporting "nothing escaped".
const BASE=process.env.BOTHY_BASE, SB=process.env.BOTHY_SANDBOX;
const F=join(process.env.NOTES_ROOT || join(homedir(), 'claude-notes'), '_hostile-probe.svg');

// An SVG that tries to exfiltrate. If the sandbox holds, none of it runs.
writeFileSync(F, `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">
  <text x="4" y="20" font-size="12">probe</text>
  <script type="application/javascript"><![CDATA[
    window.__ESCAPED = 'script ran';
    try { fetch('${SB}/-/api/files/read?root=notes&path=README.md')
      .then(r => r.text()).then(t => { window.__READ = t.length; }); } catch(e) { window.__READERR = String(e); }
    try { window.__PARENT = String(parent.location.href); } catch(e) { window.__PARENTERR = 'blocked'; }
    try { window.__COOKIE = document.cookie; } catch(e) { window.__COOKIEERR = 'blocked'; }
  ]]></script>
</svg>`);

let cleanedUp = false;
const cleanup = () => { if (!cleanedUp && existsSync(F)) { unlinkSync(F); cleanedUp = true; } };
process.on('exit', cleanup);
process.on('uncaughtException', e => { cleanup(); console.error(e); process.exit(1); });

const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1200,height:800}});
const p=await ctx.newPage();
await p.goto(`${BASE}/oauth2/sign_in?rd=%2F`);
await p.evaluate(()=>document.querySelector('form').submit()); await p.waitForTimeout(1500);
await p.fill('#username',U); await p.fill('#password',P);
await p.evaluate(()=>document.querySelector('#kc-form-login').submit()); await p.waitForTimeout(2500);

const url = `${SB}/-/api/files/raw?root=notes&path=_hostile-probe.svg`;
const hdr = await p.evaluate(async u => {
  const r = await fetch(u, {credentials:'include'}).catch(()=>null);
  return r ? {status:r.status, ctype:r.headers.get('content-type'), csp:r.headers.get('content-security-policy')} : 'cors-blocked (expected)';
}, url).catch(e=>String(e));
console.log(`  served as: ${JSON.stringify(hdr)}`);

// Frame it from the portal, exactly as the viewer will.
await p.goto(`${BASE}/`);
await p.evaluate(u => new Promise(done => {
  const f = document.createElement('iframe');
  f.id='probe'; f.src=u; f.onload=()=>done(); document.body.appendChild(f);
  setTimeout(done, 4000);
}), url);
await p.waitForTimeout(2500);

const frames = p.frames().filter(f => f.url().includes('_hostile-probe'));
console.log(`  frames matching the svg: ${frames.length}`);
for (const f of frames) {
  const r = await f.evaluate(() => ({
    escaped: window.__ESCAPED ?? null,
    read: window.__READ ?? null, readErr: window.__READERR ?? null,
    parent: window.__PARENT ?? null, parentErr: window.__PARENTERR ?? null,
    cookie: window.__COOKIE ?? null, cookieErr: window.__COOKIEERR ?? null,
    origin: String(location.origin),
  })).catch(e => ({evalErr: String(e).slice(0,80)}));
  console.log(`  inside the frame: ${JSON.stringify(r)}`);
}
// And the portal must be untouched.
console.log(`  portal still intact: ${await p.evaluate(()=>document.title)}`);

// THE CONTROL, and it is not optional. "No script ran" is only meaningful if the
// same payload DOES run when nothing stops it - otherwise a malformed SVG would
// pass this test forever while proving nothing.
const ctlSrc = `<svg xmlns="http://www.w3.org/2000/svg"><script type="application/javascript"><![CDATA[ window.__ESCAPED='script ran'; ]]><\/script></svg>`;
// ON about:blank, NOT on the portal page. The portal now sends a CSP of its own,
// and a `srcdoc` iframe INHERITS the embedding document's policy - so running the
// control there measured the portal's CSP instead of the payload, reported "the
// control does not execute anywhere", and correctly called itself vacuous. The
// control has to sit outside every policy or it is not a control.
const ctlPage = await ctx.newPage();
await ctlPage.goto('about:blank');
await ctlPage.evaluate(src => new Promise(done => {
  const f=document.createElement('iframe'); f.srcdoc=src; f.onload=()=>done();
  document.body.appendChild(f); setTimeout(done,3000);
}), ctlSrc);
await ctlPage.waitForTimeout(1000);
const ctl = ctlPage.frames().filter(f => f !== ctlPage.mainFrame()).pop();
const ctlRan = ctl ? await ctl.evaluate(()=>window.__ESCAPED ?? null).catch(()=>null) : null;
console.log(`  control (same payload, no CSP): ${JSON.stringify(ctlRan)}`);

const framed = frames.length > 0;
let bad = 0;
if (!framed) { console.log('FAIL  the svg was never framed - nothing was tested'); bad++; }
if (!ctlRan) { console.log('FAIL  the control payload does not execute anywhere - this test is vacuous'); bad++; }
// Interrogate the frame for EVERY escape it attempted, and distinguish
// "blocked" from "I could not look".
//
// The previous shape was `.catch(() => null)` and then `if (r) FAIL` - so an
// evaluate that REJECTED (detached frame, failed load, opaque origin refusing
// the call) produced null, which was the PASS value. "The script was blocked"
// and "the test could not check" were the same result. It also only ever
// asserted __ESCAPED, while __READ / __PARENT / __COOKIE were collected,
// printed, and never checked - a regression letting the SVG read
// document.cookie but not set a global would have printed the cookie and
// exited 0.
for (const f of frames) {
  let probe;
  try {
    probe = await f.evaluate(() => ({
      escaped: window.__ESCAPED ?? null,
      read: window.__READ ?? null,
      parent: window.__PARENT ?? null,
      cookie: window.__COOKIE ?? null,
    }));
  } catch (e) {
    console.log(`FAIL  could not interrogate the sandbox frame - this test proved nothing: ${String(e).slice(0,90)}`);
    bad++;
    continue;
  }
  for (const [k, v] of Object.entries(probe)) {
    if (v) { console.log(`FAIL  a hostile script ESCAPED via ${k}: ${String(v).slice(0,80)}`); bad++; }
  }
}
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
await b.close();
unlinkSync(F);
process.exit(bad ? 1 : 0);
