#!/usr/bin/env node
/**
 * Transcript resize probe — a browser-level guard for the scroll behaviour that
 * made the chat jump while a window narrowed. See web/src/layout.ts and
 * web/src/scroll-follow.ts for the invariants it locks:
 *
 *   1. Geometry stays batched: at most one spacer-height commit per animation
 *      frame (committing once per observer callback turned a resize into a
 *      render storm that teleported the transcript).
 *   2. A pinned reader glues to the tail: no single frame may pop the newest
 *      content more than a re-wrap's worth of pixels.
 *   3. Input stops, motion stops: after the last width change the transcript is
 *      still — no further geometry commits, no drifting.
 *
 * It serves the synthetic fixture (web/probe.html) through Vite, drives a
 * headless Chromium/Edge over the DevTools protocol (no extra dependencies —
 * `ws` is already a repo dependency), and exits non-zero when an invariant
 * breaks.
 *
 * Usage (repo root or web/):  npm run probe:resize
 *   PROBE_BROWSER=<path>   pick the Chromium/Edge binary explicitly
 *   PROBE_HEADED=1         run with a visible window (debugging)
 *   PROBE_KEEP=1           keep the browser and Vite server running on finish
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const PROBE_PORT = 5380;
const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 820;
const STEP_MS = 70;
const QUIET_MS = 500;
const POST_MS = 4200;
/** Late measurement batches may still land right after the last width step. */
const POST_GRACE_MS = 700;
const SWEEP = [];
for (let width = 1160; width >= 360; width -= 40) SWEEP.push(width);

/**
 * Measured with the invariants in place (fixed) versus the regressions they
 * guard (broken): commits/frame 1 vs 5+; sweep mutations 95–183 vs 1400–1650;
 * bottom tail pop 21px vs 106–270px; parked scrollTop jump <~150px vs 1600px+;
 * post-input motion 0px vs 150px with 150 mutations.
 */
const LIMITS = {
  quietMutations: 5,
  commitsPerFrame: 2,
  sweepMutations: 450,
  bottomTailPop: 150,
  parkedJump: 600,
  postRange: 4,
  postMutations: 5,
};

const RECORDER = `(() => {
  const scroller = document.querySelector('.scroller');
  const rowsEl = document.querySelector('.rows');
  if (!scroller || !rowsEl) return 'missing dom';
  const probe = window.__probe = { samples: [], marks: [], sweepEnd: null };
  let commits = 0;
  let mutations = 0;
  const observer = new MutationObserver((list) => {
    for (const record of list) {
      mutations += 1;
      if (record.type === 'attributes' && record.target === rowsEl) commits += 1;
    }
  });
  observer.observe(rowsEl, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
  const sample = () => {
    const rows = [...document.querySelectorAll('.scroller .row')];
    const last = rows[rows.length - 1] || null;
    probe.samples.push({
      t: performance.now(),
      st: Math.round(scroller.scrollTop),
      total: parseInt(rowsEl.style.height, 10) || 0,
      tailTop: last ? Math.round(last.getBoundingClientRect().top) : null,
      commits,
      mutations,
    });
    commits = 0;
    mutations = 0;
    if (!probe.stop) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__probeStop = () => { probe.stop = true; };
  return 'ok';
})()`;

async function waitFor(probe, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(120);
  }
}

function findBrowser() {
  const candidates = [
    process.env.PROBE_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium or Edge binary found. Set PROBE_BROWSER=<path> and retry.');
}

async function launchBrowser() {
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'openbutler-probe-'));
  const args = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  if (process.env.PROBE_HEADED !== '1') args.unshift('--headless=new');
  const child = spawn(browser, args, { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim().length > 0, 20_000, 'browser debug port');
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  return { child, profile, port };
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const session = new CdpSession(socket);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const entry = session.pending.get(message.id);
      if (!entry) return;
      session.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    return session;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function runScenario(session, base, { park, label }) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send('Page.navigate', { url: `${base}probe.html?n=300` });
  await waitFor(() => session.evaluate('window.__probeReady === true'), 90_000, `${label}: fixture ready`);
  await waitFor(
    () =>
      session.evaluate(`(() => {
        const rowsEl = document.querySelector('.rows');
        if (!rowsEl || document.querySelectorAll('.scroller .row').length === 0) return false;
        const signature = rowsEl.style.height + ':' + document.querySelectorAll('.scroller .row').length;
        window.__settleWatch = (window.__settleWatch || []).concat(signature).slice(-6);
        return window.__settleWatch.length >= 6 && new Set(window.__settleWatch).size === 1;
      })()`),
    30_000,
    `${label}: initial settle`,
  );
  await sleep(500);
  if (park > 0) {
    await session.evaluate(`(() => {
      const s = document.querySelector('.scroller');
      s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * ${park});
      s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    })()`);
    await sleep(800);
  }
  const installed = await session.evaluate(RECORDER);
  if (installed !== 'ok') throw new Error(`${label}: recorder failed: ${installed}`);
  await sleep(QUIET_MS);
  for (const width of SWEEP) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height: VIEW_HEIGHT, deviceScaleFactor: 1, mobile: false });
    await session.evaluate('window.__probe.marks.push(performance.now())');
    await sleep(STEP_MS);
  }
  await session.evaluate('window.__probe.sweepEnd = performance.now()');
  await sleep(POST_MS);
  const data = JSON.parse(await session.evaluate('(window.__probeStop(), JSON.stringify(window.__probe))'));
  return { mode: park > 0 ? 'parked' : 'bottom', label, ...data };
}

function analyze(run) {
  const sweepStart = run.marks[0];
  const sweepEnd = run.sweepEnd;
  const quiet = run.samples.filter((sample) => sample.t < sweepStart - 20);
  const sweep = run.samples.filter((sample) => sample.t >= sweepStart - 20 && sample.t < sweepEnd);
  const post = run.samples.filter((sample) => sample.t >= sweepEnd + POST_GRACE_MS);

  const sum = (list, key) => list.reduce((total, sample) => total + sample[key], 0);
  const range = (list, key) => {
    const values = list.map((sample) => sample[key]).filter((value) => value !== null);
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  };
  const maxStep = (list, key) => {
    let largest = 0;
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1][key];
      const current = list[index][key];
      if (previous !== null && current !== null) largest = Math.max(largest, Math.abs(current - previous));
    }
    return largest;
  };
  const totalChanges = (list) => {
    let changes = 0;
    for (let index = 1; index < list.length; index += 1) {
      if (list[index].total !== list[index - 1].total) changes += 1;
    }
    return changes;
  };

  return {
    quiet: { commits: sum(quiet, 'commits'), mutations: sum(quiet, 'mutations'), totalChanges: totalChanges(quiet) },
    sweep: {
      maxCommitsPerFrame: Math.max(0, ...sweep.map((sample) => sample.commits)),
      mutations: sum(sweep, 'mutations'),
      tailStep: maxStep(sweep, 'tailTop'),
      scrollStep: maxStep(sweep, 'st'),
      frames: sweep.length,
    },
    post: {
      mutations: sum(post, 'mutations'),
      totalChanges: totalChanges(post),
      tailRange: range(post, 'tailTop'),
      scrollRange: range(post, 'st'),
      frames: post.length,
    },
  };
}

function report(run, stats) {
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? '✓' : '✗'} ${name} — ${detail}`);
  };
  console.log(`\n▸ ${run.label} (${run.mode}) — ${stats.sweep.frames} sweep frames, ${stats.post.frames} post frames`);
  check(
    'quiet baseline is still before the sweep',
    stats.quiet.commits === 0 && stats.quiet.totalChanges === 0 && stats.quiet.mutations <= LIMITS.quietMutations,
    `commits ${stats.quiet.commits}, total changes ${stats.quiet.totalChanges}, mutations ${stats.quiet.mutations}`,
  );
  check(
    'geometry commits stay batched (one per frame)',
    stats.sweep.maxCommitsPerFrame <= LIMITS.commitsPerFrame,
    `max ${stats.sweep.maxCommitsPerFrame} spacer commits in a frame`,
  );
  check(
    'resize does not storm the DOM',
    stats.sweep.mutations <= LIMITS.sweepMutations,
    `${stats.sweep.mutations} mutations during the sweep`,
  );
  if (run.mode === 'bottom') {
    check(
      'the tail never pops during the sweep',
      stats.sweep.tailStep <= LIMITS.bottomTailPop,
      `max single-frame tail move ${stats.sweep.tailStep}px`,
    );
  } else {
    check(
      'the parked view never teleports',
      stats.sweep.scrollStep <= LIMITS.parkedJump,
      `max single-frame scrollTop move ${stats.sweep.scrollStep}px`,
    );
  }
  const postRange = run.mode === 'bottom' ? stats.post.tailRange : stats.post.scrollRange;
  check(
    'input stops, motion stops',
    stats.post.totalChanges === 0 && stats.post.mutations <= LIMITS.postMutations && postRange <= LIMITS.postRange,
    `range ${postRange}px, geometry commits ${stats.post.totalChanges}, mutations ${stats.post.mutations}`,
  );
  return results;
}

let server = null;
let browser = null;
let session = null;
let profileDir = null;
const failures = [];
const watchdog = setTimeout(() => {
  console.error('probe timed out after 4 minutes');
  process.exit(2);
}, 240_000);

try {
  server = await createServer({
    root: webRoot,
    configFile: join(webRoot, 'vite.config.ts'),
    server: { port: PROBE_PORT, strictPort: true },
    logLevel: 'silent',
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${PROBE_PORT}/`;
  console.log(`probe: fixture served at ${base}probe.html`);

  const launched = await launchBrowser();
  browser = launched.child;
  profileDir = launched.profile;
  const target = await (await fetch(`http://127.0.0.1:${launched.port}/json/new?url=about:blank`, { method: 'PUT' })).json();
  session = await CdpSession.connect(target.webSocketDebuggerUrl);
  await session.send('Runtime.enable');
  await session.send('Page.enable');

  for (const scenario of [
    { park: 0, label: 'narrowing while pinned to the tail' },
    { park: 0.5, label: 'narrowing while reading mid-conversation' },
  ]) {
    const run = await runScenario(session, base, scenario);
    const stats = analyze(run);
    failures.push(...report(run, stats).filter((result) => !result.pass));
  }
} catch (error) {
  console.error(`probe error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  clearTimeout(watchdog);
  if (session) session.close();
  if (browser && process.env.PROBE_KEEP !== '1') browser.kill();
  if (server && process.env.PROBE_KEEP !== '1') await server.close();
  if (profileDir) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* The browser may hold the profile briefly; temp cleanup can wait. */
    }
  }
}

if (process.exitCode === undefined) {
  if (failures.length > 0) {
    console.error(`\n✗ probe failed — ${failures.length} invariant(s) broken:`);
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ probe passed — resize stays local, batched and still.');
    process.exitCode = 0;
  }
}
