// Clawd, built from boxes. Ported from reference/clawd-viewer.html (three r128 -> npm three).
import * as THREE from 'three';

// --- Look. Proportions approximate the official Clawd; adjust here. ---
export const ORANGE = 0xd9784f;
export const DARK = 0x2a1e18;
export const BODY = { w: 3.2, h: 1.8, d: 1.8 };
export const LEG = { w: 0.5, h: 0.7, d: 0.6, xs: [-1.15, -0.4, 0.4, 1.15] };
export const ARM = { w: 0.6, h: 0.7, d: 0.8, x: 1.85, y: 0.1 }; // y: center offset from body center
export const EYE = { w: 0.3, h: 0.55, d: 0.12, x: 0.75, y: 0.2 };
// Match the r128 prototype: no color management, and x PI since r155+ dropped legacy lighting.
const LIGHT = { hemi: 0.85 * Math.PI, key: 0.8 * Math.PI };

export const STATES = ['idle', 'working', 'thinking', 'waiting_approval', 'proud', 'worried', 'sleepy'] as const;
export type ClawdState = (typeof STATES)[number];

export interface ClawdApi {
  /** 0..1 talking amplitude. Rises fast, decays slowly. A future TTS feeds audio volume here. */
  setAmplitude(v: number): void;
  setState(state: ClawdState): void;
  /**
   * Show text in the bubble. With `seconds` (the voice's length), typing keeps pace with the voice.
   * `full`: the whole line when this is only its first phrase; the bubble is sized for it up front.
   */
  say(text: string, seconds?: number, full?: string): void;
  /** Add the next phrase of the same line to the bubble (same pacing rules as say). */
  append(text: string, seconds?: number): void;
  dispose(): void;
}

// Pose deltas from neutral. Each state contributes a weighted pose; weights blend over time.
interface Pose { y: number; sy: number; rz: number; aLz: number; aRz: number; aLx: number; aRx: number; eyeY: number; eyeS: number }
const ZERO: Pose = { y: 0, sy: 0, rz: 0, aLz: 0, aRz: 0, aLx: 0, aRx: 0, eyeY: 0, eyeS: 0 };
const S = Math.sin;
// Arms pivot at the shoulder: -z raises the left arm outward, +z the right; -x swings forward.
const MOTIONS: Record<ClawdState, (t: number, m: number) => Partial<Pose>> = {
  idle: t => ({ sy: S(t * 1.8) * 0.025, aLz: S(t * 1.8) * 0.04, aRz: -S(t * 1.8) * 0.04 }),
  working: (t, m) => ({
    sy: S(t * 2.4) * 0.02, y: Math.abs(S(t * 9)) * 0.04 * m, eyeY: -0.05,
    aLx: -0.9 + Math.max(0, S(t * 18)) * 0.35 * m, aRx: -0.9 + Math.max(0, S(t * 18 + Math.PI)) * 0.35 * m,
  }),
  thinking: (t, m) => ({ sy: S(t * 1.4) * 0.025, rz: S(t * 1.1) * 0.07 * m, eyeY: 0.1, aRz: 0.5, aRx: -0.6 }),
  waiting_approval: (t, m) => {
    const hop = Math.max(0, S(t * 4.5));
    return { y: hop * hop * 0.3 * m, sy: -hop * 0.03, aLz: -0.1, aRz: 2.5 + S(t * 11) * 0.35 * m };
  },
  proud: (t, m) => ({ y: Math.abs(S(t * 5.5)) * 0.22 * m, sy: 0.03, aLz: -2.6 + S(t * 11) * 0.12 * m, aRz: 2.6 - S(t * 11) * 0.12 * m }),
  worried: (t, m) => ({ sy: -0.09 + S(t * 2.6) * 0.012, eyeY: -0.12, aLz: 0.18, aRz: -0.18, rz: S(t * 2.2) * 0.012 * m }),
  sleepy: t => ({ sy: S(t * 0.9) * 0.045, eyeS: -0.6, eyeY: -0.06, rz: 0.05 + S(t * 0.45) * 0.02, aLz: 0.08, aRz: -0.08 }),
};

export function createClawd(container: HTMLElement): ClawdApi {
  THREE.ColorManagement.enabled = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 2.3, 10);
  camera.lookAt(0, 2.0, 0); // character sits low, leaving room for the bubble

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.insertBefore(renderer.domElement, container.firstChild);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, LIGHT.hemi));
  const key = new THREE.DirectionalLight(0xffffff, LIGHT.key);
  key.position.set(4, 7, 6);
  scene.add(key);

  const mat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: true });
  const bodyMat = mat(ORANGE), eyeMat = mat(DARK);
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // root: drag rotation. rig: breathing/bouncing (origin on the floor, so squash keeps feet planted).
  const root = new THREE.Group();
  scene.add(root);
  const rig = new THREE.Group();
  root.add(rig);

  const bodyY = LEG.h + BODY.h / 2;
  box(BODY.w, BODY.h, BODY.d, bodyMat, 0, bodyY, 0, rig);
  const shoulderY = bodyY + ARM.y + ARM.h / 2;
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-ARM.x, shoulderY, 0);
  armR.position.set(ARM.x, shoulderY, 0);
  box(ARM.w, ARM.h, ARM.d, bodyMat, 0, -ARM.h / 2, 0, armL);
  box(ARM.w, ARM.h, ARM.d, bodyMat, 0, -ARM.h / 2, 0, armR);
  rig.add(armL, armR);
  const eyeBaseY = bodyY + EYE.y;
  const eyeZ = BODY.d / 2 + 0.03;
  const eyeL = box(EYE.w, EYE.h, EYE.d, eyeMat, -EYE.x, eyeBaseY, eyeZ, rig);
  const eyeR = box(EYE.w, EYE.h, EYE.d, eyeMat, EYE.x, eyeBaseY, eyeZ, rig);
  for (const x of LEG.xs) box(LEG.w, LEG.h, LEG.d, bodyMat, x, LEG.h / 2, 0, rig);

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  scene.add(shadow);

  // --- Speech bubble (HTML overlay, follows the head) ---
  const bubble = document.createElement('div');
  bubble.className = 'clawd-bubble';
  bubble.setAttribute('aria-hidden', 'true'); // typed char by char; screen readers get the live region
  const live = document.createElement('div');
  live.className = 'clawd-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const typed = document.createTextNode(''), untyped = document.createElement('span');
  untyped.style.visibility = 'hidden'; // reserves the full text's size so the bubble never reflows while typing
  bubble.append(typed, untyped);
  container.append(bubble, live);
  const headTop = new THREE.Vector3();

  // --- Drag to rotate; a tap without dragging is a poke ---
  let rotY = -0.45, rotX = 0, velY = 0, dragging = false, lastX = 0, lastY = 0, autoIdle = true;
  let downX = 0, downY = 0, downAt = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY; downAt = performance.now();
    container.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) autoIdle = false;
    rotY += dx * 0.012; velY = dx * 0.012;
    rotX = Math.max(-0.5, Math.min(0.5, rotX + dy * 0.008));
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) <= 5 && performance.now() - downAt < 400) pokeAt = timer.getElapsed();
    dragging = false;
  };
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', () => { dragging = false; });

  // --- Gaze: eyes (and a little of the body) follow the cursor anywhere on the page ---
  let gazeX = 0, gazeY = 0, lookedAt = -Infinity;
  const onLook = (e: PointerEvent) => {
    const r = container.getBoundingClientRect();
    gazeX = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    gazeY = Math.max(-1, Math.min(1, -(e.clientY - (r.top + r.height * 0.45)) / (r.height / 2)));
    lookedAt = timer.getElapsed();
  };
  window.addEventListener('pointermove', onLook);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = 10 * Math.max(1, 0.9 / camera.aspect); // narrow window: back off so Clawd fits the width
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const m = reduceMotion ? 0.3 : 1;

  let ampTarget = 0, amp = 0;
  let target: ClawdState = 'idle';
  const weights: Record<ClawdState, number> = { idle: 1, working: 0, thinking: 0, waiting_approval: 0, proud: 0, worried: 0, sleepy: 0 };
  let blinkAt = 2.5, blinkT = -1;
  // Eyes: smoothed gaze; when nobody moves the cursor, they wander on their own.
  let gx = 0, gy = 0, wanderX = 0, wanderY = 0, nextWander = 0;
  // Fidgets: small unprompted movements while idle, so Clawd never looks like a loop.
  type Fidget = 'look' | 'stretch' | 'hop' | 'wiggle' | 'yawn';
  let fidget: { kind: Fidget; start: number; dur: number; side: number } | null = null, nextFidget = 6;
  let pokeAt = -Infinity;
  // Typing state for say()
  // step: seconds per character. voiced: the real voice drives the amplitude, not the simulation.
  // full: what the bubble is sized for (the whole line), so later phrases never make it grow.
  let typing: { text: string; full: string; shown: number; next: number; hideAt: number; step: number; voiced: boolean } | null = null;
  const rest = () => {
    const done = typing!.text.slice(0, typing!.shown);
    return typing!.full.startsWith(done) ? typing!.full.slice(done.length) : typing!.text.slice(typing!.shown);
  };
  let simNext = 0;

  const timer = new THREE.Timer();
  let raf = 0;
  function frame(now?: number) {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();

    // Bubble typing drives a simulated talking amplitude.
    if (typing) {
      if (typing.shown < typing.text.length && t >= typing.next) {
        typing.shown = reduceMotion ? typing.text.length : typing.shown + 1;
        typed.textContent = typing.text.slice(0, typing.shown);
        untyped.textContent = rest();
        typing.next = t + typing.step;
        if (typing.shown === typing.text.length) typing.hideAt = t + Math.min(9, 2.5 + typing.text.length * 0.05);
      }
      if (!typing.voiced && typing.shown < typing.text.length && t > simNext) {
        ampTarget = 0.25 + Math.random() * 0.75;
        simNext = t + 0.09 + Math.random() * 0.14;
      }
      if (typing.hideAt && t > typing.hideAt) { bubble.classList.remove('show'); typing = null; }
    }

    const k = ampTarget > amp ? 14 : 6;
    amp += (ampTarget - amp) * Math.min(1, k * dt);
    ampTarget *= Math.pow(0.02, dt);

    // Blend state poses.
    const pose: Pose = { ...ZERO };
    for (const s of STATES) {
      weights[s] += ((s === target ? 1 : 0) - weights[s]) * Math.min(1, 5 * dt);
      if (weights[s] < 0.001) continue;
      const p = MOTIONS[s](t, m);
      for (const key in p) pose[key as keyof Pose] += (p[key as keyof Pose] ?? 0) * weights[s];
    }

    // Fidgets: only when calm and quiet.
    const calm = (target === 'idle' || target === 'sleepy' || target === 'thinking') && amp < 0.05 && !typing;
    if (!fidget && calm && t > nextFidget && !reduceMotion) {
      const pool: Fidget[] = target === 'sleepy' ? ['yawn', 'look'] : target === 'thinking' ? ['look', 'look', 'wiggle'] : ['look', 'look', 'stretch', 'hop', 'wiggle'];
      const kind = pool[Math.floor(Math.random() * pool.length)];
      fidget = { kind, start: t, dur: { look: 1.6, stretch: 1.4, hop: 0.45, wiggle: 0.9, yawn: 2.2 }[kind], side: Math.random() < 0.5 ? -1 : 1 };
    }
    let lookX: number | null = null;
    if (fidget) {
      const p = (t - fidget.start) / fidget.dur;
      const e = Math.sin(Math.PI * Math.min(1, p)); // 0 -> 1 -> 0
      switch (fidget.kind) {
        case 'look': lookX = fidget.side * 0.9; break;
        case 'stretch': pose.aLz -= 2.3 * e; pose.aRz += 2.3 * e; pose.sy += 0.07 * e; pose.eyeS -= 0.5 * e; break;
        case 'hop': pose.y += 0.28 * e; pose.sy -= 0.04 * e; break;
        case 'wiggle': pose.rz += Math.sin(p * Math.PI * 6) * 0.06 * e; break;
        case 'yawn': pose.aLz -= 1.1 * e; pose.aRz += 1.1 * e; pose.sy += 0.06 * e; pose.eyeS -= 0.55 * e; break;
      }
      if (p >= 1) { fidget = null; nextFidget = t + 6 + Math.random() * 12; }
    }

    // Poke: a startled little hop with happy squinting eyes.
    const pk = (t - pokeAt) / 0.6;
    if (pk >= 0 && pk < 1) {
      const e = Math.sin(Math.PI * pk);
      pose.y += 0.35 * e * m; pose.sy -= 0.08 * Math.sin(Math.PI * Math.min(1, pk * 3)) * m;
      pose.eyeS -= 0.7 * e; pose.aLz -= 0.8 * e; pose.aRz += 0.8 * e;
    }

    // Gaze target: the cursor if it moved recently, else a fidget glance, else wandering.
    let tx = gazeX, ty = gazeY;
    if (t - lookedAt > 4) {
      if (t > nextWander) { wanderX = (Math.random() * 2 - 1) * 0.7; wanderY = Math.random() * 0.6 - 0.25; nextWander = t + 1.5 + Math.random() * 3.5; }
      tx = lookX ?? wanderX; ty = lookX !== null ? 0 : wanderY;
    }
    if (target === 'working') { tx *= 0.3; ty = -0.5; } // eyes on the "keyboard"
    gx += (tx - gx) * Math.min(1, 10 * dt); // quick, like a saccade
    gy += (ty - gy) * Math.min(1, 10 * dt);

    const talkBob = Math.abs(Math.sin(t * 20)) * amp * 0.16 * m;
    rig.position.y = pose.y + talkBob;
    const sxz = 1 + amp * 0.025 * m;
    rig.scale.set(sxz, 1 + pose.sy - amp * 0.03 * m, sxz);
    rig.rotation.z = pose.rz + Math.sin(t * 11) * amp * 0.035 * m;
    rig.rotation.y = gx * 0.18 * m; // the body turns a little toward what it looks at
    armL.rotation.set(pose.aLx, 0, pose.aLz + amp * 0.35 * m * Math.sin(t * 14));
    armR.rotation.set(pose.aRx, 0, pose.aRz - amp * 0.35 * m * Math.sin(t * 14 + 1.2));

    let blink = 1;
    if (blinkT < 0 && t > blinkAt) blinkT = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      blink = blinkT < 0.07 ? 1 - blinkT / 0.07 : blinkT < 0.14 ? (blinkT - 0.07) / 0.07 : 1;
      // Sometimes a quick double blink.
      if (blinkT >= 0.14) { blinkT = -1; blinkAt = t + (Math.random() < 0.2 ? 0.12 : 2 + Math.random() * 3.5); }
    }
    for (const [eye, side] of [[eyeL, -1], [eyeR, 1]] as const) {
      eye.position.x = side * EYE.x + gx * 0.13;
      eye.position.y = eyeBaseY + pose.eyeY + gy * 0.09;
      eye.scale.y = Math.max(0.08, (1 + pose.eyeS) * blink);
    }

    if (!dragging) {
      if (autoIdle) rotY += Math.sin(t * 0.5) * 0.002;
      else { rotY += velY; velY *= 0.92; }
    }
    root.rotation.set(rotX, rotY, 0);
    shadow.scale.setScalar(1 - talkBob * 0.5);

    renderer.render(scene, camera);
    if (bubble.classList.contains('show')) placeBubble();
    raf = requestAnimationFrame(frame);
  }

  function placeBubble() {
    // A fixed point above the head at rest: the bubble must not ride the talking bounce.
    headTop.set(0, LEG.h + BODY.h + 0.35, 0).project(camera);
    const w = container.clientWidth, h = container.clientHeight;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const x = Math.min(w - bw / 2 - 8, Math.max(bw / 2 + 8, (headTop.x * 0.5 + 0.5) * w));
    const y = Math.max(bh + 8, (-headTop.y * 0.5 + 0.5) * h);
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
  }

  // Voiced: finish typing a little before the voice ends, so the last words appear as they're heard.
  const paceFor = (text: string, seconds?: number) => (seconds ? Math.min(0.12, Math.max(0.02, (seconds * 0.9) / text.length)) : 0.045);
  function say(text: string, seconds?: number, full?: string) {
    text = text.trim();
    if (!text) return;
    typing = { text, full: full?.startsWith(text) ? full : text, shown: 0, next: 0, hideAt: 0, step: paceFor(text, seconds), voiced: !!seconds };
    typed.textContent = '';
    untyped.textContent = typing.full;
    bubble.classList.add('show');
    live.textContent = text;
  }

  frame();

  return {
    setAmplitude(v) { ampTarget = Math.max(0, Math.min(1, v)); },
    setState(s) { if (STATES.includes(s)) target = s; },
    say,
    append(text, seconds) {
      text = text.trim();
      if (!text) return;
      if (!typing) return say(text, seconds);
      typing.text += ' ' + text;
      typing.step = paceFor(text, seconds);
      typing.voiced = !!seconds;
      typing.hideAt = 0;
      if (!typing.full.startsWith(typing.text)) typing.full = typing.text; // not what was reserved: fall back
      untyped.textContent = rest();
      live.textContent = typing.text;
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onLook);
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
      bubble.remove();
      live.remove();
    },
  };
}
