// Serve a HOSTILE SVG through the sandbox origin and try, from inside it, to do
// the things it must not be able to do. This is the one place in the design
// where an untested assumption would be an actual vulnerability: the whole
// argument for rendering SVG and HTML at all is "sandbox + opaque origin stops
// it", and that is a claim about browser behaviour, not about our code.
import { chromium } from '/home/devssh/.npm/_npx/705bc6b22212b352/node_modules/playwright-core/index.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
const [U,P]=[process.env.DEV_LOGIN_USER,process.env.DEV_LOGIN_PASSWORD];
const BASE='http://100.117.176.85', SB='http://100.117.176.85:8100';
const F='/home/devssh/claude-notes/_hostile-probe.svg';

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
await p.evaluate(src => new Promise(done => {
  const f=document.createElement('iframe'); f.srcdoc=src; f.onload=()=>done();
  document.body.appendChild(f); setTimeout(done,3000);
}), ctlSrc);
await p.waitForTimeout(1000);
const ctl = p.frames().filter(f => f !== p.mainFrame() && !f.url().includes('_hostile-probe')).pop();
const ctlRan = ctl ? await ctl.evaluate(()=>window.__ESCAPED ?? null).catch(()=>null) : null;
console.log(`  control (same payload, no CSP): ${JSON.stringify(ctlRan)}`);

const framed = frames.length > 0;
const escaped = false;   // set above only if any frame reported __ESCAPED
let bad = 0;
if (!framed) { console.log('FAIL  the svg was never framed - nothing was tested'); bad++; }
if (!ctlRan) { console.log('FAIL  the control payload does not execute anywhere - this test is vacuous'); bad++; }
for (const f of frames) {
  const r = await f.evaluate(()=>window.__ESCAPED ?? null).catch(()=>null);
  if (r) { console.log(`FAIL  a hostile script RAN inside the sandbox frame: ${r}`); bad++; }
}
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
await b.close();
unlinkSync(F);
process.exit(bad ? 1 : 0);
