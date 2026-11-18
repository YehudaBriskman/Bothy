// The Bothy sky, phase 0 spike. Raw WebGL2, no dependencies, no requests to other origins.
// One real photograph per light (day, dusk, night) is cross-faded and graded by the hour table in sky-keys.js.
// Depth is derived from each photograph's own colour (bright, unsaturated = near cloud; saturated blue = far sky).
import { sample, bodies, localHour, fmt } from './sky-keys.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const noHover = matchMedia('(hover: none)').matches || matchMedia('(max-width: 720px)').matches;
const debug = q.get('debug');
const forceMix = ['day', 'dusk', 'night'].indexOf(q.get('mix') ?? '');
const manual = q.get('manual') === '1';
const raysOn = q.get('rays') === '1'; // ?rays=1: opt-in light shafts (off by default: the clouds stay as photographed)
const textLight = q.get('light') !== '0'; // ?light=0: the headline is not lit by the sun or moon // test harness: no rAF loop; window.__sky.frame(dt) steps and draws
const PHOTOS = ['day', 'dusk', 'night'];
// Per photograph depth recipe: depth = clamp((luma - bias - sat * satW) * gain). Tuned by eye with ?debug=depth.
const DEPTH = [
  [0.34, 1.15, 3.2], // day: white cumulus vs saturated blue
  [0.04, 0, -10], // dusk: warm-grey cloud (r >= b) vs blue sky (b > r); negative gain selects the hue recipe
  [0.45, 0.3, 3.0], // night: only the stars count
];
const NEAR = 1.0;
const FAR = 0.22; // near moves ~4.5x more than far

const state = {
  live: true,
  hour: 12,
  paused: false,
  time: 0, // simulation seconds
  lean: [0, 0],
  target: [0, 0],
  samples: [], // wake: {x,y,t,dx,dy,sp}
  last: null,
  arrive0: null,
  scale: 1,
  gov: 1,
  bytes: 0,
  fmt: ['avif', 'webp'],
  dirty: true,
  onscreen: true,
};

// ---------------------------------------------------------------- hour
const forced = q.get('hour');
if (forced !== null && forced.trim() !== '' && Number.isFinite(+forced)) {
  state.live = false;
  state.hour = ((+forced % 24) + 24) % 24;
} else {
  state.hour = localHour();
}
let cur = sample(state.hour);
let bod = bodies(state.hour);

const root = document.documentElement;
const rgb = (a) => `rgb(${a.map((x) => Math.round(Math.min(255, Math.max(0, x)))).join(',')})`;

const lit = { x: 0.5, y: 0.2, k: 0, col: [1, 1, 1], moon: 0, sunK: 0, moonK: 0, illum: 0.5 };
function computeLight() {
  const horizon = 0.8;
  const sunY = horizon - Math.max(bod.sun.elev, -0.15) * 0.64;
  const sunK = Math.min(1, Math.max(0, (bod.sun.elev + 0.04) / 0.1));
  const moonY = horizon - Math.max(bod.moon.elev, -0.15) * 0.62;
  const illum = (1 - Math.cos(bod.phase * 2 * Math.PI)) / 2;
  const moonK = Math.min(1, Math.max(0, (bod.moon.elev + 0.02) / 0.12)) * cur.moonK;
  lit.sunY = sunY;
  lit.moonY = moonY;
  lit.sunK = sunK;
  lit.moonK = moonK;
  lit.illum = illum;
  const moonS = moonK * (0.35 + 0.65 * illum);
  if (sunK >= moonS) {
    lit.x = bod.sun.x;
    lit.y = sunY;
    lit.k = sunK;
    lit.moon = 0;
    lit.col = cur.sunCol;
  } else {
    lit.x = bod.moon.x;
    lit.y = moonY;
    lit.k = moonS;
    lit.moon = 1;
    lit.col = [0.72, 0.82, 1];
  }
}

// The headline and tagline are lit by the same light: a gradient fill that is warmer and brighter on the side facing
// it, a thin rim of light on that edge, and a soft shadow on the far side. Text stays above the contrast floor.
const litEls = [...document.querySelectorAll('.hero h1, .hero p')];
const canClip = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('background-clip', 'text');
if (canClip && textLight) document.querySelector('.hero').classList.add('lit');
let litSig = '';
function lightText() {
  if (!canClip || !textLight) return;
  const ax = state.lean[0] * 0.05; // the pointer leans the light a little, so it sweeps across the words
  const ay = state.lean[1] * 0.03;
  const lx = (lit.x + ax) * innerWidth;
  const ly = (lit.y + ay) * innerHeight;
  const sig = `${Math.round(lx / 3)},${Math.round(ly / 3)},${Math.round(lit.k * 40)},${lit.moon}`;
  if (sig === litSig) return;
  litSig = sig;
  const k = lit.k;
  const ink = [247, 245, 239];
  const warm = lit.col.map((c) => 255 * Math.min(1, c));
  const near = ink.map((v, i) => Math.round(v + (Math.min(255, warm[i] * 1.02) - v) * 0.4 * k));
  const far = [ink[0] * (1 - 0.14 * k), ink[1] * (1 - 0.12 * k), ink[2] * (1 - 0.09 * k)].map(Math.round);
  for (const el of litEls) {
    const r = el.getBoundingClientRect();
    const px = lx - r.x;
    const py = ly - r.y;
    const dx = px - r.width / 2;
    const dy = py - r.height / 2;
    const dist = Math.hypot(dx, dy) || 1;
    const R = dist + 0.6 * r.width;
    const n0 = Math.max(0, Math.min(100, ((dist - 0.5 * r.width) / R) * 100));
    const n1 = Math.max(n0 + 1, Math.min(100, ((dist + 0.5 * r.width) / R) * 100));
    el.style.backgroundImage = `radial-gradient(circle ${R.toFixed(0)}px at ${px.toFixed(0)}px ${py.toFixed(0)}px, rgb(${near}) ${n0.toFixed(1)}%, rgb(${far}) ${n1.toFixed(1)}%)`;
    const big = el.tagName === 'H1' ? 1 : 0.5;
    const ox = (dx / dist) * 1.7 * big;
    const oy = (dy / dist) * 1.7 * big;
    el.style.filter = `drop-shadow(${ox.toFixed(2)}px ${oy.toFixed(2)}px 0.7px rgba(${warm.map(Math.round)},${(0.8 * k).toFixed(2)})) drop-shadow(${(-ox * 1.5).toFixed(2)}px ${(3 - oy).toFixed(2)}px ${14 * big + 4}px rgba(0,0,0,0.34))`;
  }
}

function applyHour() {
  cur = sample(state.hour);
  if (forceMix >= 0) cur.w = [0, 1, 2].map((i) => (i === forceMix ? 1 : 0)); // ?mix=day|dusk|night: one photograph graded for every hour
  bod = bodies(state.hour);
  root.style.setProperty('--sky-top', rgb(cur.top));
  root.style.setProperty('--sky-bot', rgb(cur.bot));
  root.style.setProperty('--scrim-a', cur.scrim.toFixed(3));
  const hr = $('hour');
  if (hr) {
    hr.value = String(state.hour);
    hr.setAttribute('aria-valuetext', `${fmt(state.hour)}, ${cur.name}`);
  }
  const out = $('hourOut');
  if (out) out.textContent = `${fmt(state.hour)}${state.live ? '' : ' *'}`;
  const sunUp = bod.sun.elev > 0.02;
  $('gSun').hidden = !sunUp;
  $('gMoon').hidden = sunUp;
  $('now').hidden = state.live;
  computeLight();
  litSig = '';
  lightText();
  const a = cur.top.map((x) => Math.round(x * 0.22));
  root.style.setProperty('--scrim-rgb', a.join(','));
  state.dirty = true;
  if (stillMode) updateStill();
}

// ---------------------------------------------------------------- mode
let gl = null;
let stillMode = false;
const canvas = $('gl');

function updateStill() {
  // CSS still: the one photograph that dominates this hour, tinted by the same grade. One request, ~25 KB.
  let best = 0;
  for (let i = 1; i < 3; i++) if (cur.w[i] > cur.w[best]) best = i;
  const name = PHOTOS[best];
  if (state.stillName !== name) {
    state.stillName = name;
    const base = new URL(`img/${name}-phone`, import.meta.url).href;
    root.style.setProperty(
      '--still',
      `image-set(url("${base}.avif") type("image/avif"), url("${base}.webp") type("image/webp"))`,
    );
    $('still').classList.add('on');
  }
  // normalised so the strongest channel is untouched: night becomes blue, noon stays almost neutral
  const mx = Math.max(...cur.gain);
  const k = Math.min(1, Math.sqrt(cur.exp) * 1.1);
  const m = cur.gain.map((g) => (g / mx) * k);
  root.style.setProperty('--tint', rgb(m.map((x) => x * 255)));
  $('tint').classList.add('on');
}

// ---------------------------------------------------------------- shader
const VS = `#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.-1.,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uT0,uT1,uT2;
uniform vec3 uW;           // photograph weights (day,dusk,night), only loaded ones, summing to 1
uniform vec3 uD0,uD1,uD2;  // depth recipes
uniform vec2 uRes, uCover;
uniform float uZoom,uTime,uArrive,uDebug,uAspect;
uniform vec2 uLean;
uniform vec4 uWake[10];
uniform vec3 uGain,uLift,uSunCol;
uniform float uSat,uExp,uStars;
uniform vec4 uGlow,uHaze;
uniform vec3 uSun;         // x, y, strength
uniform vec4 uMoon;        // x, y, strength, phase
uniform vec4 uLight;       // x, y, strength, 1 if the moon
uniform vec3 uLightCol;
uniform vec3 uFx;          // rays and rim strength, text-region brightness ceiling, text-region grade strength
uniform vec4 uText;        // the words: centre and half-size in screen uv; the sun and moon dim behind them

float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*vn(p); p=p*2.03+7.1; a*=.5; } return s; }

float depthRaw(vec3 c, vec3 r){
  float mx=max(c.r,max(c.g,c.b)), mn=min(c.r,min(c.g,c.b));
  float sat=(mx-mn)/max(mx,1e-3);
  float lum=dot(c,vec3(.299,.587,.114));
  float d=r.z>0.?clamp((lum-r.x-sat*r.y)*r.z,0.,1.):clamp((c.r-c.b+r.x)*(-r.z),0.,1.);
  return d*d*(3.-2.*d);
}
vec2 toUV(vec2 s){ return ((s-.5)*uCover)/uZoom+.5; }
// how cloud-like the sky is at a point (0 clear, 1 dense), blurred by a mip level: used for rays and rims
float cloudAt(vec2 p, float lod){
  float c=0.;
  if(uW.x>.002) c+=uW.x*depthRaw(textureLod(uT0,p,lod).rgb,uD0);
  if(uW.y>.002) c+=uW.y*depthRaw(textureLod(uT1,p,lod).rgb,uD1);
  if(uW.z>.002) c+=uW.z*depthRaw(textureLod(uT2,p,lod).rgb,uD2);
  return c;
}

float depthOf(vec3 c, vec3 r){
  float mx=max(c.r,max(c.g,c.b)), mn=min(c.r,min(c.g,c.b));
  float sat=(mx-mn)/max(mx,1e-3);
  float lum=dot(c,vec3(.299,.587,.114));
  float d=r.z>0.?clamp((lum-r.x-sat*r.y)*r.z,0.,1.):clamp((c.r-c.b+r.x)*(-r.z),0.,1.);
  return mix(${FAR.toFixed(2)},${NEAR.toFixed(2)},d*d*(3.-2.*d));
}

void main(){
  vec2 s=vec2(gl_FragCoord.x/uRes.x, 1.-gl_FragCoord.y/uRes.y);     // screen uv, y down
  vec2 uv=((s-.5)*uCover+.5);                                        // cover fit
  uv=(uv-.5)/uZoom+.5;                                               // drawn at ~1.07x: lean never shows an edge
  float t=uTime;
  // slow noise drift (always on) and a slight sway
  vec2 dr=(vec2(vn(uv*2.2+vec2(t*.03,0.)),vn(uv*2.2+vec2(17.,t*.025)))-.5)*.032+vec2(sin(t*.13+uv.y*3.)*.004,sin(t*.09+uv.x*2.)*.002);
  vec2 lean=-uLean*vec2(.014,.009);
  // pointer wake: last ten samples, each already decayed on the CPU (no overshoot)
  vec2 wk=vec2(0.); float wa=0.;
  for(int i=0;i<10;i++){
    vec2 dd=(s-uWake[i].xy)*vec2(uAspect,1.);
    float g=exp(-dot(dd,dd)/(2.*.15*.15));
    wk+=uWake[i].zw*g; wa+=length(uWake[i].zw)*g;
  }
  float wl=length(wk); if(wl>1.35) wk*=1.35/wl;
  vec2 push=wk*.055;                                                 // peak push about 5.5% of the image
  float vf=mix(1.,.55,smoothstep(.5,1.,s.y));                        // far horizon moves less

  vec3 col=vec3(0.); float cloud=0.;
  for(int k=0;k<3;k++){
    float w = k==0?uW.x : (k==1?uW.y:uW.z);
    if(w<.002) continue;
    vec3 r = k==0?uD0 : (k==1?uD1:uD2);
    vec3 c0 = k==0?texture(uT0,uv).rgb : (k==1?texture(uT1,uv).rgb:texture(uT2,uv).rgb);
    float d=depthOf(c0,r)*vf;
    vec2 p=uv-((lean+dr)*d+push*d);
    vec3 c = k==0?texture(uT0,p).rgb : (k==1?texture(uT1,p).rgb:texture(uT2,p).rgb);
    col+=w*c; cloud+=w*clamp((d-${FAR.toFixed(2)})/${(NEAR - FAR).toFixed(2)},0.,1.);
  }
  if(uDebug>.5){ o=vec4(vec3(cloud),1.); return; }
  col+=vec3(.05,.05,.04)*clamp(wa,0.,1.)*cloud;                      // lit by the passing hand

  // grade: out = lift + gain * in, saturation about luma, exposure
  col*=uExp;
  float lum=dot(col,vec3(.299,.587,.114));
  col=mix(vec3(lum),col,uSat);
  col=uLift+uGain*col;
  float below=smoothstep(.45,1.,s.y);
  col=mix(col,uHaze.rgb,uHaze.a*below*.7);

  // ---- light: a horizon glow that travels with the body, then the sun and moon themselves
  float gx=mix(uMoon.x,uSun.x,step(.001,uSun.z));
  float g=exp(-pow((s.y-.82)/.2,2.))*exp(-pow((s.x-gx)/.55,2.));
  col+=uGlow.rgb*uGlow.a*g*(1.-.5*cloud);
  float tz=1.-smoothstep(.75,1.5,length((s-uText.xy)/uText.zw));  // 1 inside the words
  float aspect=uAspect;

  // light shafts: march from here toward the light through the cloud mask; rims: cloud edges that face it
  if(uLight.z>.01 && uFx.x>.001){
    vec2 toL=uLight.xy-s; float dL=length(toL*vec2(aspect,1.));
    float acc=0., ws=0., j=hash(gl_FragCoord.xy);
    for(int i=0;i<14;i++){
      float f=(float(i)+j)/14.; float wgt=1.-f*.55;
      acc+=(1.-cloudAt(toUV(s+toL*f*.94),2.5))*wgt; ws+=wgt;
    }
    float tr=acc/ws;                                       // 1: clear path to the light
    float fall=exp(-dL*1.7);
    float shaft=tr*tr*(1.-.75*cloud);
    col+=uLightCol*uLight.z*uFx.x*fall*shaft*.42;
  }

  // sun: a soft, grown-in-the-atmosphere glow with proper falloff and no disc edge; near cloud takes most of it
  vec2 ds=(s-uSun.xy)*vec2(aspect,1.); float dl=length(ds);
  float sz=1.+(uSun.y-.2)*1.4;                             // bigger and redder low down
  float tcore=1.-.92*smoothstep(.2,.8,cloud);
  float tbloom=1.-.5*smoothstep(.1,.9,cloud);
  float tw=1.-.72*tz;
  float core=1.5/(1.+pow(dl/(.0085*sz),2.6));
  float bloom=.5/(1.+pow(dl/(.05*sz),1.5));
  float halo=.07*exp(-dl*3.2/sz)+.02*exp(-dl*1.2);
  vec3 scol=mix(vec3(1.,.97,.9),uSunCol,smoothstep(.0,.09,dl));
  col+=scol*uSun.z*(core*tcore*tw+bloom*tbloom*(1.-.5*tz)+halo*tbloom);
  // 22-degree-ish ring of faint atmospheric scatter, only visible when the sun is clear
  col+=uSunCol*uSun.z*.025*exp(-pow((dl-.22*sz)/.03,2.))*tcore;

  // moon: real phase from the date, soft limb and terminator, earthshine, maria, bloom and a faint halo ring
  float ph=uMoon.w*6.2831853; float illum=(1.-cos(ph))*.5;
  vec2 pm=(s-uMoon.xy)*vec2(aspect,1.)/.034; float dm=length(pm);
  if(uMoon.z>.001){
    float ms=uMoon.z*(1.-.9*smoothstep(.15,.7,cloud))*(1.-.7*tz);
    vec3 n=vec3(pm.x,-pm.y,sqrt(max(1.-dot(pm,pm),0.)));
    vec3 L=vec3(sin(ph),0.,-cos(ph));
    float lit=smoothstep(-.22,.42,dot(n,L));
    float limb=smoothstep(1.03,.9,dm);
    float maria=.74+.26*fbm(pm*1.5+3.);
    vec3 surf=vec3(1.25,1.2,1.1)*maria*(.82+.18*n.z);
    vec3 earth=vec3(.045,.06,.1)*maria*(1.-illum*.7);
    vec3 mc=surf*lit+earth*(1.-lit);
    float bk=.25+.75*illum;
    col+=vec3(.5,.62,.95)*(.9/(1.+pow(dm/2.2,2.))+.14*exp(-dm*.22))*bk*ms;
    col=mix(col,mc,limb*ms);
    col+=vec3(.6,.7,1.)*.05*exp(-pow((dm-9.)/1.3,2.))*bk*ms;
  }

  // stars (a few more than the photograph has), sunk behind cloud, drifting very slightly
  if(uStars>.01){
    vec2 sp=(s+uLean*.002)*uRes/30.; vec2 id=floor(sp); vec2 f=fract(sp);
    float h=hash(id); vec2 jp=vec2(hash(id+3.1),hash(id+7.7))*.7+.15;
    float st=step(.985,h)*smoothstep(.16,.0,length(f-jp));
    st*=.5+.5*sin(t*(1.2+h*3.)+h*40.);
    col+=vec3(.9,.93,1.)*st*uStars*(1.-cloud)*smoothstep(.85,.4,s.y)*.8;
  }

  // behind the words: a broad, feathered, hue-preserving soft knee that only lowers the brightest sky and cloud
  vec2 rr=(s-uText.xy)/(uText.zw*vec2(1.5,2.4));
  float reg=exp(-dot(rr,rr)*2.0);
  float l2=dot(col,vec3(.299,.587,.114));
  float nl=l2-max(l2-uFx.y,0.)*reg*uFx.z;
  col*=nl/max(l2,1e-3)*(1.-.1*reg*uFx.z);

  // soft shoulder, then the arrival: a mist lifting off the dark ground
  col=mix(col,.8+.2*tanh((col-.8)/.2),step(.8,col));
  col=max(col,0.);
  float a=uArrive;
  float n=fbm(s*vec2(3.,2.2)+vec2(t*.05,-t*.02));
  float edge=s.y*.9+n*.45-.2;
  float rev=smoothstep(edge,edge+.35,a*1.9-.35);
  vec3 ground=vec3(.039,.047,.063);
  vec3 mist=mix(ground,mix(ground,uHaze.rgb*.55+uGlow.rgb*uGlow.a*.2,.55),.25+.6*n);
  col=mix(mist,col*mix(.55,1.,rev),rev);
  col+=(hash(gl_FragCoord.xy+fract(t)*91.)-.5)*(1.6/255.);          // dither against banding
  o=vec4(col,1.);
}`;

// ---------------------------------------------------------------- GL
const U = {};
const tex = [null, null, null];
const loaded = [false, false, false];
const loading = [false, false, false];
let program = null;

function initGL() {
  gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: manual,
  });
  if (!gl) return false;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  try {
    program = gl.createProgram();
    gl.attachShader(program, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link');
  } catch (e) {
    console.warn('sky: shader failed, using the still', e);
    return false;
  }
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  const names = [
    'uT0',
    'uT1',
    'uT2',
    'uW',
    'uD0',
    'uD1',
    'uD2',
    'uRes',
    'uCover',
    'uZoom',
    'uTime',
    'uArrive',
    'uDebug',
    'uAspect',
    'uLean',
    'uWake',
    'uGain',
    'uLift',
    'uSunCol',
    'uSat',
    'uExp',
    'uStars',
    'uGlow',
    'uHaze',
    'uSun',
    'uMoon',
    'uText',
    'uLight',
    'uLightCol',
    'uFx',
  ];
  for (const n of names) U[n] = gl.getUniformLocation(program, n);
  for (let i = 0; i < 3; i++) {
    tex[i] = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT],
      [gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT],
    ])
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    gl.uniform1i(U['uT' + i], i);
  }
  gl.uniform3fv(U.uD0, DEPTH[0]);
  gl.uniform3fv(U.uD1, DEPTH[1]);
  gl.uniform3fv(U.uD2, DEPTH[2]);
  gl.uniform1f(U.uZoom, 1.07);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    enterStill();
  });
  return true;
}

async function loadPhoto(i) {
  if (loaded[i] || loading[i]) return;
  loading[i] = true;
  for (const ext of [...state.fmt]) {
    try {
      const r = await fetch(new URL(`img/${PHOTOS[i]}-desk.${ext}`, import.meta.url));
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.blob();
      const bm = await createImageBitmap(b);
      state.bytes += b.size;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      state.imgAspect = bm.width / bm.height;
      bm.close?.();
      loaded[i] = true;
      state.dirty = true;
      break;
    } catch {
      if (ext === 'avif') state.fmt = ['webp']; // this browser cannot decode AVIF; do not try again
    }
  }
  loading[i] = false;
  if (!loaded[i] && !state.fmt.length) enterStill();
}

/** Ask for every photograph this hour's mix needs (and, when scrubbing, the neighbours). */
function want(all) {
  for (let i = 0; i < 3; i++) if ((all || cur.w[i] > 0.004) && !loaded[i]) loadPhoto(i);
}

// ---------------------------------------------------------------- loop
const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5) * (innerWidth < 900 ? 0.85 : 1);
const GOV = [1, 0.85, 0.72, 0.6];

function resize() {
  state.scale = dpr() * state.gov;
  const w = Math.max(2, Math.round(canvas.clientWidth * state.scale));
  const h = Math.max(2, Math.round(canvas.clientHeight * state.scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    state.dirty = true;
  }
}

function draw() {
  if (!gl || gl.isContextLost()) return;
  resize();
  want(false);
  const w = [0, 0, 0];
  for (let i = 0; i < 3; i++) if (loaded[i]) w[i] = cur.w[i];
  let sum = w[0] + w[1] + w[2];
  if (sum < 1e-4) {
    // nothing this hour needs is loaded yet: show whatever is, until it arrives
    for (let i = 0; i < 3; i++)
      if (loaded[i]) {
        w[i] = 1;
        break;
      }
    sum = w[0] + w[1] + w[2];
  }
  if (sum < 1e-4) return;
  for (let i = 0; i < 3; i++) w[i] /= sum;
  if (state.arrive0 === null) state.arrive0 = state.time;
  const ar = reduced ? 1 : Math.min(1, (state.time - state.arrive0) / 3.4);
  const arrive = 1 - Math.pow(1 - ar, 3);
  const aspect = canvas.width / canvas.height;
  const ia = state.imgAspect || 1.6;
  gl.uniform3fv(U.uW, w);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  gl.uniform2f(U.uCover, aspect > ia ? 1 : aspect / ia, aspect > ia ? ia / aspect : 1);
  gl.uniform1f(U.uAspect, aspect);
  gl.uniform1f(U.uTime, reduced ? 0 : state.time);
  gl.uniform1f(U.uArrive, arrive);
  gl.uniform1f(U.uDebug, debug === 'depth' ? 1 : 0);
  gl.uniform2f(U.uLean, state.lean[0], state.lean[1]);
  const wk = new Float32Array(40);
  const ss = state.samples;
  for (let i = 0; i < 10; i++) {
    const s = ss[ss.length - 1 - i];
    if (!s) continue;
    const age = state.time - s.t;
    // a quick rise, then a monotone settle over 1.4 s: it never swings past rest
    const att = Math.min(1, age / 0.12);
    const k = att * att * (3 - 2 * att) * (1 - sm01((age - 0.12) / 1.28));
    wk[i * 4] = s.x;
    wk[i * 4 + 1] = s.y;
    wk[i * 4 + 2] = s.dx * s.sp * k;
    wk[i * 4 + 3] = s.dy * s.sp * k;
  }
  gl.uniform4fv(U.uWake, wk);
  gl.uniform3fv(U.uGain, cur.gain);
  gl.uniform3fv(U.uLift, cur.lift);
  gl.uniform3fv(U.uSunCol, cur.sunCol);
  gl.uniform1f(U.uSat, cur.sat);
  gl.uniform1f(U.uExp, cur.exp);
  gl.uniform1f(U.uStars, cur.stars);
  gl.uniform4fv(U.uGlow, cur.glow);
  gl.uniform4fv(U.uHaze, cur.haze);
  gl.uniform3f(U.uSun, bod.sun.x, lit.sunY, lit.sunK);
  gl.uniform4f(U.uMoon, bod.moon.x, lit.moonY, lit.moonK, bod.phase);
  gl.uniform4f(U.uLight, lit.x, lit.y, lit.k, lit.moon);
  gl.uniform3fv(U.uLightCol, lit.col);
  // the words' brightness ceiling (display luma) and how hard it bites, from this hour's scrim value
  gl.uniform3f(U.uFx, raysOn ? 1 : 0, 0.26, Math.min(0.97, cur.scrim * 1.8));
  lightText();
  const hb = document.querySelector('.hero').getBoundingClientRect();
  gl.uniform4f(
    U.uText,
    (hb.x + hb.width / 2) / innerWidth,
    (hb.y + hb.height / 2) / innerHeight,
    hb.width / 2 / innerWidth,
    hb.height / 2 / innerHeight,
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (!canvas.classList.contains('on')) canvas.classList.add('on');
  state.dirty = false;
}
const sm01 = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};

const animating = () => !reduced && !state.paused && !stillMode;
let raf = 0;
const ft = []; // frame times for the governor
let govAt = 0;

function step(dt) {
  state.time += dt;
  const a = 1 - Math.exp(-dt / 0.4); // lean follows the pointer with a ~0.4 s smoothing
  state.lean[0] += (state.target[0] - state.lean[0]) * a;
  state.lean[1] += (state.target[1] - state.lean[1]) * a;
  while (state.samples.length && state.time - state.samples[0].t > 1.45) state.samples.shift();
}

function frame(now) {
  raf = 0;
  if (!animating()) return;
  if (state.last !== null) {
    const raw = (now - state.last) / 1000;
    const dt = Math.min(0.05, raw);
    step(dt);
    ft.push(raw);
    if (ft.length > 45) ft.shift();
    govern(now);
  }
  state.last = now;
  draw();
  dbgUpdate(now);
  schedule();
}

function govern(now) {
  if (ft.length < 45 || now - govAt < 2500 || state.arrive0 === null || state.time - state.arrive0 < 4) return;
  const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
  const i = GOV.indexOf(state.gov);
  if (avg > 0.026 && i < GOV.length - 1) {
    state.gov = GOV[i + 1];
    govAt = now;
    ft.length = 0;
    state.dirty = true;
  }
}

function schedule() {
  if (raf || manual) return;
  if (animating() && state.onscreen && !document.hidden) raf = requestAnimationFrame(frame);
}
function kick() {
  // draw once if something changed while not animating (dial, pause, resize), and restart the loop if due
  if (!gl || stillMode) return;
  if (!animating() || manual) draw();
  state.last = null;
  schedule();
}

// ---------------------------------------------------------------- pointer
let prev = null;
function onMove(e) {
  if (state.paused || (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
  const x = e.clientX / innerWidth;
  const y = e.clientY / innerHeight;
  state.target[0] = x * 2 - 1;
  state.target[1] = y * 2 - 1;
  if (prev) {
    const dtp = Math.max(1 / 120, state.time - prev.t);
    const px = (x - prev.x) * innerWidth;
    const py = (y - prev.y) * innerHeight;
    const dist = Math.hypot(px, py);
    if (dist > 3 && state.time - prev.t >= 0.03) {
      const speed = dist / innerHeight / dtp; // screen heights per second
      state.samples.push({
        x,
        y,
        t: state.time,
        dx: px / dist,
        dy: py / dist,
        sp: Math.pow(Math.min(1, speed / 1.2), 0.8),
      });
      if (state.samples.length > 10) state.samples.shift();
      prev = { x, y, t: state.time };
    }
  } else prev = { x, y, t: state.time };
}
function onLeave() {
  state.target[0] = 0;
  state.target[1] = 0;
  prev = null;
}

// ---------------------------------------------------------------- debug
const dbg = $('dbg');
let dbgAt = 0;
function dbgUpdate(now) {
  if (!debug || !dbg) return;
  if (now - dbgAt < 250) return;
  dbgAt = now;
  const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
  dbg.textContent = [
    `fps ${avg ? (1 / avg).toFixed(1) : '-'}   frame ${(avg * 1000).toFixed(1)} ms`,
    `canvas ${canvas.width}x${canvas.height}  scale ${state.scale.toFixed(2)} (gov ${state.gov})`,
    `hour ${fmt(state.hour)} ${cur.name}${state.live ? '' : ' (forced)'}  w ${cur.w.map((x) => x.toFixed(2)).join('/')}`,
    `photos ${loaded.map((l, i) => (l ? PHOTOS[i] : '-')).join(' ')}  ${(state.bytes / 1024).toFixed(1)} KB`,
    `motion ${reduced ? 'reduced' : state.paused ? 'paused' : 'on'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- boot
function enterStill() {
  stillMode = true;
  canvas.classList.remove('on');
  updateStill();
}

function wire() {
  const hr = $('hour');
  $('ui').hidden = false;
  hr.addEventListener('input', () => {
    state.live = false;
    state.hour = +hr.value;
    if (gl) want(true);
    applyHour();
    kick();
  });
  hr.addEventListener('pointerenter', () => gl && want(true), { once: true });
  hr.addEventListener('focus', () => gl && want(true), { once: true });
  $('now').addEventListener('click', () => {
    state.live = true;
    state.hour = localHour();
    applyHour();
    kick();
  });
  const pb = $('pause');
  if (reduced || stillMode) pb.hidden = true;
  pb.addEventListener('click', () => {
    state.paused = !state.paused;
    pb.setAttribute('aria-pressed', String(state.paused));
    pb.textContent = state.paused ? 'Play motion' : 'Pause motion';
    if (state.paused) {
      state.target[0] = state.target[1] = 0;
      state.samples.length = 0;
    }
    kick();
  });
  // live clock: advance the sky with the visitor's hour while it follows the clock
  setInterval(() => {
    if (!state.live) return;
    const h = localHour();
    if (Math.abs(h - state.hour) > 0.004 || h < state.hour) {
      state.hour = h;
      applyHour();
      if (gl && !animating()) draw();
    }
  }, 30000);
}

function boot() {
  const wantGL = q.get('gl') === '1' || !noHover;
  if (wantGL && !initGL()) gl = null;
  stillMode = !gl;
  if (gl) root.classList.add('gl');
  applyHour();
  wire();
  if (!gl) {
    updateStill();
    return;
  }
  resize();
  addEventListener('resize', () => {
    resize();
    kick();
  });
  if (!reduced) {
    addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', () => {
      state.last = null;
      schedule();
    });
    new IntersectionObserver((es) => {
      state.onscreen = es[es.length - 1].isIntersecting;
      state.last = null;
      schedule();
    }).observe(canvas);
  }
  if (debug) dbg.hidden = false;
  // first paint needs only this hour's photograph(s); the rest wait for the dial or the clock
  const first = cur.w.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]);
  const need = first.filter(([w]) => w > 0.004).map(([, i]) => i);
  Promise.all(need.map(loadPhoto)).then(() => {
    draw();
    dbgUpdate(1e9);
    schedule();
  });
}

window.__sky = {
  state,
  frame(dt) {
    step(dt);
    draw();
    dbgUpdate(1e9);
  },
  ready: () => loaded.some(Boolean),
  loadAll: () => Promise.all([0, 1, 2].map(loadPhoto)),
  setHour(h) {
    state.live = false;
    state.hour = h;
    applyHour();
    draw();
  },
  mode: () => (stillMode ? 'still' : 'webgl'),
};
boot();
