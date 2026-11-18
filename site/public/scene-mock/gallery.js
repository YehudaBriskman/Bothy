// The S6 sky-scene gallery. One real photograph per scene, the SAME fragment shader as the approved sky
// (public/sky-spike/sky.js: the block between the two "shader" markers below is that file's VS and FS, copied
// byte for byte and held identical by src/scene/scene.test.ts), the same hour table, the same pointer wake and lean.
// What differs from the spike is only plumbing: one photograph in the first texture slot, no hero text, no arrival
// mist, a picker, and per-scene settings from scenes.js. Raw WebGL2, no dependencies, no other origin.
import { sample, bodies, fmt, wrapHour } from '../sky-spike/sky-keys.js';
import { SCENES } from './scenes.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = q.get('debug');
const manual = q.get('manual') === '1'; // test harness: no rAF loop; window.__g.frame(dt) steps and draws
const NEAR = 1.0;
const FAR = 0.22; // near moves ~4.5x more than far

// ---------------------------------------------------------------- shader (verbatim from public/sky-spike/sky.js)
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

// ---------------------------------------------------------------- end shader

const state = {
  scene: 0,
  hour: 12,
  live: false,
  paused: false,
  time: 0,
  lean: [0, 0],
  target: [0, 0],
  samples: [],
  last: null,
  scale: 1,
  gov: 1,
  dirty: true,
  onscreen: true,
  imgAspect: 1.6,
  loadedScene: -1,
};
const canvas = $('gl');
const stage = $('stage');
let gl = null;
let program = null;
const U = {};
const tex = [null, null, null];
let cur = sample(12);
let bod = bodies(12);
const lit = { sunY: 0.5, moonY: 0.5, sunK: 0, moonK: 0, x: 0.5, y: 0.2, k: 0, col: [1, 1, 1], moon: 0 };
const sm01 = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};
const rgb = (a) => `rgb(${a.map((x) => Math.round(Math.min(255, Math.max(0, x)))).join(',')})`;

function computeLight() {
  const sc = SCENES[state.scene];
  const horizon = 0.8;
  const sunY = horizon - Math.max(bod.sun.elev, -0.15) * 0.64;
  const sunK = Math.min(1, Math.max(0, (bod.sun.elev + 0.04) / 0.1)) * sc.sun;
  const moonY = horizon - Math.max(bod.moon.elev, -0.15) * 0.62;
  const phase = sc.moon ?? bod.phase;
  const illum = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  const moonK = Math.min(1, Math.max(0, (bod.moon.elev + 0.02) / 0.12)) * cur.moonK;
  Object.assign(lit, { sunY, moonY, sunK, moonK, phase });
  const moonS = moonK * (0.35 + 0.65 * illum);
  if (sunK >= moonS) Object.assign(lit, { x: bod.sun.x, y: sunY, k: sunK, moon: 0, col: cur.sunCol });
  else Object.assign(lit, { x: bod.moon.x, y: moonY, k: moonS, moon: 1, col: [0.72, 0.82, 1] });
}

function applyHour() {
  cur = sample(state.hour);
  bod = bodies(state.hour);
  computeLight();
  stage.style.setProperty('--sky-top', rgb(cur.top));
  stage.style.setProperty('--sky-bot', rgb(cur.bot));
  $('hour').value = String(state.hour);
  $('hourOut').textContent = `${fmt(state.hour)} ${cur.name}`;
  placeHalo();
  state.dirty = true;
}

// A faint ring of scatter round the sun, a light effect on the real cirrus (not a drawn cloud). Only when the scene asks.
function placeHalo() {
  const sc = SCENES[state.scene];
  const h = $('halo');
  const on = sc.halo && lit.sunK > 0.05;
  h.hidden = !on;
  if (!on) return;
  const r = Math.round(0.22 * innerHeight * (1 + (lit.sunY - 0.2) * 1.4) * 1.5);
  h.style.setProperty('--hx', `${(bod.sun.x * 100).toFixed(1)}%`);
  h.style.setProperty('--hy', `${(lit.sunY * 100).toFixed(1)}%`);
  h.style.setProperty('--hr', `${r}px`);
  h.style.setProperty('--ha', (0.2 * lit.sunK).toFixed(3));
}

// ---------------------------------------------------------------- GL
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
    console.warn('scene: shader failed, using the still', e);
    return false;
  }
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  const names = `uT0 uT1 uT2 uW uD0 uD1 uD2 uRes uCover uZoom uTime uArrive uDebug uAspect uLean uWake uGain uLift uSunCol uSat uExp uStars uGlow uHaze uSun uMoon uText uLight uLightCol uFx`;
  for (const n of names.split(' ')) U[n] = gl.getUniformLocation(program, n);
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
  gl.uniform3f(U.uD1, 0, 0, 0);
  gl.uniform3f(U.uD2, 0, 0, 0);
  gl.uniform1f(U.uZoom, 1.07);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    enterStill();
  });
  return true;
}

const bitmaps = new Map();
async function loadScene(i) {
  const sc = SCENES[i];
  let bm = bitmaps.get(sc.photo);
  if (!bm) {
    const r = await fetch(new URL(sc.photo, import.meta.url));
    if (!r.ok) throw new Error(String(r.status));
    bm = await createImageBitmap(await r.blob());
    bitmaps.set(sc.photo, bm);
  }
  return bm;
}

async function showScene(i, hour) {
  state.scene = i;
  const sc = SCENES[i];
  for (const b of document.querySelectorAll('.picker button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.i === i));
  }
  $('title').textContent = `${i + 1}. ${sc.title}`;
  $('line').textContent = sc.line;
  document.title = `BothyBox sky scenes: ${sc.title}`;
  const u = new URL(location.href);
  u.searchParams.set('scene', String(i + 1));
  history.replaceState(null, '', u);
  state.hour = hour ?? state.hour;
  let bm;
  try {
    bm = await loadScene(i);
  } catch (e) {
    console.warn('scene: photograph failed', e);
    return;
  }
  if (state.scene !== i) return; // the visitor moved on while it loaded
  if (gl) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
    gl.uniform3fv(U.uD0, sc.depth);
    state.imgAspect = bm.width / bm.height;
  } else {
    stage.style.backgroundImage = `url(${new URL(sc.photo, import.meta.url).href})`;
  }
  state.loadedScene = i;
  applyHour();
  kick();
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
  if (!gl || gl.isContextLost() || state.loadedScene < 0) return;
  resize();
  const aspect = canvas.width / canvas.height;
  const ia = state.imgAspect || 1.6;
  gl.uniform3f(U.uW, 1, 0, 0);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  gl.uniform2f(U.uCover, aspect > ia ? 1 : aspect / ia, aspect > ia ? ia / aspect : 1);
  gl.uniform1f(U.uAspect, aspect);
  gl.uniform1f(U.uTime, reduced ? 0 : state.time);
  gl.uniform1f(U.uArrive, 1);
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
  gl.uniform4f(U.uMoon, bod.moon.x, lit.moonY, lit.moonK, lit.phase);
  gl.uniform4f(U.uLight, lit.x, lit.y, lit.k, lit.moon);
  gl.uniform3fv(U.uLightCol, lit.col);
  gl.uniform3f(U.uFx, 0, 0.26, 0); // no light shafts (as in the approved sky), no text region
  gl.uniform4f(U.uText, -9, -9, 0.01, 0.01);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  canvas.classList.add('on');
  state.dirty = false;
}

let stillMode = false;
const animating = () => !reduced && !state.paused && !stillMode;
let raf = 0;
const ft = [];
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
    step(Math.min(0.05, raw));
    ft.push(raw);
    if (ft.length > 45) ft.shift();
    govern(now);
  }
  state.last = now;
  draw();
  schedule();
}

function govern(now) {
  if (ft.length < 45 || now - govAt < 2500) return;
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
  if (!gl || stillMode) return;
  if (!animating() || manual) draw();
  state.last = null;
  schedule();
}

// ---------------------------------------------------------------- pointer (as in the approved sky)
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

// ---------------------------------------------------------------- boot
function enterStill() {
  stillMode = true;
  canvas.classList.remove('on');
  const sc = SCENES[state.scene];
  stage.style.backgroundImage = `url(${new URL(sc.photo, import.meta.url).href})`;
}

function pick(i) {
  const n = (i + SCENES.length) % SCENES.length;
  const sc = SCENES[n];
  showScene(n, q.has('hour') ? state.hour : sc.home);
}

function boot() {
  const picker = $('picker');
  SCENES.forEach((sc, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = String(i);
    b.textContent = String(i + 1);
    b.title = sc.title;
    b.setAttribute('aria-label', `${i + 1}: ${sc.title}`);
    b.addEventListener('click', () => pick(i));
    picker.append(b);
  });
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-8]$/.test(e.key)) pick(+e.key - 1);
    else if (e.key === 'ArrowRight') pick(state.scene + 1);
    else if (e.key === 'ArrowLeft') pick(state.scene - 1);
  });
  $('hour').addEventListener('input', (e) => {
    state.hour = +e.target.value;
    applyHour();
    kick();
  });
  $('pause').addEventListener('click', (e) => {
    state.paused = !state.paused;
    e.currentTarget.setAttribute('aria-pressed', String(state.paused));
    e.currentTarget.textContent = state.paused ? 'Play motion' : 'Pause motion';
    if (state.paused) {
      state.target[0] = state.target[1] = 0;
      state.samples.length = 0;
    }
    kick();
  });
  if (reduced) $('pause').hidden = true;
  if (!initGL()) gl = null;
  stillMode = !gl;
  const want = parseInt(q.get('scene') ?? '1', 10);
  const first = Number.isFinite(want) ? Math.min(SCENES.length, Math.max(1, want)) - 1 : 0;
  const h = parseFloat(q.get('hour') ?? '');
  const hour = Number.isFinite(h) ? wrapHour(h) : SCENES[first].home;
  if (gl) {
    resize();
    addEventListener('resize', () => {
      resize();
      placeHalo();
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
    }
  }
  showScene(first, hour);
}
boot();

window.__g = {
  frame(dt) {
    step(dt);
    draw();
  },
  set(i, h) {
    return showScene(i, h);
  },
  ready: () => state.loadedScene === state.scene && state.loadedScene >= 0,
  mode: () => (gl ? 'gl' : 'still'),
};
