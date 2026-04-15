<script>
  import { onMount } from 'svelte';
  import { TrackRenderer } from './track/render.js';

  /** @type {{ session: import('./track/session.js').RaceSession, carColor?: string, bottomInset?: number }} */
  let { session, carColor, bottomInset = 0 } = $props();

  let canvasEl;
  let wrapEl;

  onMount(() => {
    const renderer = new TrackRenderer(canvasEl, session, { carColor });
    const fit = () => {
      const r = wrapEl.getBoundingClientRect();
      renderer.resize(r.width, r.height, window.devicePixelRatio);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrapEl);

    let raf, last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      renderer.bottomInset = bottomInset;
      renderer.draw(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  });
</script>

<div class="track-view" bind:this={wrapEl}>
  <canvas bind:this={canvasEl}></canvas>
</div>

<style>
  .track-view {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
