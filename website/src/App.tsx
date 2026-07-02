import { javascript } from '@codemirror/lang-javascript';
import CodeMirror from '@uiw/react-codemirror';
import { type CompileStats, createCompiler, type Compiler } from 'compilecat/wasm';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { bundle } from './bundle';

const PREDATOR_PREY_SOURCE = `const W = self.innerWidth;
const H = self.innerHeight;
const N = 500;
const N_PREDATOR = 2;
const N_WHALE = 1;
const N_ROCK = 4;
const N_REEF = 2;
const N_PELLET = 30;
const N_MOTE = 60;
const N_CURRENT = 3;

const FISH_MAX_V = 1.6;
const PREDATOR_MAX_V = 1.1;
const WHALE_MAX_V = 0.4;

// Shape hierarchy — compilecat reads these types to drive optimization
// (type-directed inlining/SROA) while keeping the source fully typed.
type Point = {
  x: number;
  y: number;
};
type Body = Point & {
  fx: number;
  fy: number;
};
type Mover = Body & {
  px: number;
  py: number;
  vx: number;
  vy: number;
};

type Fish = Mover & {
  energy: number;
};
type Predator = Mover & {
  hunger: number;
  targetIdx: number;
};
type Whale = Mover & {
  mass: number;
  age: number;
};
type Rock = Point & {
  radius: number;
};
type Reef = Point & {
  w: number;
  h: number;
};
type Pellet = Point & {
  value: number;
};
type Mote = Point & {
  drift: number;
  age: number;
};
type Current = Point & {
  strength: number;
  radius: number;
};

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function addForce(target: Body, dx: number, dy: number, k: number): void {
  target.fx += dx * k;
  target.fy += dy * k;
}

function pushAway(a: Body, b: Point, k: number): void {
  a.fx += (a.x - b.x) * k;
  a.fy += (a.y - b.y) * k;
}

function pushToward(a: Body, b: Point, k: number): void {
  a.fx += (b.x - a.x) * k;
  a.fy += (b.y - a.y) * k;
}

function zeroForces(entity: Body): void {
  entity.fx = 0;
  entity.fy = 0;
}

function limitV(entity: Mover, vmax: number): void {
  const v2 = entity.vx * entity.vx + entity.vy * entity.vy;
  if (v2 > vmax * vmax) {
    const scale = vmax / Math.sqrt(v2);
    entity.vx *= scale;
    entity.vy *= scale;
  }
}

function wrapPos(entity: Point): void {
  if (entity.x < 0) entity.x += W;
  else if (entity.x > W) entity.x -= W;
  if (entity.y < 0) entity.y += H;
  else if (entity.y > H) entity.y -= H;
}

function integrate(entity: Mover, vmax: number): void {
  // snapshot prev for render lerp
  entity.px = entity.x;
  entity.py = entity.y;
  entity.vx += entity.fx;
  entity.vy += entity.fy;
  limitV(entity, vmax);
  entity.x += entity.vx;
  entity.y += entity.vy;
  wrapPos(entity);
}

function respawn(entity: Point): void {
  entity.x = Math.random() * W;
  entity.y = Math.random() * H;
}

function lerpWrap(a: number, b: number, t: number, max: number): number {
  const d = b - a;
  if (d > max * 0.5 || d < -max * 0.5) return b;
  return a + d * t;
}

function makeFish(): Fish {
  const x = Math.random() * W;
  const y = Math.random() * H;
  return {
    x, y,
    px: x, py: y,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    fx: 0, fy: 0,
    energy: 1,
  };
}

function makePredator(): Predator {
  const x = Math.random() * W;
  const y = Math.random() * H;
  return {
    x, y,
    px: x, py: y,
    vx: 0, vy: 0,
    fx: 0, fy: 0,
    hunger: 0,
    targetIdx: -1,
  };
}

function makeWhale(): Whale {
  return {
    x: W / 2, y: H / 2,
    px: W / 2, py: H / 2,
    vx: WHALE_MAX_V, vy: 0,
    fx: 0, fy: 0,
    mass: 50,
    age: 0,
  };
}

function makeRock(): Rock {
  return {
    x: 30 + Math.random() * (W - 60),
    y: 30 + Math.random() * (H - 60),
    radius: 8 + Math.random() * 10,
  };
}

function makeReef(): Reef {
  return {
    x: 40 + Math.random() * (W - 100),
    y: 40 + Math.random() * (H - 100),
    w: 20 + Math.random() * 30,
    h: 12 + Math.random() * 20,
  };
}

function makePellet(): Pellet {
  return {
    x: Math.random() * W,
    y: Math.random() * H,
    value: 1,
  };
}

function makeMote(): Mote {
  return {
    x: Math.random() * W,
    y: Math.random() * H,
    drift: (Math.random() - 0.5) * 0.3,
    age: Math.random() * 100,
  };
}

function makeCurrent(): Current {
  return {
    x: Math.random() * W,
    y: Math.random() * H,
    strength: (Math.random() - 0.5) * 0.4,
    radius: 40 + Math.random() * 30,
  };
}

const school: Fish[] = [];
const predators: Predator[] = [];
const whales: Whale[] = [];
const rocks: Rock[] = [];
const reefs: Reef[] = [];
const pellets: Pellet[] = [];
const motes: Mote[] = [];
const currents: Current[] = [];

for (let i = 0; i < N; i++) school.push(makeFish());
for (let i = 0; i < N_PREDATOR; i++) predators.push(makePredator());
for (let i = 0; i < N_WHALE; i++) whales.push(makeWhale());
for (let i = 0; i < N_ROCK; i++) rocks.push(makeRock());
for (let i = 0; i < N_REEF; i++) reefs.push(makeReef());
for (let i = 0; i < N_PELLET; i++) pellets.push(makePellet());
for (let i = 0; i < N_MOTE; i++) motes.push(makeMote());
for (let i = 0; i < N_CURRENT; i++) currents.push(makeCurrent());

/* @optimize */
function step(dt: number): void {
  // 0. zero forces (helper sees Fish, Predator, Whale shapes).
  for (let i = 0; i < school.length; i++) zeroForces(school[i]);
  for (let i = 0; i < predators.length; i++) zeroForces(predators[i]);
  for (let i = 0; i < whales.length; i++) zeroForces(whales[i]);

  // 1. fish ↔ fish — separation + cohesion + alignment.
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    let centerX = 0, centerY = 0;
    let alignX = 0, alignY = 0;
    let neighbors = 0;
    for (let j = 0; j < school.length; j++) {
      if (i === j) continue;
      const other = school[j];
      const d2 = dist2(fish, other); // Fish/Fish
      if (d2 < 80) pushAway(fish, other, 0.06);
      if (d2 < 900) {
        centerX += other.x;
        centerY += other.y;
        alignX += other.vx;
        alignY += other.vy;
        neighbors++;
      }
    }
    if (neighbors > 0) {
      addForce(fish, centerX / neighbors - fish.x, centerY / neighbors - fish.y, 0.0025);
      addForce(fish, alignX / neighbors - fish.vx, alignY / neighbors - fish.vy, 0.05);
    }
  }

  // 2. fish flee predators / whales.
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    for (let j = 0; j < predators.length; j++) {
      const predator = predators[j];
      if (dist2(fish, predator) < 2500) pushAway(fish, predator, 0.12); // Fish/Predator
    }
    for (let j = 0; j < whales.length; j++) {
      const whale = whales[j];
      if (dist2(fish, whale) < 1600) pushAway(fish, whale, 0.10); // Fish/Whale
    }
  }

  // 3. fish avoid rocks + reefs.
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    for (let j = 0; j < rocks.length; j++) {
      const rock = rocks[j];
      const d2 = dist2(fish, rock); // Fish/Rock
      const r = rock.radius + 6;
      if (d2 < r * r) pushAway(fish, rock, 0.25);
    }
    for (let j = 0; j < reefs.length; j++) {
      const reef = reefs[j];
      if (dist2(fish, reef) < 400) pushAway(fish, reef, 0.18); // Fish/Reef
    }
  }

  // 4. fish seek pellets + motes; consume on contact.
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    for (let j = 0; j < pellets.length; j++) {
      const pellet = pellets[j];
      const d2 = dist2(fish, pellet); // Fish/Pellet
      if (d2 < 25) {
        respawn(pellet);
        fish.energy += 0.1;
      } else if (d2 < 900) {
        pushToward(fish, pellet, 0.03);
      }
    }
    for (let j = 0; j < motes.length; j++) {
      const mote = motes[j];
      const d2 = dist2(fish, mote); // Fish/Mote
      if (d2 < 16) {
        respawn(mote);
        mote.age = 0;
      } else if (d2 < 400) {
        pushToward(fish, mote, 0.015);
      }
    }
  }

  // 5. fish caught in currents (tangential push — special, not via helper).
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    for (let j = 0; j < currents.length; j++) {
      const current = currents[j];
      const d2 = dist2(fish, current); // Fish/Current
      if (d2 < current.radius * current.radius) {
        addForce(fish, -(fish.y - current.y), fish.x - current.x, current.strength * 0.02);
      }
    }
  }

  // 6. predators hunt nearest fish + avoid whales.
  for (let i = 0; i < predators.length; i++) {
    const predator = predators[i];
    let bestDist = 6400;
    let bestIdx = -1;
    for (let j = 0; j < school.length; j++) {
      const d2 = dist2(predator, school[j]); // Predator/Fish
      if (d2 < bestDist) {
        bestDist = d2;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      pushToward(predator, school[bestIdx], 0.06);
      predator.targetIdx = bestIdx;
    }
    for (let j = 0; j < whales.length; j++) {
      const whale = whales[j];
      if (dist2(predator, whale) < 900) pushAway(predator, whale, 0.08); // Predator/Whale
    }
  }

  // 7. motes drift + age.
  for (let i = 0; i < motes.length; i++) {
    const mote = motes[i];
    mote.x += mote.drift;
    mote.age += 1;
    if (mote.x < 0) mote.x += W;
    else if (mote.x > W) mote.x -= W;
  }

  // 8-10. integrate (one helper, three entity types → polymorphic IC site).
  for (let i = 0; i < school.length; i++) {
    integrate(school[i], FISH_MAX_V);
    school[i].energy -= 0.002;
  }
  for (let i = 0; i < predators.length; i++) {
    integrate(predators[i], PREDATOR_MAX_V);
  }
  for (let i = 0; i < whales.length; i++) {
    const whale = whales[i];
    whale.age += 1;
    whale.fx += Math.sin(whale.age * 0.013) * 0.02;
    whale.fy += Math.cos(whale.age * 0.011) * 0.02;
    integrate(whale, WHALE_MAX_V);
  }
}

/* @optimize */
function render(ctx: CanvasRenderingContext2D, alpha: number): void {
  ctx.fillStyle = 'rgba(22,22,22,0.55)';
  ctx.fillRect(0, 0, W, H);

  // currents (faint cyan rings)
  ctx.strokeStyle = 'rgba(100,180,200,0.25)';
  for (let i = 0; i < currents.length; i++) {
    const current = currents[i];
    ctx.beginPath();
    ctx.arc(current.x, current.y, current.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // reefs (dark slabs)
  ctx.fillStyle = '#3a2a1a';
  for (let i = 0; i < reefs.length; i++) {
    const reef = reefs[i];
    ctx.fillRect(reef.x - reef.w / 2, reef.y - reef.h / 2, reef.w, reef.h);
  }

  // rocks (dark circles)
  ctx.fillStyle = '#2a2a2a';
  for (let i = 0; i < rocks.length; i++) {
    const rock = rocks[i];
    ctx.beginPath();
    ctx.arc(rock.x, rock.y, rock.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // motes (tiny cyan dots)
  ctx.fillStyle = '#5cc8c8';
  for (let i = 0; i < motes.length; i++) {
    const mote = motes[i];
    ctx.fillRect(mote.x, mote.y, 1, 1);
  }

  // pellets (yellow)
  ctx.fillStyle = '#ffe066';
  for (let i = 0; i < pellets.length; i++) {
    const pellet = pellets[i];
    ctx.fillRect(pellet.x - 1, pellet.y - 1, 2, 2);
  }

  // whales (dim blue) — interpolated
  ctx.fillStyle = '#4a6fa5';
  for (let i = 0; i < whales.length; i++) {
    const whale = whales[i];
    const x = lerpWrap(whale.px, whale.x, alpha, W);
    const y = lerpWrap(whale.py, whale.y, alpha, H);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // fish — direction-aware triangles, interpolated.
  ctx.fillStyle = '#ffaa44';
  for (let i = 0; i < school.length; i++) {
    const fish = school[i];
    const x = lerpWrap(fish.px, fish.x, alpha, W);
    const y = lerpWrap(fish.py, fish.y, alpha, H);
    const v = Math.sqrt(fish.vx * fish.vx + fish.vy * fish.vy) || 1;
    const dx = fish.vx / v;
    const dy = fish.vy / v;
    ctx.beginPath();
    ctx.moveTo(x + dx * 3, y + dy * 3);
    ctx.lineTo(x - dx * 2 - dy * 1.5, y - dy * 2 + dx * 1.5);
    ctx.lineTo(x - dx * 2 + dy * 1.5, y - dy * 2 - dx * 1.5);
    ctx.fill();
  }

  // predators — interpolated
  ctx.fillStyle = '#ff4488';
  for (let i = 0; i < predators.length; i++) {
    const predator = predators[i];
    const x = lerpWrap(predator.px, predator.x, alpha, W);
    const y = lerpWrap(predator.py, predator.y, alpha, H);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
`;

const CLOTH_SOURCE = `const W = self.innerWidth;
const H = self.innerHeight;
const N = 22;
const SPACING = 16;
const GRAVITY = 0.45;
const DAMPING = 0.99;
const ITER = 3;

type Vec2 = { x: number; y: number };
type Node = { x: number; y: number; px: number; py: number; pinned: boolean };
type Link = { a: number; b: number; rest: number };

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}
function len(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}
function normalize(a: Vec2): Vec2 {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
}

const nodes: Node[] = [];
const links: Link[] = [];

const originX = (W - (N - 1) * SPACING) / 2;
const originY = 40;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const nx = originX + x * SPACING;
    const ny = originY + y * SPACING;
    nodes.push({ x: nx, y: ny, px: nx, py: ny, pinned: y === 0 && x % 3 === 0 });
  }
}

function at(x: number, y: number): number {
  return y * N + x;
}
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (x < N - 1) links.push({ a: at(x, y), b: at(x + 1, y), rest: SPACING });
    if (y < N - 1) links.push({ a: at(x, y), b: at(x, y + 1), rest: SPACING });
  }
}

let t = 0;

/* @optimize */
function integrateNode(n: Node, wind: number): void {
  const pos: Vec2 = { x: n.x, y: n.y };
  const prev: Vec2 = { x: n.px, y: n.py };
  const vel = scale(sub(pos, prev), DAMPING);
  const gravity: Vec2 = { x: 0, y: GRAVITY };
  const breeze: Vec2 = { x: wind, y: 0 };
  const swirl = scale({ x: Math.sin(n.y * 0.05 + t * 0.05), y: Math.cos(n.x * 0.05 + t * 0.05) }, 0.05);
  const force = add(add(gravity, breeze), swirl);
  n.px = n.x;
  n.py = n.y;
  const next = add(add(pos, vel), force);
  n.x = next.x;
  n.y = next.y;
}

/* @optimize */
function solveLink(a: Node, b: Node, rest: number): void {
  const delta = sub(b, a);
  const dist = len(delta);
  if (dist === 0) return;
  const dir = normalize(delta);
  const corr = scale(dir, (rest - dist) * 0.5);
  if (!a.pinned) {
    const na = sub(a, corr);
    a.x = na.x;
    a.y = na.y;
  }
  if (!b.pinned) {
    const nb = add(b, corr);
    b.x = nb.x;
    b.y = nb.y;
  }
}

function step(dt: number): void {
  t += 1;
  const wind = Math.sin(t * 0.05) * 0.12;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.pinned) integrateNode(n, wind);
  }
  for (let k = 0; k < ITER; k++) {
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      solveLink(nodes[l.a], nodes[l.b], l.rest);
    }
  }
}

/* @optimize */
function render(ctx: CanvasRenderingContext2D, alpha: number): void {
  ctx.fillStyle = 'rgba(22,22,22,0.5)';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(120,150,255,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const a = nodes[l.a];
    const b = nodes[l.b];
    const ax = a.px + (a.x - a.px) * alpha;
    const ay = a.py + (a.y - a.py) * alpha;
    const bx = b.px + (b.x - b.px) * alpha;
    const by = b.py + (b.y - b.py) * alpha;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffaa44';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) ctx.fillRect(n.x - 2, n.y - 2, 4, 4);
  }
}
`;

interface Scenario {
    id: string;
    label: string;
    source: string;
    /** Range for the \`N\` slider — its meaning differs per scenario (particle
     *  count vs. cloth grid dimension), so each picks its own bounds. */
    nMin: number;
    nMax: number;
}

const SCENARIOS: Scenario[] = [
    { id: 'predator-prey', label: 'predator prey', source: PREDATOR_PREY_SOURCE, nMin: 10, nMax: 1500 },
    { id: 'cloth', label: 'cloth', source: CLOTH_SOURCE, nMin: 6, nMax: 44 },
];

/** A finished build: both JS variants (transpiled) + compilecat's pass counts. */
interface Built {
    jsWithout: string; // TS → JS, no compilecat
    jsWith: string; // TS → compilecat (TS→TS) → JS
    stats: CompileStats;
}

type CompileState =
    | { kind: 'ok'; result: Built }
    | { kind: 'error'; message: string; last: Built | null };

/** Initial / loading state: no output yet, no error banner. */
const PENDING: CompileState = { kind: 'error', message: '', last: null };

export function App() {
    const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
    const [source, setSource] = useState(SCENARIOS[0].source);
    const [state, setState] = useState<CompileState>(PENDING);
    const [ready, setReady] = useState(false);
    const compilerRef = useRef<Compiler | null>(null);
    const timerRef = useRef<number | null>(null);
    // Monotonic build id — a slow async build that finishes after a newer edit is
    // discarded, so the panes never show stale output.
    const genRef = useRef(0);

    // One-time wasm init → instantiate the persistent Compiler (its module cache
    // amortizes across compiles). Flipping `ready` triggers the first build below.
    useEffect(() => {
        let alive = true;
        createCompiler().then((c) => {
            if (!alive) return;
            compilerRef.current = c;
            setReady(true);
        });
        return () => {
            alive = false;
        };
    }, []);

    // Debounced recompile on edit (and once on ready). No-ops until init lands.
    useEffect(() => {
        const compiler = compilerRef.current;
        if (!compiler) return;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            const gen = ++genRef.current;
            build(compiler, source)
                .then((result) => {
                    if (gen === genRef.current) setState({ kind: 'ok', result });
                })
                .catch((e) => {
                    if (gen !== genRef.current) return;
                    setState((prev) => ({
                        kind: 'error',
                        message: String(e),
                        last: prev.kind === 'ok' ? prev.result : prev.last,
                    }));
                });
        }, 250);
        return () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        };
    }, [source, ready]);

    const result = state.kind === 'ok' ? state.result : state.last;
    const jsWithout = result?.jsWithout ?? '';
    const jsWith = result?.jsWith ?? '';
    const stats = result?.stats ?? null;
    const tsExtensions = useMemo(() => [javascript({ jsx: false, typescript: true })], []);
    const jsExtensions = useMemo(() => [javascript({ jsx: false, typescript: false })], []);

    const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
    const selectScenario = (s: Scenario) => {
        setScenarioId(s.id);
        setSource(s.source);
    };
    const currentN = readN(source);

    return (
        <div className="app">
            {state.kind === 'error' && state.message.length > 0 && (
                <div className="status-bar">
                    <span className="err" title={state.message}>
                        parse error — showing last good output
                    </span>
                </div>
            )}

            <div className="panes">
                <section className="pane">
                    <div className="pane-header pane-header--tabs">
                        {SCENARIOS.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                className={`tab ${s.id === scenarioId ? 'active' : ''}`}
                                onClick={() => selectScenario(s)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <CodeMirror
                        className="editor"
                        value={source}
                        theme="dark"
                        extensions={tsExtensions}
                        onChange={setSource}
                        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
                    />
                </section>
                <div className="pane-col">
                    <section className="pane">
                        <div className="pane-header">js — without compilecat</div>
                        <CodeMirror
                            className="editor"
                            value={jsWithout}
                            theme="dark"
                            extensions={jsExtensions}
                            editable={false}
                            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
                        />
                    </section>
                    <section className="pane">
                        <div className="pane-header">js — with compilecat</div>
                        <CodeMirror
                            className="editor"
                            value={jsWith}
                            theme="dark"
                            extensions={jsExtensions}
                            editable={false}
                            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
                        />
                    </section>
                </div>
                <section className="pane preview-pane">
                    <div className="pane-header preview-header">
                        <span className="preview-title">simulations</span>
                        {currentN !== null && (
                            <label className="control">
                                <span className="control-label">N</span>
                                <input
                                    type="range"
                                    min={scenario.nMin}
                                    max={scenario.nMax}
                                    step={1}
                                    value={currentN}
                                    onChange={(e) => setSource(writeN(source, Number.parseInt(e.target.value, 10)))}
                                />
                                <span className="control-value">{currentN}</span>
                            </label>
                        )}
                    </div>
                    <DualPreview compilecatCode={jsWith} baselineCode={jsWithout} />
                </section>
            </div>

            {stats && (
                <div className="stats">
                    <Stat label="inlined" value={stats.inlined} />
                    <Stat label="unrolled" value={stats.unrolled} />
                    <Stat label="sroa" value={stats.sroa} />
                    <Stat label="folded" value={stats.folded} />
                    <Stat label="dead" value={stats.removedDeadCode} />
                    <Stat label="flow inlined" value={stats.flowInlined} />
                    <Stat label="dead assigns" value={stats.deadAssigns} />
                    <Stat label="minimized" value={stats.minimized} />
                    <Stat label="vars inlined" value={stats.inlinedVariables} />
                </div>
            )}
        </div>
    );
}

function DualPreview({ compilecatCode, baselineCode }: { compilecatCode: string; baselineCode: string }) {
    const samplesA = useRef<number[]>([]); // compilecat ms samples
    const samplesB = useRef<number[]>([]); // baseline ms samples
    const CAP = 60; // ~1s at 60fps
    const MIN_SAMPLES = 20;
    const [ratioText, setRatioText] = useState('measuring…');

    const pushA = useMemo(() => (ms: number) => pushSample(samplesA.current, ms, CAP), []);
    const pushB = useMemo(() => (ms: number) => pushSample(samplesB.current, ms, CAP), []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: clear on source swap
    useEffect(() => { samplesA.current = []; }, [compilecatCode]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: clear on source swap
    useEffect(() => { samplesB.current = []; }, [baselineCode]);

    useEffect(() => {
        const id = window.setInterval(() => {
            const a = samplesA.current;
            const b = samplesB.current;
            if (a.length < MIN_SAMPLES || b.length < MIN_SAMPLES) {
                setRatioText('measuring…');
                return;
            }
            const meanA = mean(a);
            const meanB = mean(b);
            if (meanA <= 0 || meanB <= 0) return;
            const r = meanB / meanA;
            if (r >= 1.02) setRatioText(`compilecat ${r.toFixed(2)}× faster`);
            else if (r <= 0.98) setRatioText(`baseline ${(1 / r).toFixed(2)}× faster`);
            else setRatioText('≈ even');
        }, 1000);
        return () => window.clearInterval(id);
    }, []);

    return (
        <div className="dual-preview">
            <div className="compare-bar">
                <span className="compare-text">{ratioText}</span>
            </div>
            <div className="sim-stack">
                <SubPreview title="compilecat" code={compilecatCode} accent="#ffaa44" onSample={pushA} />
                <SubPreview title="baseline" code={baselineCode} accent="#88aaff" onSample={pushB} />
            </div>
        </div>
    );
}

function pushSample(buf: number[], ms: number, cap: number) {
    buf.push(ms);
    if (buf.length > cap) buf.shift();
}

function mean(xs: number[]): number {
    if (xs.length === 0) return 0;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

function SubPreview({
    title,
    code,
    accent,
    onSample,
}: {
    title: string;
    code: string;
    accent: string;
    onSample: (ms: number) => void;
}) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const graphRef = useRef<PerfGraphHandle>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset on code change is intentional
    useEffect(() => {
        graphRef.current?.reset();
    }, [code]);

    useEffect(() => {
        function onMsg(e: MessageEvent) {
            if (!e.data || e.data.type !== 'fps') return;
            if (e.source !== iframeRef.current?.contentWindow) return;
            graphRef.current?.push(e.data.ms, e.data.ema);
            onSample(e.data.ms);
        }
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, [onSample]);

    const srcdoc = useMemo(() => buildSrcdoc(code), [code]);

    return (
        <div className="sub-preview">
            <div className="sub-preview-header">
                <span className="sub-preview-title" style={{ color: accent }}>
                    {title}
                </span>
            </div>
            <div className="preview">
                <iframe
                    ref={iframeRef}
                    className="preview-frame"
                    sandbox="allow-scripts"
                    title={title}
                    srcDoc={srcdoc}
                />
                <PerfGraph ref={graphRef} accent={accent} />
            </div>
        </div>
    );
}

type PerfGraphHandle = { push: (ms: number, ema: number) => void; reset: () => void };

const PerfGraph = forwardRef<PerfGraphHandle, { accent?: string }>((props, ref) => {
    const accent = props.accent ?? '#ffaa44';
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const samplesRef = useRef<number[]>([]);
    const emaRef = useRef<number>(0);
    const CAP = 120;
    const WIDTH = 160;
    const HEIGHT = 52;

    const draw = () => {
        const c = canvasRef.current;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const samples = samplesRef.current;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);

        let maxMs = 20;
        for (const s of samples) if (s > maxMs) maxMs = s;
        // 16.67ms (60fps) reference
        const refY = HEIGHT - (16.67 / maxMs) * (HEIGHT - 10) - 2;
        ctx.strokeStyle = '#3a3a3a';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, refY);
        ctx.lineTo(WIDTH, refY);
        ctx.stroke();
        ctx.setLineDash([]);

        // graph line — anchored to the right edge, drawn newest-to-oldest.
        if (samples.length > 1) {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            const stepX = WIDTH / (CAP - 1);
            for (let i = 0; i < samples.length; i++) {
                const idx = samples.length - 1 - i;
                const x = WIDTH - i * stepX;
                const y = HEIGHT - (samples[idx] / maxMs) * (HEIGHT - 10) - 2;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        ctx.font = '10px "Roboto Mono", ui-monospace, monospace';
        ctx.fillStyle = accent;
        ctx.fillText(`${emaRef.current.toFixed(2)} ms`, 6, 12);
        ctx.fillStyle = '#888';
        ctx.fillText(`${maxMs.toFixed(0)}`, WIDTH - 18, 12);
    };

    useImperativeHandle(ref, () => ({
        push(ms, ema) {
            samplesRef.current.push(ms);
            if (samplesRef.current.length > CAP) samplesRef.current.shift();
            emaRef.current = ema;
            draw();
        },
        reset() {
            samplesRef.current = [];
            emaRef.current = 0;
            draw();
        },
    }));

    // biome-ignore lint/correctness/useExhaustiveDependencies: draw is stable per-instance
    useEffect(() => {
        draw();
    }, []);

    return <canvas ref={canvasRef} className="perf-graph" width={WIDTH} height={HEIGHT} />;
});
PerfGraph.displayName = 'PerfGraph';

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className={`stat ${value > 0 ? 'nonzero' : ''}`}>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
        </div>
    );
}

function buildSrcdoc(userCode: string): string {
    return `<!doctype html><html><head><style>
html,body{margin:0;background:#161616;color:#cccccc;font-family:'Roboto Mono',ui-monospace,monospace;overflow:hidden;height:100%;}
body{height:100vh;width:100vw;}
canvas{display:block;width:100%;height:100%;background:#161616;}
.err{padding:1rem;font-size:0.75rem;color:#ff8a80;white-space:pre-wrap;}
</style></head><body>
<canvas id="c"></canvas>
<script>
// Defer everything to 'load' so the iframe's layout has settled — that way
// window.innerWidth/innerHeight (and the user's const W/H captured from them)
// reflect the iframe's real size, not the 300×150 default.
window.addEventListener('load', () => {
  // Deterministic Math.random — both panes use the same seeded RNG so the
  // baseline and compilecat sims are bit-for-bit identical. The only
  // measurable difference is the speed of the helper bodies.
  (function seedRandom(){
    let s = 0xC0FFEE ^ 0x1A2B3C4D;
    Math.random = function() {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  })();
  try {
${userCode}
  } catch (e) {
    document.body.innerHTML = '<div class="err">'+String(e).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</div>';
    return;
  }
  const c = document.getElementById('c');
  if (!c) return;
  c.width  = window.innerWidth;
  c.height = window.innerHeight;
  // Reset the sim on resize — sim consts W/H are captured at boot.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => window.location.reload(), 120);
  });
  const ctx = c.getContext('2d');
  if (typeof step !== 'function' || typeof render !== 'function') {
    ctx.fillStyle = '#ffaa44';
    ctx.font = '12px monospace';
    ctx.fillText('source needs step(dt) and render(ctx, alpha)', 10, 20);
    return;
  }
  // Fixed-timestep loop with interpolation.
  // step(dt) is called at a constant rate; render(ctx, alpha) interpolates
  // between the previous and current sim state. Measured time is step-only —
  // the work compilecat's inlining actually affects.
  const FIXED_DT = 1000/60;
  const MAX_STEPS = 5;
  let last = performance.now();
  let accumulator = 0;
  let ema = 0;
  let primed = false;
  function frame(now){
    let dt = now - last;
    if (dt > 250) dt = 250;
    last = now;
    accumulator += dt;
    const tStep = performance.now();
    let steps = 0;
    try {
      while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
        step(FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS) accumulator = 0;  // give up catching up
    } catch (e) {
      ctx.fillStyle='#ff8a80';
      ctx.font='12px monospace';
      ctx.fillText(String(e).slice(0,80), 10, 20);
      return;
    }
    const stepMs = performance.now() - tStep;
    const alpha = accumulator / FIXED_DT;
    try { render(ctx, alpha); }
    catch (e) {
      ctx.fillStyle='#ff8a80';
      ctx.font='12px monospace';
      ctx.fillText(String(e).slice(0,80), 10, 20);
      return;
    }
    if (steps > 0) {
      // Report per-tick step time (normalize when multiple ticks ran).
      const perTick = stepMs / steps;
      ema = primed ? ema * 0.92 + perTick * 0.08 : perTick;
      primed = true;
      parent.postMessage({type:'fps', ms: perTick, ema: ema}, '*');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
});
</script>
</body></html>`;
}

// Pin step/render so dead-code removal keeps them — the iframe harness calls
// them, but the source itself doesn't, so compilecat would otherwise drop them.
const ENTRY_PIN = '\n;globalThis.step = step;\n;globalThis.render = render;\n';

const N_RE = /const\s+N\s*=\s*(\d+)\s*;/;

function readN(source: string): number | null {
    const m = source.match(N_RE);
    return m ? Number.parseInt(m[1], 10) : null;
}

function writeN(source: string, n: number): string {
    return source.replace(N_RE, `const N = ${n};`);
}

/** compilecat (TS→TS, types preserved) then transpile both variants TS→JS. */
async function build(compiler: Compiler, source: string): Promise<Built> {
    const pinned = source + ENTRY_PIN;
    const optimized = compiler.compileFile('input.ts', pinned, { sourcemap: false });
    const [jsWithout, jsWith] = await Promise.all([bundle(pinned), bundle(optimized.code)]);
    return { jsWithout, jsWith, stats: optimized.stats };
}
