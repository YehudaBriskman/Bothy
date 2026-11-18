// The sky's shader: raw WebGL2, ported unchanged from public/sky-spike/sky.js (owner-approved look). Three real
// photographs are cross-faded and graded by the hour table; depth is derived from each photograph's own colour.
// FAR and NEAR are the depth range that makes cloud move about 4.5x more than open sky.
export const NEAR = 1.0;
export const FAR = 0.22;
// Per photograph depth recipe: depth = clamp((luma - bias - sat * satW) * gain). Tuned by eye with ?debug=depth.
export const DEPTH: readonly [number[], number[], number[]] = [
  [0.34, 1.15, 3.2], // day: white cumulus vs saturated blue
  [0.04, 0, -10], // dusk: warm-grey cloud (r >= b) vs blue sky (b > r); negative gain selects the hue recipe
  [0.45, 0.3, 3.0], // night: only the stars count
];

export const VS = `#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.-1.,0.,1.); }`;

export const FS = `#version 300 es
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
uniform vec4 uCam;         // the descent: pan (uv down), zoom multiplier, cloud crossing, cloud rise (the last two scaled by depth)
uniform float uSea;        // sea of cloud: 0 none .. 1 fills the lower screen
uniform vec3 uSeaCol;      // its colour, from the hour's own grade

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
  uv=(uv-.5)/(uZoom*uCam.y)+.5+vec2(0.,uCam.x);                      // drawn at ~1.07x: lean never shows an edge; the descent pans and zooms
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
    vec2 p=uv-((lean+dr)*d+push*d)+vec2(uCam.z,uCam.w)*d;
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

  // the sea of cloud: a soft, billowing surface that climbs the screen as the camera drops into it (no hard edge)
  if(uSea>.002){
    float sn=fbm(vec2(s.x*2.6+t*.015+uCam.z*3.,s.y*5.5-uCam.x*3.))+.3*fbm(vec2(s.x*7.,s.y*14.)+3.);
    float top=1.-uSea*.6;
    float m=smoothstep(top-.04,top+.34,s.y+(sn-.5)*.24);
    col=mix(col,uSeaCol*(.84+.26*sn),m*.93*uSea);
  }

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
