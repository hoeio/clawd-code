// Dev-only page: drive states, speech and amplitude by hand.
import { createClawd, STATES } from './character/clawd.ts';

const $ = (id: string) => document.getElementById(id)!;
const clawd = createClawd($('stage'));
(window as any).clawd = clawd;

for (const s of STATES) {
  const b = document.createElement('button');
  b.textContent = s;
  b.onclick = () => {
    clawd.setState(s);
    for (const o of $('states').children) o.setAttribute('aria-pressed', String(o === b));
  };
  $('states').append(b);
}
$('say').onclick = () => clawd.say(($('text') as HTMLInputElement).value);
$('amp').oninput = e => clawd.setAmplitude(Number((e.target as HTMLInputElement).value) / 100);
