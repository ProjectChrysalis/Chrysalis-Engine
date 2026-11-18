/** What an app's stress suite (stress/suite.ts in the app) exports as default. */
export interface StressSuite {
  /** app id the copy is installed under */
  app: string;
  /** Fill the installed app's data/ before the engine first serves it. */
  fixture?(ctx: FixtureContext): Promise<void>;
  /** JS expression, true once the app is usable after a load */
  ready: string;
  scenarios: Scenario[];
}

export interface FixtureContext {
  /** the installed app's data/ folder */
  dataDir: string;
  /** "<connection id>/<model id>" of the fake model */
  model: string;
  /** library size multiplier from --scale (1 = the full target) */
  scale: number;
}

export interface Scenario {
  name: string;
  /** Returns named measurements (milliseconds, counts, KB). */
  run(page: StressPage): Promise<Record<string, number>>;
  /** Highest acceptable value per measurement; a measurement over its limit fails the run. */
  limits: Record<string, number>;
}

export interface TypingResult {
  /** characters that reached the field, of `typed` */
  landed: number;
  typed: number;
  /** keydown event durations over every keystroke (Event Timing; under 16 ms reads as 0) */
  p50: number;
  p90: number;
  max: number;
  /** animation frames longer than 50 ms while typing */
  longFrames: number;
}

export interface SettleResult {
  /** ms from the action until the last long frame */
  settleMs: number;
  /** longest frame on the way */
  worstFrame: number;
  /** summed length of frames over 34 ms */
  blockedMs: number;
}

export interface LoadResult {
  /** ms from navigation until `ready` holds */
  readyMs: number;
  requests: number;
  /** response bytes the app requested, in KB */
  kb: number;
}

export interface ScrollResult {
  /** frames longer than 50 ms during the scroll */
  longFrames: number;
  worstFrame: number;
  blockedMs: number;
}

export interface StressPage {
  /** Run a function body (it may `await` and should `return`) in the app frame. */
  eval<T = unknown>(body: string): Promise<T>;
  /** The same in the shell page around the app. */
  shell<T = unknown>(body: string): Promise<T>;
  waitFor(condition: string, timeoutMs?: number): Promise<void>;
  /** Type with real key events into the first element matching `selector`. */
  type(selector: string, text: string, gapMs?: number): Promise<TypingResult>;
  /** Run `action` in the app frame and measure until `until` (an expression)
   *  holds and no frame has been long for 400 ms. */
  act(action: string, until?: string): Promise<SettleResult>;
  /** Open the app from the shell and wait until the suite's `ready` holds;
   *  `onStatus` gets the shell's build card text while it waits. */
  open(timeoutMs?: number, onStatus?: (text: string) => void): Promise<void>;
  /** Reload the whole page, open the app again and measure until it is ready. */
  reload(): Promise<LoadResult>;
  /** Wheel-scroll the element matching `selector` by `px`, in steps. */
  scroll(selector: string, px: number): Promise<ScrollResult>;
  /** Fake model settings for the next generations. */
  model: { deltas: number; delayMs: number };
  screenshot(path: string): Promise<void>;
}
