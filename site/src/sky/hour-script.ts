import { KEYS } from './keys.ts';

/**
 * The home page's second inline head script: it names the visitor's hour on <html> (`data-hour`, the hour classes of
 * styles/sky-still.css) before the first paint, so the still starts as the right photograph and the right floor colour
 * instead of the noon one followed by a swap, and it starts that photograph downloading at once (a preload) instead of
 * after the 175 KB stylesheet has been parsed. `?hour=N` is honoured, as in the engine. Tiny, no dependencies, and it
 * never throws into the page.
 */
export function hourScript(): string {
  const keys = JSON.stringify(KEYS.map((k) => [k.h, k.n]));
  return (
    `(function(){try{history.scrollRestoration='manual';var d=document.documentElement,q=/[?&]hour=([0-9.]+)/.exec(location.search),t=new Date(),` +
    `h=q?+q[1]:t.getHours()+t.getMinutes()/60,K=${keys},n=K[0][1],i;h=((h%24)+24)%24;` +
    `for(i=0;i<K.length;i++)if(h>=K[i][0])n=K[i][1];d.setAttribute('data-hour',n);` +
    `var p=/^(dawn|golden|sunset)$/.test(n)?'dusk':'day',` +
    `s=[['(min-width:720px)','desk'],['(max-width:719.98px)','phone']];` +
    `s.forEach(function(m){var l=document.createElement('link');l.rel='preload';l.as='image';` +
    `l.type='image/avif';l.media=m[0];l.href='/sky/'+p+'-'+m[1]+'.avif';document.head.appendChild(l)})}catch(e){}})()`
  );
}
