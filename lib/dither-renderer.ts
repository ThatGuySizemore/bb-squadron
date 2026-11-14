// One requestAnimationFrame loop paints every animated dither surface that's on
// screen. It stops while the document is hidden. Under prefers-reduced-motion
// each surface draws once, as a still frame, and the loop doesn't run.
// The browser is injected so tests can drive the frame clock.

export interface RendererEnv {
  /** Milliseconds, on the same clock frame callbacks receive. */
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  isHidden(): boolean;
  onVisibilityChange(callback: () => void): void;
  prefersReducedMotion(): boolean;
  onReducedMotionChange(callback: () => void): void;
}

export interface DitherTarget {
  /** Whether this surface moves. A still surface draws once, at stillAt. */
  animated: boolean;
  /** The moment, in seconds, drawn as the still frame. */
  stillAt: number;
  /** A one-time animation ends here, in seconds, and draws its last frame. */
  until?: number;
  /** Whether the surface is on screen; off-screen surfaces aren't redrawn every frame. */
  visible: boolean;
  draw(seconds: number): void;
  onDone?(): void;
}

export interface DitherRenderer {
  add(target: DitherTarget): void;
  remove(target: DitherTarget): void;
  /** Draws one surface again now, e.g. after a resize, then makes sure the loop runs if it should. */
  redraw(target: DitherTarget): void;
  /** Call when a target's visibility changes. */
  wake(): void;
}

export function createDitherRenderer(env: RendererEnv): DitherRenderer {
  const targets = new Map<DitherTarget, { born: number; finished: boolean }>();
  let frame = 0;

  const moving = () => !env.isHidden() && !env.prefersReducedMotion();
  const live = (target: DitherTarget, entry: { finished: boolean }) => target.animated && !entry.finished;

  function drawNow(target: DitherTarget) {
    const entry = targets.get(target);
    if (!entry) return;
    if (!live(target, entry) || env.prefersReducedMotion()) {
      target.draw(entry.finished ? target.until! : target.stillAt);
      return;
    }
    target.draw(Math.max(0, (env.now() - entry.born) / 1000));
  }

  function loop(time: number) {
    frame = 0;
    if (!moving()) return;
    let any = false;
    for (const [target, entry] of targets) {
      if (!live(target, entry)) continue;
      const age = Math.max(0, (time - entry.born) / 1000);
      if (target.until !== undefined && age >= target.until) {
        entry.finished = true;
        target.draw(target.until);
        target.onDone?.();
        continue;
      }
      any = true;
      if (target.visible) target.draw(age);
    }
    if (any) frame = env.requestFrame(loop);
  }

  function schedule() {
    if (frame || !moving()) return;
    for (const [target, entry] of targets) {
      if (live(target, entry)) { frame = env.requestFrame(loop); return; }
    }
  }

  function stop() {
    if (frame) env.cancelFrame(frame);
    frame = 0;
  }

  env.onVisibilityChange(() => (env.isHidden() ? stop() : schedule()));
  env.onReducedMotionChange(() => {
    stop();
    for (const target of targets.keys()) drawNow(target);
    schedule();
  });

  return {
    add(target) {
      targets.set(target, { born: env.now(), finished: false });
      drawNow(target);
      schedule();
    },
    remove(target) {
      targets.delete(target);
      if (![...targets].some(([t, e]) => live(t, e))) stop();
    },
    redraw(target) {
      drawNow(target);
      schedule();
    },
    wake: schedule,
  };
}
