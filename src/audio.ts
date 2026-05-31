// ─── Audio Manager ──────────────────────────────────────────────────────────
// BGM: HTMLAudioElement → MediaElementSourceNode → GainNode → destination
//   Using Web Audio API gain (not el.volume) so iOS Safari volume control works.
//   Falls back to first-gesture unlock if browser blocks autoplay.
// SFX: synthesized (Web Audio API oscillators)

const F = {
  A3: 220.00, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, B5: 987.77,
  _: 0,
};

const FADE_OUT_MS  = 450;
const FADE_IN_MS   = 900;
const MENU_BGM_VOL = 0.44;
const GAME_BGM_VOL = 0.48;
const MASTER_SFX   = 0.88;

class AudioManager {
  // ── Web Audio API (SFX + BGM volume control) ──────────────────────────────
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain:    GainNode | null = null;

  // ── HTMLAudioElement BGM ───────────────────────────────────────────────────
  private menuAudio: HTMLAudioElement | null = null;
  private gameAudio: HTMLAudioElement | null = null;

  // GainNodes for BGM volume (iOS-safe, replaces el.volume) ─────────────────
  private _menuGain: GainNode | null = null;
  private _gameGain: GainNode | null = null;

  // ── Fade intervals ─────────────────────────────────────────────────────────
  private _menuFadeIv: ReturnType<typeof setInterval> | null = null;
  private _gameFadeIv: ReturnType<typeof setInterval> | null = null;

  // Fade progress: 0 = silent, 1 = full base volume.
  // Kept separate from user scale so setBgmVolume() takes effect instantly
  // even while a fade animation is running.
  private _menuFadeProgress = 0;
  private _gameFadeProgress = 0;

  // ── Intent flags ──────────────────────────────────────────────────────────
  private _menuPlaying = false;
  private _gamePlaying = false;

  // ── Volume / mute ──────────────────────────────────────────────────────────
  private _bgmVolScale = 1;
  private _sfxVolScale = 1;
  private _bgmMuted = false;
  private _sfxMuted = false;

  // Compute the effective gain value for the current state.
  private _menuEffGain(): number {
    return this._bgmMuted ? 0 : this._menuFadeProgress * MENU_BGM_VOL * this._bgmVolScale;
  }
  private _gameEffGain(): number {
    return this._bgmMuted ? 0 : this._gameFadeProgress * GAME_BGM_VOL * this._bgmVolScale;
  }

  // Apply computed gain.  Uses GainNode (iOS-safe) when available;
  // falls back to el.volume on browsers that don't support MediaElementSource.
  private _applyMenuVol() {
    const v = this._menuEffGain();
    if (this._menuGain)       this._menuGain.gain.value = v;
    else if (this.menuAudio)  this.menuAudio.volume     = v;
  }
  private _applyGameVol() {
    const v = this._gameEffGain();
    if (this._gameGain)       this._gameGain.gain.value = v;
    else if (this.gameAudio)  this.gameAudio.volume     = v;
  }

  // Wire up MediaElementSourceNode → GainNode → ctx.destination.
  // Must be called inside a user-gesture callback so the AudioContext can start.
  // Safe to call multiple times; creates the chain only once per element.
  private _ensureMenuGain() {
    if (this._menuGain || !this.menuAudio) return;
    try {
      const ctx = this.initCtx();
      const src = ctx.createMediaElementSource(this.menuAudio);
      this._menuGain = ctx.createGain();
      this._menuGain.gain.value = 0;
      src.connect(this._menuGain);
      this._menuGain.connect(ctx.destination);
    } catch { /* fallback: el.volume is used in _applyMenuVol */ }
  }
  private _ensureGameGain() {
    if (this._gameGain || !this.gameAudio) return;
    try {
      const ctx = this.initCtx();
      const src = ctx.createMediaElementSource(this.gameAudio);
      this._gameGain = ctx.createGain();
      this._gameGain.gain.value = 0;
      src.connect(this._gameGain);
      this._gameGain.connect(ctx.destination);
    } catch { /* fallback: el.volume is used in _applyGameVol */ }
  }

  setBgmVolume(v: number) {
    this._bgmVolScale = Math.max(0, Math.min(1, v));
    this._applyMenuVol();
    this._applyGameVol();
  }

  setSfxVolume(v: number) {
    this._sfxVolScale = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.value = this._sfxMuted ? 0 : 0.55 * this._sfxVolScale;
  }

  setBgmMuted(v: boolean) {
    this._bgmMuted = v;
    this._applyMenuVol();
    this._applyGameVol();
  }

  setSfxMuted(v: boolean) {
    this._sfxMuted = v;
    if (this.sfxGain) this.sfxGain.gain.value = v ? 0 : 0.55 * this._sfxVolScale;
  }

  // ── Autoplay unlock (fallback for browsers that block HTMLAudioElement) ────
  private _pendingPlay: (() => void) | null = null;
  private _unlockListenersAdded = false;

  private _setupUnlockListeners() {
    if (this._unlockListenersAdded) return;
    this._unlockListenersAdded = true;
    const events = ['click', 'keydown', 'touchstart', 'pointerdown'];
    const tryUnlock = () => {
      if (!this._pendingPlay) {
        events.forEach(e => document.removeEventListener(e, tryUnlock, true));
        return;
      }
      const fn = this._pendingPlay;
      this._pendingPlay = null;
      events.forEach(e => document.removeEventListener(e, tryUnlock, true));
      fn();
    };
    events.forEach(e => document.addEventListener(e, tryUnlock, { capture: true }));
  }

  private _enabled = true;
  get enabled() { return this._enabled; }

  // ── Web Audio bootstrap ───────────────────────────────────────────────────
  private initCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctx() as AudioContext;
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = MASTER_SFX;
      this.masterGain.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this._sfxMuted ? 0 : 0.55 * this._sfxVolScale;
      this.sfxGain.connect(this.masterGain);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // ── HTMLAudioElement helpers ───────────────────────────────────────────────
  private _getMenuAudio(): HTMLAudioElement {
    if (!this.menuAudio) {
      this.menuAudio = new Audio('/menu-bgm.mp3');
      this.menuAudio.loop = true;
      this.menuAudio.volume = 0;
    }
    return this.menuAudio;
  }

  private _getGameAudio(): HTMLAudioElement {
    if (!this.gameAudio) {
      this.gameAudio = new Audio('/game-bgm.mp3');
      this.gameAudio.loop = true;
      this.gameAudio.volume = 0;
    }
    return this.gameAudio;
  }

  private _clearFade(which: 'menu' | 'game') {
    if (which === 'menu' && this._menuFadeIv !== null) {
      clearInterval(this._menuFadeIv); this._menuFadeIv = null;
    }
    if (which === 'game' && this._gameFadeIv !== null) {
      clearInterval(this._gameFadeIv); this._gameFadeIv = null;
    }
  }

  // Animate fade progress (0–1) over durationMs.
  // Volume is recomputed each tick via _applyMenuVol / _applyGameVol,
  // so live _bgmVolScale changes (slider drag) are reflected immediately.
  private _fadeProgress(
    which: 'menu' | 'game',
    targetProgress: number,
    durationMs: number,
    onDone?: () => void,
  ) {
    this._clearFade(which);
    const startP = which === 'menu' ? this._menuFadeProgress : this._gameFadeProgress;
    const diff   = targetProgress - startP;

    const setP = (p: number) => {
      if (which === 'menu') { this._menuFadeProgress = p; this._applyMenuVol(); }
      else                  { this._gameFadeProgress = p; this._applyGameVol(); }
    };

    if (Math.abs(diff) < 0.001) { setP(targetProgress); onDone?.(); return; }

    const steps = Math.max(1, Math.round(durationMs / 16));
    let step = 0;
    const iv = setInterval(() => {
      step++;
      setP(Math.max(0, Math.min(1, startP + diff * (step / steps))));
      if (step >= steps) {
        clearInterval(iv);
        if (which === 'menu') this._menuFadeIv = null;
        else                  this._gameFadeIv = null;
        onDone?.();
      }
    }, durationMs / steps);
    if (which === 'menu') this._menuFadeIv = iv;
    else                  this._gameFadeIv = iv;
  }

  private _playWithAutoplay(el: HTMLAudioElement, which: 'menu' | 'game', onStart: () => void) {
    // Reset progress to 0 (silent) before starting
    if (which === 'menu') { this._menuFadeProgress = 0; this._applyMenuVol(); }
    else                  { this._gameFadeProgress = 0; this._applyGameVol(); }

    el.play().then(() => {
      // On desktop autoplay success: wire up gain chain now
      if (which === 'menu') this._ensureMenuGain();
      else                  this._ensureGameGain();
      onStart();
    }).catch(() => {
      // Autoplay blocked (common on mobile): defer to first user gesture
      this._pendingPlay = () => {
        // We are now inside a user-gesture handler — safe to create AudioContext
        if (which === 'menu') this._ensureMenuGain();
        else                  this._ensureGameGain();
        el.play().then(onStart).catch(() => {});
      };
      this._setupUnlockListeners();
    });
  }

  // ── Public: call on app mount to create Audio elements early ──────────────
  setupAutoplay() {
    this._getMenuAudio();
    this._getGameAudio();
    this._setupUnlockListeners();
  }

  preload() {}

  // ── Public BGM API ────────────────────────────────────────────────────────
  startMenuBGM() {
    if (!this._enabled) return;
    if (this._menuPlaying) return;

    this._gamePlaying = false;
    this._clearFade('game');
    const gameEl = this._getGameAudio();
    this._fadeProgress('game', 0, FADE_OUT_MS, () => {
      gameEl.pause();
      gameEl.currentTime = 0;
    });

    this._menuPlaying = true;
    const menuEl = this._getMenuAudio();
    this._clearFade('menu');

    if (!menuEl.paused) {
      this._fadeProgress('menu', 1, FADE_IN_MS);
      return;
    }

    this._playWithAutoplay(menuEl, 'menu', () => {
      if (!this._menuPlaying) { menuEl.pause(); return; }
      this._fadeProgress('menu', 1, FADE_IN_MS);
    });
  }

  startGameBGM() {
    if (!this._enabled) return;
    if (this._gamePlaying) return;

    this._menuPlaying = false;
    this._clearFade('menu');
    const menuEl = this._getMenuAudio();
    this._fadeProgress('menu', 0, FADE_OUT_MS, () => {
      menuEl.pause();
      menuEl.currentTime = 0;
    });

    this._gamePlaying = true;
    const gameEl = this._getGameAudio();
    this._clearFade('game');

    if (!gameEl.paused) {
      this._fadeProgress('game', 1, FADE_IN_MS);
      return;
    }

    this._playWithAutoplay(gameEl, 'game', () => {
      if (!this._gamePlaying) { gameEl.pause(); return; }
      this._fadeProgress('game', 1, FADE_IN_MS);
    });
  }

  stopBGM() {
    this._menuPlaying = false;
    this._gamePlaying = false;
    this._pendingPlay = null;

    const menuEl = this._getMenuAudio();
    this._fadeProgress('menu', 0, FADE_OUT_MS, () => {
      menuEl.pause();
      menuEl.currentTime = 0;
    });
    const gameEl = this._getGameAudio();
    this._fadeProgress('game', 0, FADE_OUT_MS, () => {
      gameEl.pause();
      gameEl.currentTime = 0;
    });
  }

  // ── Low-level tone helper (SFX) ───────────────────────────────────────────
  private tone(
    freq: number, dur: number, vol: number,
    type: OscillatorType = 'sine',
    dest: AudioNode | null = null,
    startAt?: number,
  ) {
    const ctx  = this.initCtx();
    const now  = startAt ?? ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const atk = Math.min(0.012, dur * 0.12);
    const rel = Math.min(dur * 0.45, 0.18);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + atk);
    gain.gain.setValueAtTime(vol, now + dur - rel);
    gain.gain.linearRampToValueAtTime(0, now + dur);
    osc.connect(gain);
    gain.connect(dest ?? this.sfxGain!);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  private noiseBurst(dur: number, vol: number) {
    const ctx = this.initCtx();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    const bpf  = ctx.createBiquadFilter();
    bpf.type = 'bandpass'; bpf.frequency.value = 280; bpf.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(bpf); bpf.connect(gain); gain.connect(this.sfxGain!);
    src.start();
  }

  // ── SFX ───────────────────────────────────────────────────────────────────
  playClick() {
    if (!this._enabled) return;
    this.tone(1100, 0.038, 0.055, 'sine', null, this.initCtx().currentTime);
  }

  playMove() {
    if (!this._enabled) return;
    this.tone(540, 0.032, 0.042, 'sine');
  }

  playRotate() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.linearRampToValueAtTime(960, now + 0.07);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.07, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain); gain.connect(this.sfxGain!);
    osc.start(now); osc.stop(now + 0.1);
  }

  playSoftDrop() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(360, now);
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.055);
    gain.gain.setValueAtTime(0.038, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(gain); gain.connect(this.sfxGain!);
    osc.start(now); osc.stop(now + 0.06);
  }

  playHardDrop() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(480, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    osc.connect(gain); gain.connect(this.sfxGain!);
    osc.start(now); osc.stop(now + 0.12);
    this.noiseBurst(0.09, 0.04);
  }

  playLineClear(lines: number) {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const arps =
      lines >= 4 ? [F.C5, F.E5, F.G5, F.C5 * 2, F.E5 * 2] :
      lines === 3 ? [F.C5, F.E5, F.G5, F.C5 * 2] :
      lines === 2 ? [F.C5, F.E5, F.G5] : [F.C5, F.E5];
    arps.forEach((freq, i) => {
      const t = now + i * 0.055;
      this.tone(freq, 0.22, 0.16, 'sine', null, t);
      this.tone(freq * 2, 0.14, 0.04, 'sine', null, t);
    });
    if (lines >= 4) {
      const src = ctx.createOscillator(), g = ctx.createGain();
      src.type = 'sawtooth';
      src.frequency.setValueAtTime(200, now);
      src.frequency.exponentialRampToValueAtTime(1600, now + 0.35);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.06, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      src.connect(g); g.connect(this.sfxGain!);
      src.start(now); src.stop(now + 0.42);
    }
  }

  playLevelUp() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    [F.G4, F.B4, F.D5, F.G5].forEach((freq, i) =>
      this.tone(freq, 0.18, 0.12, 'triangle', null, now + i * 0.07));
  }

  playGameOver() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    [F.A4, F.G4, F.F4, F.E4, F.D4, F.C4].forEach((freq, i) =>
      this.tone(freq, 0.38, 0.18, 'triangle', null, now + i * 0.2));
    this.tone(F.A3 * 0.5, 1.4, 0.06, 'sine', null, now + 0.6);
  }

  playVictory() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    [F.C4, F.E4, F.G4, F.C5, F.E5, F.G5].forEach((freq, i) =>
      this.tone(freq, 0.42, 0.18, 'triangle', null, now + i * 0.13));
    [F.C5, F.E5, F.G5].forEach((freq) =>
      this.tone(freq, 1.4, 0.13, 'sine', null, now + 0.85));
    const sw = ctx.createOscillator(), swG = ctx.createGain();
    sw.type = 'sawtooth';
    sw.frequency.setValueAtTime(F.C4 * 0.5, now);
    sw.frequency.exponentialRampToValueAtTime(F.G5 * 2, now + 0.85);
    swG.gain.setValueAtTime(0, now);
    swG.gain.linearRampToValueAtTime(0.07, now + 0.03);
    swG.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    sw.connect(swG); swG.connect(this.sfxGain!);
    sw.start(now); sw.stop(now + 0.92);
  }

  playHold() {
    if (!this._enabled) return;
    this.tone(F.C5, 0.07, 0.055, 'sine');
    this.tone(F.G4, 0.07, 0.03,  'sine');
  }

  playCountdownBeep(step: 3 | 2 | 1) {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const pitches = { 3: F.A4, 2: F.C5, 1: F.E5 };
    const freq = pitches[step];

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.18);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(gain); gain.connect(this.sfxGain!);
    osc.start(now); osc.stop(now + 0.24);

    const sub = ctx.createOscillator();
    const subG = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq * 0.25, now);
    sub.frequency.exponentialRampToValueAtTime(freq * 0.12, now + 0.14);
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(0.28, now + 0.004);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    sub.connect(subG); subG.connect(this.sfxGain!);
    sub.start(now); sub.stop(now + 0.2);

    const bufLen = Math.floor(ctx.sampleRate * 0.06);
    const nBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const nd = nBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) nd[i] = (Math.random() * 2 - 1);
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = 2400;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.14, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    nSrc.connect(hpf); hpf.connect(nGain); nGain.connect(this.sfxGain!);
    nSrc.start(now);
  }

  playCountdownGo() {
    if (!this._enabled) return;
    const ctx = this.initCtx(), now = ctx.currentTime;
    const notes = [F.C5, F.E5, F.G5, F.C5 * 2];
    notes.forEach((freq, i) => {
      const t = now + i * 0.048;
      this.tone(freq, 0.25, 0.22, 'sine', null, t);
      this.tone(freq * 2, 0.12, 0.06, 'triangle', null, t);
    });
    const sw = ctx.createOscillator(), swG = ctx.createGain();
    sw.type = 'sawtooth';
    sw.frequency.setValueAtTime(F.C5 * 0.5, now);
    sw.frequency.exponentialRampToValueAtTime(F.C5 * 4, now + 0.28);
    swG.gain.setValueAtTime(0, now);
    swG.gain.linearRampToValueAtTime(0.09, now + 0.02);
    swG.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    sw.connect(swG); swG.connect(this.sfxGain!);
    sw.start(now); sw.stop(now + 0.34);
  }

  // ── Mute ──────────────────────────────────────────────────────────────────
  setEnabled(v: boolean) {
    this._enabled = v;
    if (!v) this.stopBGM();
  }
}

export const audio = new AudioManager();
