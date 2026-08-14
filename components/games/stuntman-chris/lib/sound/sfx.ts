/**
 * Stuntman Chris — Web-Audio SFX manager (UI-layer module, no React).
 *
 * One lazily-created AudioContext behind a master gain. Files load on the
 * first user gesture (`unlock()`), and every play/loop call is
 * silent-if-missing: the sound set can be delivered piecemeal (several names
 * below are the producer's, not yet recorded) and the game never breaks.
 *
 * Mute/volume state is LOCAL (localStorage) for this standalone build. At
 * platform re-integration the controls should be re-wired to
 * `useUserPreferences()` — flag this in the handback notes.
 *
 * MUSIC: `stuntman_song.wav` is the theme. It runs on its own gain chain —
 * NOT through the sfx master and NOT in the loops map — so sfx mute/volume
 * and the director's stopAllLoops() never touch it. It starts (looping) on
 * the first unlock gesture and simply plays for the whole session; mute just
 * zeroes its gain, so unmuting rejoins the song in progress.
 */

export const SFX_NAMES = [
  "ui_click",
  "charge_loop",
  "engine_idle",
  "engine_ride",
  "ramp_launch",
  "flight_wind",
  "bounce",
  "landing_touchdown",
  "skid_loop",
  "result_safe",
  "result_crash",
  "new_best",
  "laser_fire",
  "laser_hit",
  "skeleton_emerge",
  "bone_throw",
  "bone_hit",
  "moonboots_pickup",
  "moonboots_surge",
  "crash_blocker",
  "ground_thud",
  "crowd_murmur",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

/** Names that loop seamlessly until stopped. */
const LOOPS: ReadonlySet<SfxName> = new Set<SfxName>([
  "charge_loop",
  "engine_idle",
  "engine_ride",
  "flight_wind",
  "skid_loop",
  "crowd_murmur",
]);

const BASE = "/sounds/games/stuntman-chris/";
const MUSIC_URL = `${BASE}stuntman_song.wav`;
const SFX_MUTED_KEY = "stuntman-chris-sfx-muted";
const MUSIC_MUTED_KEY = "stuntman-chris-music-muted";
const SFX_VOLUME_KEY = "stuntman-chris-sfx-volume";
const MUSIC_VOLUME_KEY = "stuntman-chris-music-volume";
/** The raw track is loud next to the effects; default the slider below full. */
const DEFAULT_MUSIC_VOLUME = 0.7;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Parse a stored 0..1 volume; anything unparseable falls back. */
function readVolume(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? clamp01(v) : fallback;
}

interface LoopHandle {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

class SfxManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  /** Names that failed to load (404 / decode) — never retried, never played. */
  private missing = new Set<SfxName>();
  private loading = new Set<SfxName>();
  private loops = new Map<SfxName, LoopHandle>();
  private sfxMuted = false;
  private musicMuted = false;
  private sfxVolume = 1;
  private musicVolume = DEFAULT_MUSIC_VOLUME;
  private prefsRead = false;

  // Theme-song chain (independent of the sfx master — see module header).
  private musicGain: GainNode | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  private musicLoadState: "idle" | "loading" | "failed" = "idle";

  private readPrefs(): void {
    if (this.prefsRead || typeof window === "undefined") return;
    this.prefsRead = true;
    try {
      this.sfxMuted = window.localStorage.getItem(SFX_MUTED_KEY) === "1";
      this.musicMuted = window.localStorage.getItem(MUSIC_MUTED_KEY) === "1";
      this.sfxVolume = readVolume(window.localStorage.getItem(SFX_VOLUME_KEY), 1);
      this.musicVolume = readVolume(
        window.localStorage.getItem(MUSIC_VOLUME_KEY),
        DEFAULT_MUSIC_VOLUME,
      );
    } catch {
      /* storage unavailable — defaults stand */
    }
  }

  /** Create/resume the context. Call from a user-gesture handler. */
  unlock(): void {
    if (typeof window === "undefined") return;
    this.readPrefs();
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.sfxMuted ? 0 : this.sfxVolume;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicMuted ? 0 : this.musicVolume;
      this.musicGain.connect(this.ctx.destination);
      for (const name of SFX_NAMES) void this.load(name);
      void this.loadAndStartMusic();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Fetch the theme once, then loop it for the whole session. Muting only
   *  zeroes the gain, so the song keeps its place. Silent if the file 404s. */
  private async loadAndStartMusic(): Promise<void> {
    if (!this.ctx || this.musicLoadState !== "idle") return;
    this.musicLoadState = "loading";
    try {
      const res = await fetch(MUSIC_URL);
      if (!res.ok) throw new Error(String(res.status));
      this.musicBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      this.musicLoadState = "failed";
      return;
    }
    if (this.musicSrc || !this.musicGain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.musicBuffer;
    src.loop = true;
    src.connect(this.musicGain);
    src.start();
    this.musicSrc = src;
  }

  private async load(name: SfxName): Promise<void> {
    if (!this.ctx || this.buffers.has(name) || this.missing.has(name) || this.loading.has(name)) {
      return;
    }
    this.loading.add(name);
    try {
      const res = await fetch(`${BASE}${name}.wav`);
      if (!res.ok) throw new Error(String(res.status));
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(name, buf);
    } catch {
      this.missing.add(name); // not delivered yet — stay silent for this name
    } finally {
      this.loading.delete(name);
    }
  }

  /** Fire a one-shot. Silent no-op when the file is absent or still loading. */
  play(name: SfxName, opts?: { volume?: number; rate?: number }): void {
    this.unlock();
    if (!this.ctx || !this.master) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts?.rate ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.value = opts?.volume ?? 1;
    src.connect(gain).connect(this.master);
    src.start();
  }

  /** Start (or restart) a named seamless loop. */
  loop(name: SfxName, opts?: { volume?: number; rate?: number }): void {
    this.unlock();
    if (!this.ctx || !this.master || !LOOPS.has(name)) return;
    this.stopLoop(name, 8);
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = opts?.rate ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.value = opts?.volume ?? 1;
    src.connect(gain).connect(this.master);
    src.start();
    this.loops.set(name, { src, gain });
  }

  /** Whether a named loop is currently running. */
  isLooping(name: SfxName): boolean {
    return this.loops.has(name);
  }

  /** Ramp a running loop's volume (e.g. wind following airspeed). */
  setLoopVolume(name: SfxName, volume: number): void {
    const h = this.loops.get(name);
    if (!h || !this.ctx) return;
    h.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.08);
  }

  stopLoop(name: SfxName, fadeMs = 40): void {
    const h = this.loops.get(name);
    if (!h || !this.ctx) return;
    this.loops.delete(name);
    const t = this.ctx.currentTime;
    h.gain.gain.setTargetAtTime(0, t, fadeMs / 1000 / 3);
    h.src.stop(t + fadeMs / 1000 + 0.05);
  }

  stopAllLoops(fadeMs = 40): void {
    for (const name of [...this.loops.keys()]) this.stopLoop(name, fadeMs);
  }

  private writePref(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }

  get muted(): boolean {
    this.readPrefs();
    return this.sfxMuted;
  }

  setMuted(muted: boolean): void {
    this.readPrefs();
    this.sfxMuted = muted;
    this.writePref(SFX_MUTED_KEY, muted ? "1" : "0");
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.sfxVolume, this.ctx.currentTime, 0.02);
    }
  }

  get sfxVolumePref(): number {
    this.readPrefs();
    return this.sfxVolume;
  }

  setSfxVolume(volume: number): void {
    this.readPrefs();
    this.sfxVolume = clamp01(volume);
    this.writePref(SFX_VOLUME_KEY, String(this.sfxVolume));
    if (this.ctx && this.master && !this.sfxMuted) {
      this.master.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.02);
    }
  }

  get musicMutedPref(): boolean {
    this.readPrefs();
    return this.musicMuted;
  }

  setMusicMuted(muted: boolean): void {
    this.readPrefs();
    this.musicMuted = muted;
    this.writePref(MUSIC_MUTED_KEY, muted ? "1" : "0");
    if (this.ctx && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(muted ? 0 : this.musicVolume, this.ctx.currentTime, 0.03);
    }
  }

  get musicVolumePref(): number {
    this.readPrefs();
    return this.musicVolume;
  }

  setMusicVolume(volume: number): void {
    this.readPrefs();
    this.musicVolume = clamp01(volume);
    this.writePref(MUSIC_VOLUME_KEY, String(this.musicVolume));
    if (this.ctx && this.musicGain && !this.musicMuted) {
      this.musicGain.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.03);
    }
  }
}

/** Module singleton — import from any client component. */
export const sfx = new SfxManager();
