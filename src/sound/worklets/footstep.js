// arcade-footstep AudioWorklet processor
// Triggered per step; generates heel + toe noise bursts shaped by material.
'use strict';

const MATERIALS = {
  stone: { freq: 460,  Q: 0.8, heelGain: 0.24, toeGain: 0.08, decayMs: 120, toeDelayMs: 72,  filter: 'lowpass', thumpFreq: 105, thumpGain: 0.075 },
  wood:  { freq:  800, Q: 2.0, heelGain: 0.48, toeGain: 0.28, decayMs: 120, toeDelayMs: 70,  filter: 'bandpass', thumpFreq: 135, thumpGain: 0.10 },
  dirt:  { freq:  320, Q: 1.0, heelGain: 0.36, toeGain: 0.18, decayMs: 125, toeDelayMs: 58,  filter: 'lowpass', thumpFreq: 80,  thumpGain: 0.12 },
  metal: { freq: 3000, Q: 8.0, heelGain: 0.68, toeGain: 0.42, decayMs: 200, toeDelayMs: 80,  filter: 'highpass', thumpFreq: 160, thumpGain: 0.04 },
  grass: { freq:  260, Q: 1.0, heelGain: 0.22, toeGain: 0.12, decayMs: 95,  toeDelayMs: 55,  filter: 'lowpass', thumpFreq: 70,  thumpGain: 0.08 },
  water: { freq:  600, Q: 1.5, heelGain: 0.32, toeGain: 0.26, decayMs: 160, toeDelayMs: 95,  filter: 'lowpass', thumpFreq: 65,  thumpGain: 0.06 },
};

// Default mutable config — tuner posts overrides via port
let _config = JSON.parse(JSON.stringify(MATERIALS));

class FootstepProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bursts = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.trigger) {
        const mat = _config[d.material] || _config.stone;
        const intensity = d.intensity != null ? d.intensity : 1.0;
        const jitter = 1 + (Math.random() - 0.5) * 0.15;
        this._addBurst(mat, mat.heelGain * intensity * jitter, 0,            mat.decayMs);
        this._addBurst(mat, mat.toeGain  * intensity * jitter, mat.toeDelayMs, mat.decayMs * 0.7);
      }
      if (d.config) {
        // Tuner override: { material: 'stone', params: { freq, Q, heelGain, ... } }
        const material = d.config.material || 'stone';
        if (!_config[material]) _config[material] = { ..._config.stone };
        Object.assign(_config[material], d.config.params);
      }
      if (d.resetConfig) {
        _config = JSON.parse(JSON.stringify(MATERIALS));
      }
    };
  }

  _addBurst(mat, gain, delayMs, decayMs) {
    this._bursts.push({
      t:            0,
      startAt:      Math.floor(delayMs  * sampleRate / 1000),
      totalSamples: Math.floor((delayMs + decayMs * 4) * sampleRate / 1000),
      gain,
      decaySamples: decayMs * sampleRate / 1000,
      filterFreq:   mat.freq * (1 + (Math.random() - 0.5) * 0.2),
      Q:            mat.Q,
      filterType:   mat.filter,
      lp:           0,
      bp:           0,
      hp:           0,
      phase:        0,
      thumpFreq:    (mat.thumpFreq || 0) * (1 + (Math.random() - 0.5) * 0.08),
      thumpGain:    mat.thumpGain || 0,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this._bursts.length) return true;

    for (let i = 0; i < out[0].length; i++) {
      let sample = 0;
      for (const b of this._bursts) {
        if (b.t >= b.startAt && b.t < b.totalSamples) {
          const elapsed = b.t - b.startAt;
          const env = Math.exp(-elapsed / b.decaySamples);
          let s = (Math.random() * 2 - 1) * b.gain * env;
          const alpha = Math.min(1, (2 * Math.PI * b.filterFreq) / sampleRate);
          b.lp += alpha * (s - b.lp);
          if (b.filterType === 'highpass') {
            s = s - b.lp;
          } else if (b.filterType === 'bandpass') {
            b.hp = s - b.lp;
            b.bp += Math.min(1, alpha * Math.max(0.25, b.Q || 1)) * (b.hp - b.bp);
            s = b.bp;
          } else {
            s = b.lp;
          }
          if (b.thumpGain > 0 && b.thumpFreq > 0) {
            b.phase += (2 * Math.PI * b.thumpFreq) / sampleRate;
            s += Math.sin(b.phase) * b.thumpGain * env;
          }
          sample += s;
        }
        b.t++;
      }
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = sample;
    }

    this._bursts = this._bursts.filter(b => b.t < b.totalSamples);
    return true;
  }
}

registerProcessor('arcade-footstep', FootstepProcessor);
