/**
 * ArcadeSound — AgeeArcade shared procedural sound engine
 *
 * Include once per page:
 *   <script src="/engine/sound/engine.js"></script>
 *
 * Then call:
 *   await ArcadeSound.init();
 *   ArcadeSound.play('swing');
 *   ArcadeSound.footstep('stone');
 *   ArcadeSound.startAmbient('lofi_dungeon');
 *   ArcadeSound.startEnvironment('fire');
 */
window.ArcadeSound = (() => {
  'use strict';

  // Detect script base so worklet URLs resolve regardless of which game loads this
  const _base = (() => {
    const s = document.querySelector('script[src*="sound/engine"]');
    if (s) return s.src.replace(/engine\.js(\?.*)?$/, '');
    return '/engine/sound/';
  })();

  /* ─────────────────────────────────────────────────────
     AudioContext
  ───────────────────────────────────────────────────── */
  let _ctx         = null;
  let _masterGain  = null;
  let _musicBusGain = null;
  let _sfxGain     = null;
  let _initPromise = null;
  const _volume = { master: 0.7, music: 1, sfx: 1 };
  let _compressor = null;
  let _eqLow = null;
  let _eqMid = null;
  let _eqHigh = null;
  let _listener = null; // Listener for spatial audio

  function _clampVolume(level) {
    const n = Number(level);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function _applyGain(gainNode, level) {
    if (!gainNode || !_ctx) return;
    const value = _clampVolume(level);
    try {
      gainNode.gain.setTargetAtTime(value, _ctx.currentTime, 0.05);
    } catch (_) {
      gainNode.gain.value = value;
    }
  }

  function _applyVolumes() {
    _applyGain(_masterGain, _volume.master);
    _applyGain(_musicBusGain, _volume.music);
    _applyGain(_sfxGain, _volume.sfx);
  }

  function _getCtx() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _masterGain = _ctx.createGain();
      _musicBusGain = _ctx.createGain();
      _sfxGain = _ctx.createGain();
      _masterGain.gain.value = _volume.master;
      _musicBusGain.gain.value = _volume.music;
      _sfxGain.gain.value = _volume.sfx;

      // Professional mixing chain with compression and EQ
      _compressor = _ctx.createDynamicsCompressor();
      _compressor.threshold.value = -50;
      _compressor.knee.value = 40;
      _compressor.ratio.value = 4;
      _compressor.attack.value = 0.003;
      _compressor.release.value = 0.25;

      _eqLow = _ctx.createBiquadFilter();
      _eqLow.type = 'lowshelf';
      _eqLow.frequency.value = 200;
      _eqLow.gain.value = 0;

      _eqMid = _ctx.createBiquadFilter();
      _eqMid.type = 'peaking';
      _eqMid.frequency.value = 1000;
      _eqMid.Q.value = 0.5;
      _eqMid.gain.value = 0;

      _eqHigh = _ctx.createBiquadFilter();
      _eqHigh.type = 'highshelf';
      _eqHigh.frequency.value = 8000;
      _eqHigh.gain.value = 0;

      // Signal flow: buses -> compression -> EQ -> master -> destination
      _musicBusGain.connect(_compressor);
      _sfxGain.connect(_compressor);
      _compressor.connect(_eqLow);
      _eqLow.connect(_eqMid);
      _eqMid.connect(_eqHigh);
      _eqHigh.connect(_masterGain);
      _masterGain.connect(_ctx.destination);

      // Spatial audio setup (listener at origin, facing forward)
      _listener = _ctx.listener;
      _listener.positionX.value = 0;
      _listener.positionY.value = 0;
      _listener.positionZ.value = 0;
      _listener.forwardX.value = 0;
      _listener.forwardY.value = 0;
      _listener.forwardZ.value = -1;
      _listener.upX.value = 0;
      _listener.upY.value = 1;
      _listener.upZ.value = 0;
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  /* ─────────────────────────────────────────────────────
     Worklets
  ───────────────────────────────────────────────────── */
  let _workletsLoaded = false;
  let _footstepNode   = null;
  let _envNode        = null;
  const _footstepConfigs = {};

  async function _loadWorklets() {
    if (_workletsLoaded) return;
    const c = _getCtx();
    if (!c || !c.audioWorklet) {
      console.warn('[ArcadeSound] AudioWorklets unavailable (no audioWorklet API)');
      return;
    }
    try {
      await Promise.all([
        c.audioWorklet.addModule(_base + 'worklets/footstep.js'),
        c.audioWorklet.addModule(_base + 'worklets/environment.js'),
      ]);
      _workletsLoaded = true;

      _footstepNode = new AudioWorkletNode(c, 'arcade-footstep');
      _footstepNode.connect(_sfxGain);
      Object.entries(_footstepConfigs).forEach(([material, params]) => {
        _footstepNode.port.postMessage({ config: { material, params } });
      });

      _envNode = new AudioWorkletNode(c, 'arcade-environment', {
        parameterData: { intensity: 0 },
      });
      _envNode.connect(_sfxGain);
    } catch (e) {
      console.warn('[ArcadeSound] Failed to load worklets:', e.message);
    }
  }

  /* ─────────────────────────────────────────────────────
     SFX — OfflineAudioContext pre-render with advanced synthesis
  ───────────────────────────────────────────────────── */
  const _sfxBuffers = {};
  const _sfxRendering = {};
  let _sfxPreloadStarted = false;

  function _osc(offCtx, type, freq, t0, t1, freqEnd, gPeak, gEnd) {
    const g = offCtx.createGain();
    g.connect(offCtx.destination);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gPeak, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gEnd), t1);
    g.gain.setValueAtTime(0, t1 + 0.001);
    const o = offCtx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t1);
    o.connect(g);
    o.start(t0);
    o.stop(t1 + 0.01);
  }

  function _noise(offCtx, noiseBuf, dur, gPeak, gEnd, fFreq, fType) {
    const src = offCtx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = offCtx.createBiquadFilter();
    filt.type      = fType || 'bandpass';
    filt.frequency.value = fFreq || 800;
    filt.Q.value   = 1.2;
    const g = offCtx.createGain();
    g.gain.setValueAtTime(gPeak, 0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gEnd), dur);
    src.connect(filt); filt.connect(g); g.connect(offCtx.destination);
    src.start(0); src.stop(dur);
  }

  // Physical modeling: create resonant decay from impulse
  function _resonance(offCtx, noiseBuf, freq, qFactor, dur, gain, decay) {
    // Noise impact (initial strike texture)
    const noise = offCtx.createBufferSource();
    noise.buffer = noiseBuf;

    const noiseFilt = offCtx.createBiquadFilter();
    noiseFilt.type = 'bandpass';
    noiseFilt.frequency.value = freq;
    noiseFilt.Q.value = qFactor * 0.8;

    const noiseGain = offCtx.createGain();
    noiseGain.gain.setValueAtTime(gain * 0.4, 0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, 0.08);

    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(offCtx.destination);

    noise.start(0);
    noise.stop(0.08);

    // Tonal resonance (sustaining ring)
    const osc = offCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const filt = offCtx.createBiquadFilter();
    filt.type = 'peaking';
    filt.frequency.value = freq;
    filt.Q.value = qFactor;
    filt.gain.value = 3.5;

    const oscGain = offCtx.createGain();
    oscGain.gain.setValueAtTime(0, 0);
    oscGain.gain.linearRampToValueAtTime(gain * 0.6, 0.02);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, decay);

    osc.connect(filt);
    filt.connect(oscGain);
    oscGain.connect(offCtx.destination);

    osc.start(0);
    osc.stop(decay + 0.01);
  }

  // Physical modeling: struck plate with multiple resonances
  function _plate(offCtx, noiseBuf, dur, fundamentalFreq) {
    // Noise impact for texture
    const noise = offCtx.createBufferSource();
    noise.buffer = noiseBuf;

    const noiseFilt = offCtx.createBiquadFilter();
    noiseFilt.type = 'bandpass';
    noiseFilt.frequency.value = fundamentalFreq * 2;
    noiseFilt.Q.value = 0.6;

    const noiseGain = offCtx.createGain();
    noiseGain.gain.setValueAtTime(0.25, 0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, 0.12);

    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(offCtx.destination);

    noise.start(0);
    noise.stop(0.12);

    // Multiple resonant modes
    const resonances = [
      { freq: fundamentalFreq, q: 8, gain: 0.30, decay: dur },
      { freq: fundamentalFreq * 1.5, q: 6.5, gain: 0.20, decay: dur * 0.75 },
      { freq: fundamentalFreq * 2.3, q: 5.5, gain: 0.14, decay: dur * 0.55 },
      { freq: fundamentalFreq * 3.6, q: 4.5, gain: 0.09, decay: dur * 0.35 },
    ];

    resonances.forEach(r => {
      const osc = offCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = r.freq;

      const filt = offCtx.createBiquadFilter();
      filt.type = 'peaking';
      filt.frequency.value = r.freq;
      filt.Q.value = r.q;
      filt.gain.value = 3;

      const g = offCtx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(r.gain, 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, r.decay);

      osc.connect(filt);
      filt.connect(g);
      g.connect(offCtx.destination);

      osc.start(0);
      osc.stop(r.decay + 0.01);
    });
  }

  // Physical modeling: hollow resonant body (drum, chamber)
  function _chamber(offCtx, noiseBuf, dur, pitchHz, decay) {
    // Noise impact for strike texture
    const noise = offCtx.createBufferSource();
    noise.buffer = noiseBuf;

    const noiseFilt = offCtx.createBiquadFilter();
    noiseFilt.type = 'bandpass';
    noiseFilt.frequency.value = pitchHz * 1.5;
    noiseFilt.Q.value = 0.5;

    const noiseGain = offCtx.createGain();
    noiseGain.gain.setValueAtTime(0.20, 0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, 0.15);

    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(offCtx.destination);

    noise.start(0);
    noise.stop(0.15);

    // Primary resonance (fundamental)
    const osc1 = offCtx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = pitchHz;

    const filt1 = offCtx.createBiquadFilter();
    filt1.type = 'peaking';
    filt1.frequency.value = pitchHz;
    filt1.Q.value = 6.5;
    filt1.gain.value = 3.5;

    const gain1 = offCtx.createGain();
    gain1.gain.setValueAtTime(0, 0);
    gain1.gain.linearRampToValueAtTime(0.32, 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.0001, decay);

    osc1.connect(filt1);
    filt1.connect(gain1);
    gain1.connect(offCtx.destination);

    osc1.start(0);
    osc1.stop(decay + 0.01);

    // Secondary resonance (harmonic)
    const osc2 = offCtx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = pitchHz * 0.67;

    const filt2 = offCtx.createBiquadFilter();
    filt2.type = 'peaking';
    filt2.frequency.value = pitchHz * 0.67;
    filt2.Q.value = 5.5;
    filt2.gain.value = 3;

    const gain2 = offCtx.createGain();
    gain2.gain.setValueAtTime(0, 0);
    gain2.gain.linearRampToValueAtTime(0.18, 0.03);
    gain2.gain.exponentialRampToValueAtTime(0.0001, decay * 0.85);

    osc2.connect(filt2);
    filt2.connect(gain2);
    gain2.connect(offCtx.destination);

    osc2.start(0);
    osc2.stop(decay * 0.85 + 0.01);
  }

  // Material impact synthesis — generates appropriate sound based on material type
  // Materials: 'metal', 'steel', 'glass', 'ceramic', 'wood', 'plastic', 'rubber', 'stone', 'explosive'
  function _impact(offCtx, noiseBuf, material = 'metal', intensity = 1.0, size = 'medium') {
    const materialProps = {
      metal: { modes: [
        { freq: 600, q: 12, amp: 0.35, decay: 1.0 },
        { freq: 1650, q: 10, amp: 0.22, decay: 0.8 },
        { freq: 3300, q: 8, amp: 0.15, decay: 0.6 },
      ], exciter: 0.02, excGain: 0.35 },
      steel: { modes: [
        { freq: 800, q: 13, amp: 0.38, decay: 1.2 },
        { freq: 2200, q: 11, amp: 0.25, decay: 0.95 },
        { freq: 4400, q: 9, amp: 0.17, decay: 0.7 },
      ], exciter: 0.02, excGain: 0.38 },
      glass: { modes: [
        { freq: 1200, q: 14, amp: 0.40, decay: 0.9 },
        { freq: 3400, q: 12, amp: 0.28, decay: 0.7 },
        { freq: 6800, q: 10, amp: 0.15, decay: 0.5 },
      ], exciter: 0.015, excGain: 0.32 },
      ceramic: { modes: [
        { freq: 500, q: 8, amp: 0.32, decay: 0.65 },
        { freq: 1400, q: 6, amp: 0.18, decay: 0.50 },
        { freq: 2800, q: 5, amp: 0.10, decay: 0.35 },
      ], exciter: 0.018, excGain: 0.30 },
      wood: { modes: [
        { freq: 350, q: 5, amp: 0.38, decay: 0.35 },
        { freq: 950, q: 4, amp: 0.22, decay: 0.25 },
        { freq: 1900, q: 3, amp: 0.12, decay: 0.15 },
      ], exciter: 0.020, excGain: 0.32 },
      plastic: { modes: [
        { freq: 400, q: 3, amp: 0.30, decay: 0.25 },
        { freq: 1000, q: 2.5, amp: 0.15, decay: 0.18 },
      ], exciter: 0.015, excGain: 0.28 },
      rubber: { modes: [
        { freq: 250, q: 2, amp: 0.28, decay: 0.20 },
        { freq: 700, q: 1.5, amp: 0.12, decay: 0.12 },
      ], exciter: 0.020, excGain: 0.25 },
      stone: { modes: [
        { freq: 450, q: 7, amp: 0.35, decay: 0.70 },
        { freq: 1250, q: 5, amp: 0.20, decay: 0.55 },
        { freq: 2500, q: 3, amp: 0.10, decay: 0.35 },
      ], exciter: 0.022, excGain: 0.33 },
      explosive: null, // Handled separately below
    };

    const props = materialProps[material] || materialProps.metal;
    const sizeScalar = { small: 0.7, medium: 1.0, large: 1.3 }[size] || 1.0;

    // For explosive material, use _explosion function
    if (material === 'explosive') {
      const depthMap = { small: 100, medium: 80, large: 50 };
      const depth = depthMap[size] || 80;
      return _explosion(offCtx, noiseBuf, 0.5 + sizeScalar * 0.35, depth, intensity);
    }

    // Modal synthesis for resonant materials
    if (props && props.modes) {
      const modes = props.modes.map(m => ({
        freq: m.freq * sizeScalar,
        q: m.q,
        amp: m.amp * intensity,
        decay: m.decay * sizeScalar,
      }));
      _modal(offCtx, noiseBuf, modes, props.exciter, props.excGain * intensity);
    }
  }

  // Advanced modal synthesis with multiple inharmonic modes (van den Doel & Pai)
  // Models struck bars, bells, and complex impact objects
  function _modal(offCtx, noiseBuf, modes, exciterDur = 0.02, exciterGain = 0.3) {
    // Exciter: brief noise impulse that triggers all modes
    const exciter = offCtx.createBufferSource();
    exciter.buffer = noiseBuf;
    const exciterFilt = offCtx.createBiquadFilter();
    exciterFilt.type = 'highpass';
    exciterFilt.frequency.value = 50;
    const exciterGainNode = offCtx.createGain();
    exciterGainNode.gain.setValueAtTime(exciterGain, 0);
    exciterGainNode.gain.exponentialRampToValueAtTime(0.0001, exciterDur);
    exciter.connect(exciterFilt);
    exciterFilt.connect(exciterGainNode);
    exciterGainNode.connect(offCtx.destination);
    exciter.start(0);
    exciter.stop(exciterDur);

    // Each mode: sine oscillator through peaking filter with exponential decay
    modes.forEach(mode => {
      const osc = offCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = mode.freq;

      const filt = offCtx.createBiquadFilter();
      filt.type = 'peaking';
      filt.frequency.value = mode.freq;
      filt.Q.value = mode.q || 8;
      filt.gain.value = 3.5;

      const g = offCtx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(mode.amp || 0.2, 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, mode.decay || 0.5);

      osc.connect(filt);
      filt.connect(g);
      g.connect(offCtx.destination);

      osc.start(0);
      osc.stop((mode.decay || 0.5) + 0.01);
    });
  }

  // Procedural fire: three-layer model (hiss + crackle + lapping)
  function _fire(offCtx, noiseBuf, dur, intensity = 1.0) {
    const SR = offCtx.sampleRate;

    // Layer 1: Hissing (high-pass filtered white noise, AM by smoothed random)
    const hiss = offCtx.createBufferSource();
    hiss.buffer = noiseBuf;
    hiss.loop = true;
    const hissFilt = offCtx.createBiquadFilter();
    hissFilt.type = 'highpass';
    hissFilt.frequency.value = 2000;
    const hissAMOsc = offCtx.createOscillator();
    hissAMOsc.type = 'sine';
    hissAMOsc.frequency.value = 0.8; // Slow modulation
    const hissAMGain = offCtx.createGain();
    hissAMGain.gain.setValueAtTime(0.3, 0);
    const hissGain = offCtx.createGain();
    hissGain.gain.setValueAtTime(0.2 * intensity, 0);
    hissGain.gain.exponentialRampToValueAtTime(0.0001, dur);
    hiss.connect(hissFilt);
    hissFilt.connect(hissGain);
    hissAMOsc.connect(hissAMGain);
    hissAMGain.connect(hissGain.gain);
    hissGain.connect(offCtx.destination);
    hiss.start(0);
    hiss.stop(dur);
    hissAMOsc.start(0);
    hissAMOsc.stop(dur);

    // Layer 2: Crackle (random popping via short enveloped noise grains)
    const crackleCount = Math.floor(dur * 12 * intensity); // ~12 pops/sec
    const crackleGrainLen = 0.025; // 25ms grain
    for (let i = 0; i < crackleCount; i++) {
      const crackleTime = Math.random() * (dur - crackleGrainLen);
      const crackle = offCtx.createBufferSource();
      crackle.buffer = noiseBuf;
      const crackleFilt = offCtx.createBiquadFilter();
      crackleFilt.type = 'bandpass';
      crackleFilt.frequency.value = 300 + Math.random() * 700; // 300-1000 Hz
      crackleFilt.Q.value = 2 + Math.random() * 3;
      const crackleGain = offCtx.createGain();
      crackleGain.gain.setValueAtTime(0.15 * intensity, crackleTime);
      crackleGain.gain.exponentialRampToValueAtTime(0.0001, crackleTime + crackleGrainLen);
      crackle.connect(crackleFilt);
      crackleFilt.connect(crackleGain);
      crackleGain.connect(offCtx.destination);
      crackle.start(crackleTime);
      crackle.stop(crackleTime + crackleGrainLen);
    }

    // Layer 3: Lapping (low-frequency rumble, band-passed noise ~30 Hz)
    const lapping = offCtx.createBufferSource();
    lapping.buffer = noiseBuf;
    lapping.loop = true;
    const lappingFilt = offCtx.createBiquadFilter();
    lappingFilt.type = 'bandpass';
    lappingFilt.frequency.value = 40;
    lappingFilt.Q.value = 0.8;
    const lappingWave = offCtx.createWaveShaper();
    lappingWave.curve = new Float32Array([
      -1, -0.8, -0.4, -0.2, 0, 0.2, 0.4, 0.8, 1
    ]);
    const lappingGain = offCtx.createGain();
    lappingGain.gain.setValueAtTime(0.25 * intensity, 0);
    lappingGain.gain.exponentialRampToValueAtTime(0.0001, dur);
    lapping.connect(lappingFilt);
    lappingFilt.connect(lappingWave);
    lappingWave.connect(lappingGain);
    lappingGain.connect(offCtx.destination);
    lapping.start(0);
    lapping.stop(dur);
  }

  // Explosive impact: multiband noise-based, realistic chaos
  // For cannons, explosions, heavy impacts
  function _explosion(offCtx, noiseBuf, dur, depth = 80, intensity = 1.0) {
    // Layer 1: High-frequency "snap" (white noise burst, 10-20ms)
    const snap = offCtx.createBufferSource();
    snap.buffer = noiseBuf;
    const snapFilt = offCtx.createBiquadFilter();
    snapFilt.type = 'highpass';
    snapFilt.frequency.value = 2500;
    const snapGain = offCtx.createGain();
    snapGain.gain.setValueAtTime(0.45 * intensity, 0);
    snapGain.gain.exponentialRampToValueAtTime(0.02, 0.015);
    snap.connect(snapFilt);
    snapFilt.connect(snapGain);
    snapGain.connect(offCtx.destination);
    snap.start(0);
    snap.stop(0.02);

    // Layer 2: Mid-band "roar" (lowpass noise, fullest part of explosion)
    const roar = offCtx.createBufferSource();
    roar.buffer = noiseBuf;
    roar.loop = true;
    const roarFilt = offCtx.createBiquadFilter();
    roarFilt.type = 'lowpass';
    roarFilt.frequency.setValueAtTime(3000 * intensity, 0);
    roarFilt.frequency.exponentialRampToValueAtTime(800, dur * 0.4);
    const roarGain = offCtx.createGain();
    roarGain.gain.setValueAtTime(0.5 * intensity, 0);
    roarGain.gain.exponentialRampToValueAtTime(0.0001, dur * 0.6);
    roar.connect(roarFilt);
    roarFilt.connect(roarGain);
    roarGain.connect(offCtx.destination);
    roar.start(0);
    roar.stop(dur * 0.6 + 0.01);

    // Layer 3: Deep bass rumble (lowpass-filtered noise, not sinusoidal)
    const bass = offCtx.createBufferSource();
    bass.buffer = noiseBuf;
    bass.loop = true;
    const bassFilt = offCtx.createBiquadFilter();
    bassFilt.type = 'lowpass';
    bassFilt.frequency.value = Math.max(30, depth * 0.5);
    bassFilt.Q.value = 1.5;
    const bassGain = offCtx.createGain();
    bassGain.gain.setValueAtTime(0.4 * intensity, 0);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, dur);
    bass.connect(bassFilt);
    bassFilt.connect(bassGain);
    bassGain.connect(offCtx.destination);
    bass.start(0);
    bass.stop(dur + 0.01);

    // Layer 4: Sub-bass tail (ultra-low filtered noise, carries weight)
    const subBass = offCtx.createBufferSource();
    subBass.buffer = noiseBuf;
    subBass.loop = true;
    const subFilt = offCtx.createBiquadFilter();
    subFilt.type = 'lowpass';
    subFilt.frequency.value = Math.max(15, depth * 0.25);
    subFilt.Q.value = 0.7;
    const subGain = offCtx.createGain();
    subGain.gain.setValueAtTime(0, 0);
    subGain.gain.linearRampToValueAtTime(0.2 * intensity, 0.1);
    subGain.gain.exponentialRampToValueAtTime(0.0001, dur);
    subBass.connect(subFilt);
    subFilt.connect(subGain);
    subGain.connect(offCtx.destination);
    subBass.start(0);
    subBass.stop(dur + 0.01);

    // Layer 5: Mid-range "body" (bandpass, adds character/impact)
    const body = offCtx.createBufferSource();
    body.buffer = noiseBuf;
    body.loop = true;
    const bodyFilt = offCtx.createBiquadFilter();
    bodyFilt.type = 'bandpass';
    bodyFilt.frequency.value = 400;
    bodyFilt.Q.value = 0.6;
    const bodyGain = offCtx.createGain();
    bodyGain.gain.setValueAtTime(0.2 * intensity, 0);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, dur * 0.7);
    body.connect(bodyFilt);
    bodyFilt.connect(bodyGain);
    bodyGain.connect(offCtx.destination);
    body.start(0);
    body.stop(dur * 0.7 + 0.01);
  }

  function _renderSFX(dur, buildFn) {
    const SR  = 44100;
    const len = Math.ceil(SR * dur);
    const off = new OfflineAudioContext(1, len, SR);
    const nb  = off.createBuffer(1, len, SR);
    const nd  = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    buildFn(off, nb);
    return off.startRendering();
  }

  // ── SFX definitions ──────────────────────────────────
  // Physical modeling synthesis: realistic material vibration and resonance
  // Mutable so tuner or registerSFX can add/replace entries
  const _sfxDefs = {
    // Combat — physical plate/material impacts
    swing:        (o, n) => {
      _plate(o, n, 0.28, 280);
    },
    hit:          (o, n) => {
      _plate(o, n, 0.32, 200);
    },
    heavy_hit:    (o, n) => {
      _chamber(o, n, 0.42, 100, 0.42);
      _plate(o, n, 0.30, 150);
    },
    slash:        (o, n) => {
      _noise(o, n, 0.16, 0.32, 0.001, 3500, 'highpass');
      _plate(o, n, 0.22, 400);
    },
    block:        (o, n) => {
      _plate(o, n, 0.28, 280);
      _chamber(o, n, 0.25, 140, 0.28);
    },
    // Character — resonant body impacts
    enemy_death:  (o, n) => {
      _chamber(o, n, 0.40, 150, 0.40);
    },
    player_hurt:  (o, n) => {
      _plate(o, n, 0.28, 350);
    },
    player_death: (o, n) => {
      _chamber(o, n, 0.50, 100, 0.50);
      _plate(o, n, 0.35, 180);
    },
    // UI / Pickups — bright, quick resonances
    level_up:     (o, n) => {
      _resonance(o, n, 780, 7, 0.35, 0.25, 0.35);
      _resonance(o, n, 600, 6, 0.30, 0.18, 0.30);
    },
    coin:         (o, n) => {
      _resonance(o, n, 1200, 8, 0.25, 0.22, 0.25);
      _resonance(o, n, 900, 7, 0.20, 0.15, 0.20);
    },
    pickup:       (o, n) => {
      _resonance(o, n, 900, 7, 0.28, 0.20, 0.28);
    },
    error:        (o, n) => {
      _resonance(o, n, 250, 5, 0.30, 0.24, 0.30);
    },
    // Environment — complex resonant structures
    chest_open:   (o, n) => {
      _chamber(o, n, 0.45, 220, 0.45);
      _resonance(o, n, 130, 6, 0.30, 0.15, 0.30);
    },
    portal:       (o, n) => {
      _resonance(o, n, 500, 8, 0.80, 0.28, 0.80);
      _resonance(o, n, 750, 7, 0.75, 0.20, 0.75);
      _resonance(o, n, 1200, 6, 0.70, 0.15, 0.70);
    },
    door_open:    (o, n) => {
      _chamber(o, n, 0.45, 180, 0.45);
      _plate(o, n, 0.35, 220);
    },
    boss_roar:    (o, n) => {
      _chamber(o, n, 0.85, 120, 0.85);
      _resonance(o, n, 250, 6, 0.70, 0.30, 0.70);
    },
    explosion:    (o, n) => {
      _explosion(o, n, 0.85, 60, 1.0);
    },
    magic:        (o, n) => {
      _resonance(o, n, 1000, 8, 0.75, 0.25, 0.75);
      _resonance(o, n, 1500, 7, 0.70, 0.18, 0.70);
      _noise(o, n, 0.40, 0.12, 0.001, 3500, 'highpass');
    },
    // Maze Runner
    wall_hit:     (o, n) => {
      _plate(o, n, 0.28, 250);
    },
    goal:         (o, n) => {
      _resonance(o, n, 700, 7, 0.35, 0.22, 0.35);
      _resonance(o, n, 1000, 6, 0.32, 0.18, 0.32);
    },
    // Advanced modal synthesis — rich, inharmonic struck objects
    gong:         (o, n) => {
      _modal(o, n, [
        { freq: 400, q: 12, amp: 0.32, decay: 1.2 },
        { freq: 1100, q: 10, amp: 0.22, decay: 0.9 },
        { freq: 2200, q: 8, amp: 0.15, decay: 0.6 },
        { freq: 3600, q: 6, amp: 0.10, decay: 0.4 },
      ], 0.03, 0.4);
    },
    bell:         (o, n) => {
      _modal(o, n, [
        { freq: 800, q: 14, amp: 0.35, decay: 1.5 },
        { freq: 2100, q: 11, amp: 0.25, decay: 1.1 },
        { freq: 4200, q: 9, amp: 0.15, decay: 0.7 },
      ], 0.02, 0.35);
    },
    metal_bar:   (o, n) => {
      // Inharmonic ratios 1.0 : 2.76 : 5.40 : 8.90
      _modal(o, n, [
        { freq: 400, q: 10, amp: 0.40, decay: 1.0 },
        { freq: 1104, q: 9, amp: 0.28, decay: 0.85 },
        { freq: 2160, q: 7, amp: 0.18, decay: 0.60 },
        { freq: 3560, q: 5, amp: 0.12, decay: 0.40 },
      ], 0.025, 0.38);
    },
    wood_bar:    (o, n) => {
      // Fewer modes, lower Q, quick decay (woody)
      _modal(o, n, [
        { freq: 300, q: 5, amp: 0.40, decay: 0.35 },
        { freq: 850, q: 4, amp: 0.25, decay: 0.25 },
        { freq: 1800, q: 3, amp: 0.12, decay: 0.15 },
      ], 0.02, 0.35);
    },
    // Procedural fire
    fire:         (o, n) => {
      _fire(o, n, 0.75, 1.0);
    },
    fire_small:   (o, n) => {
      _fire(o, n, 0.50, 0.6);
    },
    // Weapon explosions (NEW) — aggressive, destructive sounds
    cannon:       (o, n) => {
      _explosion(o, n, 0.90, 80, 1.0);
    },
    cannon_heavy: (o, n) => {
      _explosion(o, n, 1.20, 60, 1.2);
    },
    explosion_large: (o, n) => {
      _explosion(o, n, 1.0, 50, 1.1);
    },
    blast:        (o, n) => {
      _explosion(o, n, 0.70, 100, 0.95);
    },
    impact_heavy: (o, n) => {
      _explosion(o, n, 0.60, 120, 0.9);
    },
    // Material impacts (NEW) — parameterized by material type
    metal_hit:    (o, n) => { _impact(o, n, 'metal', 1.0, 'medium'); },
    steel_clang:  (o, n) => { _impact(o, n, 'steel', 1.1, 'medium'); },
    glass_break:  (o, n) => { _impact(o, n, 'glass', 0.9, 'small'); },
    ceramic_hit:  (o, n) => { _impact(o, n, 'ceramic', 0.8, 'medium'); },
    wood_thud:    (o, n) => { _impact(o, n, 'wood', 0.9, 'large'); },
    plastic_tap:  (o, n) => { _impact(o, n, 'plastic', 0.7, 'small'); },
    rubber_bounce: (o, n) => { _impact(o, n, 'rubber', 0.8, 'medium'); },
    stone_crash:  (o, n) => { _impact(o, n, 'stone', 1.0, 'large'); },
  };

  const _sfxDurations = {
    swing: 0.28, hit: 0.32, heavy_hit: 0.42, slash: 0.22, block: 0.28,
    enemy_death: 0.40, player_hurt: 0.28, player_death: 0.50,
    level_up: 0.35, coin: 0.25, pickup: 0.28, error: 0.30,
    chest_open: 0.45, portal: 0.80, door_open: 0.45, boss_roar: 0.85,
    explosion: 0.85, magic: 0.75, wall_hit: 0.28, goal: 0.35,
    gong: 1.2, bell: 1.5, metal_bar: 1.0, wood_bar: 0.35,
    fire: 0.75, fire_small: 0.50,
    cannon: 0.90, cannon_heavy: 1.20, explosion_large: 1.0, blast: 0.70, impact_heavy: 0.60,
    metal_hit: 0.80, steel_clang: 1.05, glass_break: 0.75, ceramic_hit: 0.65,
    wood_thud: 0.50, plastic_tap: 0.40, rubber_bounce: 0.45, stone_crash: 0.85,
  };

  function _scheduleIdle(fn) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 0);
    }
  }

  function _renderSFXCached(name) {
    if (_sfxBuffers[name]) return Promise.resolve(_sfxBuffers[name]);
    if (_sfxRendering[name]) return _sfxRendering[name];
    if (!_sfxDefs[name]) return Promise.resolve(null);

    _sfxRendering[name] = _renderSFX(_sfxDurations[name] || 0.5, _sfxDefs[name])
      .then(buf => {
        _sfxBuffers[name] = buf;
        return buf;
      })
      .finally(() => {
        delete _sfxRendering[name];
      });
    return _sfxRendering[name];
  }

  function _preloadSFX() {
    if (_sfxPreloadStarted) return;
    _sfxPreloadStarted = true;

    const names = Object.keys(_sfxDefs);
    let i = 0;

    const renderNext = () => {
      if (i >= names.length) return;
      const name = names[i++];
      _renderSFXCached(name).finally(() => _scheduleIdle(renderNext));
    };

    _scheduleIdle(renderNext);
  }

  /* ─────────────────────────────────────────────────────
     Music Scheduler — theme-based
  ───────────────────────────────────────────────────── */
  const THEMES = {
    lofi_dungeon: {
      bpm: 78,
      barsPerChord: 2,
      padType: 'sine',
      melType: 'triangle',
      crackle: true,
      chords: [
        { pad: [261.63,311.13,392.00,466.16,587.33], bass: 130.81, mel: [261.63,311.13,392.00,466.16,587.33,523.25] },
        { pad: [207.65,261.63,311.13,392.00],        bass: 207.65, mel: [207.65,261.63,311.13,392.00,466.16,523.25] },
        { pad: [311.13,392.00,466.16,587.33],        bass: 155.56, mel: [311.13,392.00,466.16,587.33,698.46]        },
        { pad: [233.08,293.66,349.23,415.30],        bass: 110.00, mel: [233.08,293.66,349.23,415.30,523.25,622.25] },
      ],
    },
    upbeat_arcade: {
      bpm: 120,
      barsPerChord: 2,
      padType: 'square',
      melType: 'sine',
      crackle: false,
      chords: [
        { pad: [261.63,329.63,392.00,523.25], bass: 130.81, mel: [261.63,329.63,392.00,523.25,659.25] },
        { pad: [220.00,261.63,329.63,440.00], bass: 110.00, mel: [220.00,261.63,329.63,440.00,523.25] },
        { pad: [174.61,261.63,349.23,523.25], bass: 174.61, mel: [261.63,349.23,523.25,698.46]        },
        { pad: [196.00,246.94,392.00,493.88], bass: 196.00, mel: [246.94,392.00,493.88,587.33]        },
      ],
    },
  };

  let _musicGain    = null;
  let _musicTimer   = null;
  let _chordIdx     = 0;
  let _nextT        = 0;
  let _crackleNode  = null;
  let _activeTheme  = null;

  function _schedPad(theme, chord, t0, dur) {
    const c = _getCtx();
    chord.pad.forEach((freq, i) => {
      [-4, 0, 4].forEach(cents => {
        const o = c.createOscillator();
        o.type = theme.padType || 'sine';
        o.frequency.value = freq * Math.pow(2, (cents + (Math.random()-0.5)*3) / 1200);
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800 - i*120; lp.Q.value = 0.7;
        const g = c.createGain();
        const atk = 0.6 + i*0.08;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.055, t0 + atk);
        g.gain.setValueAtTime(0.055, t0 + dur - 1.2);
        g.gain.linearRampToValueAtTime(0, t0 + dur);
        o.connect(lp); lp.connect(g); g.connect(_musicGain);
        o.start(t0); o.stop(t0 + dur + 0.05);
      });
    });
  }

  function _schedBass(theme, chord, t0) {
    const c   = _getCtx();
    const bar = (60 / theme.bpm) * 4;
    [[chord.bass, 0], [chord.bass*1.5, bar]].forEach(([freq, off]) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      const g = c.createGain();
      const t = t0 + off;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + bar - 0.1);
      o.connect(lp); lp.connect(g); g.connect(_musicGain);
      o.start(t); o.stop(t + bar);
    });
  }

  function _schedMel(theme, chord, t0, dur) {
    const c    = _getCtx();
    const beat = 60 / theme.bpm;
    const n    = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const freq = chord.mel[Math.floor(Math.random() * chord.mel.length)];
      const off  = Math.random() * (dur - beat);
      const len  = beat * (0.4 + Math.random() * 0.6);
      const t    = t0 + off;
      const o = c.createOscillator(); o.type = theme.melType || 'triangle'; o.frequency.value = freq;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(lp); lp.connect(g); g.connect(_musicGain);
      o.start(t); o.stop(t + len + 0.05);
    }
  }

  function _startCrackle(theme = {}) {
    const c = _getCtx();
    const SR = c.sampleRate; const len = SR * 4;
    const buf = c.createBuffer(1, len, SR);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _crackleNode = c.createBufferSource();
    _crackleNode.buffer = buf; _crackleNode.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = c.createGain(); g.gain.value = theme.crackleGain == null ? 0.012 : theme.crackleGain;
    _crackleNode.connect(lp); lp.connect(g); g.connect(_musicGain);
    _crackleNode.start();
  }

  function _scheduleChord() {
    try {
      const c     = _getCtx();
      const theme = _activeTheme;
      const beat  = 60 / theme.bpm;
      const dur   = beat * 4 * theme.barsPerChord;
      const chord = theme.chords[_chordIdx % theme.chords.length];

      _schedPad (theme, chord, _nextT, dur);
      _schedBass(theme, chord, _nextT);
      _schedMel (theme, chord, _nextT, dur);

      _nextT    += dur;
      _chordIdx  = (_chordIdx + 1) % theme.chords.length;

      const delay = (_nextT - c.currentTime - beat) * 1000;
      _musicTimer = setTimeout(_scheduleChord, Math.max(200, delay));
    } catch (e) { console.error('[ArcadeSound] music error', e); }
  }

  /* ─────────────────────────────────────────────────────
     Public API
  ───────────────────────────────────────────────────── */
  async function init(options = {}) {
    const deferWorklets = options.deferWorklets === true;
    const preloadSFX = options.preloadSFX !== false;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      _getCtx();
      const loadWorklets = async () => {
        try {
          await _loadWorklets();
        } catch (e) {
          console.warn('[ArcadeSound] AudioWorklets unavailable; footstep/env disabled.', e.message);
        }
      };
      if (deferWorklets) {
        loadWorklets();
      } else {
        await loadWorklets();
      }
      if (preloadSFX) _preloadSFX();
    })();
    return _initPromise;
  }

  function play(name, options = {}) {
    const buf = _sfxBuffers[name];
    if (!buf) {
      _renderSFXCached(name);
      return;
    }
    try {
      const c = _getCtx();
      const src = c.createBufferSource();
      src.buffer = buf;

      // If spatial position provided, use PannerNode with HRTF
      if (options.x !== undefined || options.y !== undefined || options.z !== undefined) {
        const panner = c.createPanner();
        panner.panningModel = 'HRTF'; // Binaural for headphones
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 50;
        panner.rolloffFactor = 1;
        panner.positionX.value = options.x || 0;
        panner.positionY.value = options.y || 0;
        panner.positionZ.value = options.z || 0;
        src.connect(panner);
        panner.connect(_sfxGain);
      } else {
        src.connect(_sfxGain);
      }

      src.start();
    } catch (_) {}
  }

  // Play a named sound at a 3D position (x, y, z in meters)
  function playSpatial(name, x = 0, y = 0, z = 0) {
    play(name, { x, y, z });
  }

  // Update listener position (player position in 3D space)
  function setListenerPosition(x = 0, y = 0, z = 0) {
    _getCtx();
    if (_listener) {
      _listener.positionX.setTargetAtTime(x, _ctx.currentTime, 0.1);
      _listener.positionY.setTargetAtTime(y, _ctx.currentTime, 0.1);
      _listener.positionZ.setTargetAtTime(z, _ctx.currentTime, 0.1);
    }
  }

  // Update listener orientation (where player is facing)
  function setListenerOrientation(fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0) {
    _getCtx();
    if (_listener) {
      _listener.forwardX.setTargetAtTime(fx, _ctx.currentTime, 0.05);
      _listener.forwardY.setTargetAtTime(fy, _ctx.currentTime, 0.05);
      _listener.forwardZ.setTargetAtTime(fz, _ctx.currentTime, 0.05);
      _listener.upX.setTargetAtTime(ux, _ctx.currentTime, 0.05);
      _listener.upY.setTargetAtTime(uy, _ctx.currentTime, 0.05);
      _listener.upZ.setTargetAtTime(uz, _ctx.currentTime, 0.05);
    }
  }

  function footstep(material = 'stone', intensity = 1.0) {
    if (!_footstepNode) return;
    try {
      _footstepNode.port.postMessage({ trigger: true, material, intensity });
    } catch (e) {
      console.warn('[ArcadeSound] Footstep error:', e.message);
    }
  }

  function registerFootstepMaterial(material, params) {
    if (!material || !params) return;
    _footstepConfigs[material] = { ...(_footstepConfigs[material] || {}), ...params };
    if (_footstepNode) {
      try {
        _footstepNode.port.postMessage({ config: { material, params: _footstepConfigs[material] } });
      } catch (e) {
        console.warn('[ArcadeSound] Register footstep error:', e.message);
      }
    }
  }

  function startEnvironment(type = 'fire', intensity = 1.0) {
    if (!_envNode) return;
    try {
      _envNode.port.postMessage({ type });
      _envNode.parameters.get('intensity').setTargetAtTime(intensity, _getCtx().currentTime, 0.5);
    } catch (e) {
      console.warn('[ArcadeSound] startEnvironment error:', e.message);
    }
  }

  function stopEnvironment() {
    if (!_envNode) return;
    try {
      _envNode.parameters.get('intensity').setTargetAtTime(0, _getCtx().currentTime, 0.8);
    } catch (e) {
      console.warn('[ArcadeSound] stopEnvironment error:', e.message);
    }
  }

  function startAmbient(themeName = 'lofi_dungeon') {
    if (_musicGain) return;
    const theme = THEMES[themeName] || THEMES.lofi_dungeon;
    _activeTheme = theme;
    const c = _getCtx();
    _musicGain = c.createGain();
    _musicGain.connect(_musicBusGain);
    _musicGain.gain.setValueAtTime(0, c.currentTime);
    _musicGain.gain.linearRampToValueAtTime(theme.gain == null ? 0.55 : theme.gain, c.currentTime + 3);
    _chordIdx = 0;
    _nextT    = c.currentTime + 0.2;
    if (theme.crackle) _startCrackle(theme);
    _scheduleChord();
  }

  function stopAmbient() {
    clearTimeout(_musicTimer); _musicTimer = null;
    if (_crackleNode) { try { _crackleNode.stop(); } catch (_) {} _crackleNode = null; }
    if (_musicGain) {
      const c = _getCtx();
      const fadingGain = _musicGain;
      fadingGain.gain.setValueAtTime(fadingGain.gain.value, c.currentTime);
      fadingGain.gain.linearRampToValueAtTime(0, c.currentTime + 2);
      _musicGain = null;
      setTimeout(() => { try { fadingGain.disconnect(); } catch (_) {} }, 2100);
    }
  }

  function setVolume(level) {
    setVolumes({ master: level });
  }

  function setVolumes(levels = {}) {
    if (Object.prototype.hasOwnProperty.call(levels, 'master')) _volume.master = _clampVolume(levels.master);
    if (Object.prototype.hasOwnProperty.call(levels, 'music')) _volume.music = _clampVolume(levels.music);
    if (Object.prototype.hasOwnProperty.call(levels, 'sfx')) _volume.sfx = _clampVolume(levels.sfx);
    _applyVolumes();
  }

  function getVolumes() {
    return { ..._volume };
  }

  function stopAll() {
    stopAmbient();
    stopEnvironment();
    clearTimeout(_musicTimer);
    try { if (_ctx) _ctx.close(); } catch (_) {}
    _ctx = null; _masterGain = null; _musicBusGain = null; _sfxGain = null; _footstepNode = null; _envNode = null;
    _musicGain = null; _crackleNode = null; _compressor = null; _eqLow = null; _eqMid = null; _eqHigh = null;
    _listener = null;
    _workletsLoaded = false;
    _initPromise = null; _sfxPreloadStarted = false;
    for (const k in _sfxBuffers) delete _sfxBuffers[k];
    for (const k in _sfxRendering) delete _sfxRendering[k];
  }

  // Allow games to add or replace SFX definitions at runtime
  function registerSFX(name, duration, buildFn) {
    _sfxDefs[name]     = buildFn;
    _sfxDurations[name] = duration;
    delete _sfxBuffers[name];
    _scheduleIdle(() => { _renderSFXCached(name); });
  }

  // Allow games to register custom music themes
  function registerTheme(name, theme) {
    THEMES[name] = theme;
  }

  // Expose internals needed by the tuner and game-specific sound wrappers
  const _internal = {
    get sfxDefs()      { return _sfxDefs; },
    get sfxDurations() { return _sfxDurations; },
    get themes()       { return THEMES; },
    get footstepNode() { return _footstepNode; },
    get envNode()      { return _envNode; },
    osc:       _osc,
    noise:     _noise,
    renderSFX: _renderSFX,
    impact:    _impact,
    resonance: _resonance,
    plate:     _plate,
    chamber:   _chamber,
    modal:     _modal,
    fire:      _fire,
    explosion: _explosion,
    reloadSFX(name) {
      if (_sfxDefs[name]) {
        _renderSFX(_sfxDurations[name] || 0.5, _sfxDefs[name]).then(buf => { _sfxBuffers[name] = buf; });
      }
    },
    setSFXBuffer(name, buf) { _sfxBuffers[name] = buf; },
  };

  function setEQ(band, gain) {
    _getCtx();
    if (band === 'low' && _eqLow) _eqLow.gain.setTargetAtTime(_clampVolume(gain * 2 - 1), _ctx.currentTime, 0.05);
    if (band === 'mid' && _eqMid) _eqMid.gain.setTargetAtTime(_clampVolume(gain * 2 - 1), _ctx.currentTime, 0.05);
    if (band === 'high' && _eqHigh) _eqHigh.gain.setTargetAtTime(_clampVolume(gain * 2 - 1), _ctx.currentTime, 0.05);
  }

  function getEQ() {
    return {
      low: _eqLow ? (_eqLow.gain.value + 1) / 2 : 0.5,
      mid: _eqMid ? (_eqMid.gain.value + 1) / 2 : 0.5,
      high: _eqHigh ? (_eqHigh.gain.value + 1) / 2 : 0.5,
    };
  }

  return {
    init, play, playSpatial,
    footstep, registerFootstepMaterial,
    startEnvironment, stopEnvironment, startAmbient, stopAmbient,
    setVolume, setVolumes, getVolumes,
    setEQ, getEQ,
    setListenerPosition, setListenerOrientation,
    stopAll, registerSFX, registerTheme, _internal
  };
})();
