<script>
  import { untrack } from 'svelte';
  import { fmtLap as fmt, fmtDelta } from './track/format.js';

  /**
   * Time-attack HUD. Reads the session every frame (`tick` changes each frame) and
   * turns its feed into banners — every sector, lap, record and mistake gets a response.
   */
  let { session, tick = 0 } = $props();

  const SECTOR_COLOR = { purple: 'var(--c-grade-perfect)', green: 'var(--c-grade-great)', yellow: '#f5d142' };
  const BANNER_TTL = { lap: 4.5, pb: 6, sector: 2.2, invalid: 3, speedtrap: 2.6, spin: 2, wall: 1.6 };
  const COACH_TTL = 4;
  let coach = $state(null);

  let banners = $state([]);
  let lastSeen = 0;
  let streakPulse = $state(0);


  let view = $derived.by(() => {
    tick; // re-run every frame
    const t = session.timer;
    const g = session.grader;
    const delta = t.delta(session.car.s);
    return {
      running: t.running,
      lap: t.lapNumber,
      time: t.t,
      valid: t.valid,
      delta,
      last: t.lastLap,
      best: t.bestLap,
      sectors: [0, 1, 2].map(i => ({
        time: t.sector > i ? t.currentSectors[i] : (t.sector === i ? null : null),
        done: t.sector > i,
        color: t.sector > i ? t.lastSectorColors[i] : null,
      })),
      streak: g.streak,
      bestStreak: g.bestStreak,
      top: session.bestTopSpeed,
      ideal: session.idealLap,
      history: t.laps.slice(-4).reverse(),
    };
  });

  // Turn new feed events into banners
  $effect(() => {
    tick;
    // banners is read and written here: untrack, or the effect re-triggers itself
    untrack(() => {
      const now = session.time;
      const next = banners.filter(b => now - b.t0 < b.ttl);
      for (const e of session.feed) {
        if (e.seq <= lastSeen) continue;
        lastSeen = e.seq;
        if (e.type === 'coach') { coach = { ...e, t0: now }; continue; }
        const b = toBanner(e);
        if (b) next.push({ ...b, t0: now, id: e.seq });
        if (e.type === 'corner' && e.streak > 0) streakPulse = now;
      }
      if (next.length !== banners.length || next.some((b, i) => b !== banners[i])) banners = next;
      if (coach && now - coach.t0 > COACH_TTL) coach = null;
    });
  });

  const GRADE_WORDS = [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['warn', 'TOO HOT'], ['bad', 'OFF/SPIN']];
  function gradeSummary(g = {}) {
    return GRADE_WORDS.filter(([k]) => g[k]).map(([k, w]) => `${g[k]} ${w}`).join(' · ');
  }

  function toBanner(e) {
    switch (e.type) {
      case 'lap':
        if (e.pb) return { kind: 'pb', ttl: BANNER_TTL.pb, title: 'NEW PERSONAL BEST', main: fmt(e.time),
          sub: [e.delta == null ? `LAP ${e.number}` : `${fmtDelta(e.delta)} · LAP ${e.number}`, gradeSummary(e.grades)].filter(Boolean).join('  ·  ') };
        return { kind: e.valid ? 'lap' : 'invalid', ttl: BANNER_TTL.lap, title: e.valid ? `LAP ${e.number}` : `LAP ${e.number} · INVALID`,
          main: fmt(e.time), sub: [e.delta == null ? '' : `${fmtDelta(e.delta)} to PB`, gradeSummary(e.grades)].filter(Boolean).join('  ·  ') };
      case 'sector':
        return { kind: 'sector', ttl: BANNER_TTL.sector, title: `SECTOR ${e.index + 1}`, main: fmt(e.time, 2),
          sub: e.delta == null ? '' : fmtDelta(e.delta), color: SECTOR_COLOR[e.color] };
      case 'invalid':
        return { kind: 'invalid', ttl: BANNER_TTL.invalid, title: e.reason, main: 'LAP INVALID', sub: 'next one counts' };
      case 'speedtrap':
        return { kind: e.record ? 'pb' : 'sector', ttl: BANNER_TTL.speedtrap, title: e.record ? 'SPEED TRAP RECORD' : 'SPEED TRAP',
          main: `${Math.round(e.kmh)} km/h`, sub: '' };
      case 'spin':
        return { kind: 'invalid', ttl: BANNER_TTL.spin, title: 'SPIN', main: 'SPUN OUT', sub: '' };
      case 'wall':
        return { kind: 'invalid', ttl: BANNER_TTL.wall, title: 'OUCH', main: 'TYRE WALL', sub: '' };
      default:
        return null;
    }
  }
</script>

<div class="hud-track">
  <div class="timing">
    <div class="row head">
      <span class="lap">{view.running ? `LAP ${view.lap}` : 'OUT LAP'}</span>
      {#if view.running && !view.valid}<span class="tag bad">INVALID</span>{/if}
    </div>
    <div class="clock" class:invalid={view.running && !view.valid}>
      {view.running ? fmt(view.time) : 'CROSS THE LINE'}
    </div>
    {#if view.delta != null}
      <div class="delta" class:ahead={view.delta < 0} class:behind={view.delta >= 0}>{fmtDelta(view.delta)}</div>
    {/if}
    <div class="sectors">
      {#each view.sectors as sec, i}
        <div class="sector" class:done={sec.done} style:--sc={sec.color ? SECTOR_COLOR[sec.color] : 'transparent'}>
          <span>S{i + 1}</span>
          <span class="st">{sec.done ? fmt(sec.time, 2).replace(/^0:/, '') : ''}</span>
        </div>
      {/each}
    </div>
    <div class="row small">
      <span>LAST <b>{fmt(view.last)}</b></span>
    </div>
    <div class="row small">
      <span>BEST <b class="best">{fmt(view.best)}</b></span>
    </div>
    {#if view.ideal}
      <div class="row small">
        <span>IDEAL <b class="ideal">{fmt(view.ideal)}</b></span>
      </div>
    {/if}
    <div class="row small">
      <span>TOP <b>{view.top ? `${Math.round(view.top)} km/h` : '—'}</b></span>
    </div>
    {#if view.history.length}
      <div class="history">
        {#each view.history as l (l.number)}
          <div class="h-row" class:pb={l.pb} class:bad={!l.valid}>
            <span>L{l.number}</span><span>{fmt(l.time)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if view.streak >= 2}
    <div class="streak-wrap">
      {#key streakPulse}
        <div class="streak" class:hot={view.streak >= 5}>
          <span class="n">{view.streak}×</span> CLEAN
        </div>
      {/key}
    </div>
  {/if}

  {#if coach}
    {#key coach.seq}
      <div class="coach">
        <span class="c-title">{coach.title}</span>
      </div>
    {/key}
  {/if}

  <div class="banners">
    {#each banners as b (b.id)}
      <div class="banner {b.kind}" style:--bc={b.color || ''}>
        <div class="b-title">{b.title}</div>
        <div class="b-main">{b.main}</div>
        {#if b.sub}<div class="b-sub">{b.sub}</div>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .hud-track {
    position: absolute;
    inset: 0;
    pointer-events: none;
    font-family: 'Share Tech Mono', monospace;
    color: var(--c-text-primary);
  }

  .timing {
    position: absolute;
    top: 12px;
    left: 12px;
    min-width: 170px;
    padding: 10px 12px;
    background: rgba(10, 12, 20, 0.62);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    backdrop-filter: blur(2px);
  }

  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .head .lap {
    font-size: 0.7rem;
    letter-spacing: 0.15em;
    color: var(--c-text-muted);
  }

  .tag {
    font-size: 0.6rem;
    padding: 1px 6px;
    border-radius: 999px;
    letter-spacing: 0.1em;
  }

  .tag.bad {
    background: rgba(255, 77, 61, 0.2);
    color: var(--c-grade-bad);
  }

  .clock {
    font-size: 1.7rem;
    line-height: 1.1;
    letter-spacing: 0.02em;
  }

  .clock.invalid {
    color: var(--c-text-muted);
    text-decoration: line-through rgba(255, 77, 61, 0.6);
  }

  .delta {
    font-size: 1rem;
    font-weight: bold;
  }

  .delta.ahead { color: var(--c-grade-great); }
  .delta.behind { color: var(--c-grade-bad); }

  .sectors {
    display: flex;
    gap: 4px;
    margin: 6px 0;
  }

  .sector {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2px 0;
    font-size: 0.6rem;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-bottom: 3px solid var(--sc);
    color: var(--c-text-muted);
    transition: background 0.3s;
  }

  .sector.done { color: var(--c-text-primary); }
  .st { font-size: 0.65rem; min-height: 0.8rem; }

  .small {
    font-size: 0.7rem;
    color: var(--c-text-muted);
    line-height: 1.5;
  }

  .small b {
    color: var(--c-text-primary);
    font-weight: normal;
  }

  .small b.best { color: var(--c-pb-gold); }
  .small b.ideal { color: var(--c-grade-perfect); }

  .history {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.65rem;
    color: var(--c-text-muted);
  }

  .h-row {
    display: flex;
    justify-content: space-between;
    line-height: 1.5;
  }

  .h-row.pb { color: var(--c-pb-gold); }
  .h-row.bad { color: var(--c-text-ghost); text-decoration: line-through; }

  .streak-wrap {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
  }

  .streak {
    padding: 4px 14px;
    border-radius: 999px;
    font-size: 0.8rem;
    letter-spacing: 0.12em;
    color: #1a1400;
    background: var(--c-pb-gold);
    box-shadow: 0 3px 0 #b8901f, 0 6px 18px rgba(255, 210, 74, 0.35);
    animation: pop 0.35s ease-out;
  }

  .streak.hot {
    background: linear-gradient(90deg, #ffd24a, #ff8a3d);
  }

  .streak .n {
    font-size: 1.1rem;
    font-weight: bold;
  }

  .banners {
    position: absolute;
    top: 22%;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .banner {
    text-align: center;
    padding: 8px 22px;
    border-radius: 14px;
    background: rgba(10, 12, 20, 0.66);
    border: 1px solid rgba(255, 255, 255, 0.1);
    animation: pop 0.35s ease-out, fadeout 0.6s ease-in forwards;
    animation-delay: 0s, 1.6s;
  }

  .banner.lap, .banner.pb { animation-delay: 0s, 3.8s; }

  .b-title {
    font-size: 0.7rem;
    letter-spacing: 0.2em;
    color: var(--c-text-muted);
  }

  .b-main {
    font-size: 1.6rem;
    letter-spacing: 0.04em;
  }

  .b-sub {
    font-size: 0.75rem;
    color: var(--c-text-secondary);
  }

  .banner.sector .b-main { color: var(--bc, var(--c-text-primary)); font-size: 1.2rem; }

  .banner.pb {
    background: rgba(40, 30, 5, 0.75);
    border-color: var(--c-pb-gold);
    box-shadow: 0 0 30px rgba(255, 210, 74, 0.35);
  }

  .banner.pb .b-title { color: var(--c-pb-gold); font-weight: bold; }
  .banner.pb .b-main { color: #fff3c4; font-size: 2rem; }

  .banner.invalid {
    border-color: rgba(255, 77, 61, 0.6);
  }

  .banner.invalid .b-title { color: var(--c-grade-bad); }

  .coach {
    position: absolute;
    bottom: var(--hud-clear, 14px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgba(10, 12, 20, 0.7);
    border: 1px solid rgba(255, 179, 0, 0.45);
    font-size: 0.75rem;
    white-space: nowrap;
    animation: coach-in 0.3s ease-out, fadeout 0.6s ease-in 3.4s forwards;
  }

  .c-title {
    color: #ffb300;
    letter-spacing: 0.12em;
    font-weight: bold;
  }


  @keyframes coach-in {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  @keyframes pop {
    0% { transform: scale(0.7); opacity: 0; }
    60% { transform: scale(1.08); opacity: 1; }
    100% { transform: scale(1); }
  }

  @keyframes fadeout {
    to { opacity: 0; transform: translateY(-8px); }
  }

  @media (max-width: 600px), (max-height: 449px) {
    .timing { min-width: 0; width: 132px; padding: 5px 7px; top: 8px; left: 8px; }
    .clock { font-size: 1.05rem; }
    .delta { font-size: 0.8rem; }
    .small { font-size: 0.6rem; line-height: 1.35; }
    .sector { font-size: 0.5rem; }
    .st { font-size: 0.55rem; }
    .history { display: none; }
    .coach { font-size: 0.6rem; white-space: normal; width: 86%; }
    .banners { top: 30%; }
    .b-main { font-size: 1.2rem; }
  }
</style>
