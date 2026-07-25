// arcade-environment AudioWorklet processor
// Continuous ambient generation: fire, wind, cave, rain.
// Type and intensity are controllable at runtime via port messages.
'use strict';

// Mutable config per environment type — tuner posts overrides
let _config = {
  fire: { baseNoiseLevel: 0.30, crackleProb: 0.015, crackleGain: 0.80, crackleDecay: 0.92, lpFreq: 4000, hpMix: 0.50 },
  wind: { noiseLevel: 0.25, lfoFreq: 0.30, lfoDepth: 0.40, lfoOffset: 0.60, lpFreq: 800 },
  cave: { noiseLevel: 0.04, lpFreq: 500, dripMinSec: 2, dripMaxSec: 6, dripFreqMin: 800, dripFreqMax: 1200, dripDecay: 0.9995 },
  rain: { noiseLevel: 0.20, lpFreq: 5000 },
};

class EnvironmentProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'intensity', defaultValue: 0, minValue: 0, maxValue: 1 }];
  }

  constructor() {
    super();
    this._type   = 'fire';
    this._lp1    = 0;
    this._lp2    = 0;
    this._grain  = 0;    // fire crackle grain level
    this._lfoP   = 0;    // wind LFO phase
    this._drip   = { t: 0, nextSample: 0, active: false, phase: 0, freq: 1000, env: 0 };

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type)   this._type = d.type;
      if (d.config) Object.assign(_config[d.config.type] || {}, d.config.params);
      if (d.resetConfig) {
        _config = {
          fire: { baseNoiseLevel: 0.30, crackleProb: 0.015, crackleGain: 0.80, crackleDecay: 0.92, lpFreq: 4000, hpMix: 0.50 },
          wind: { noiseLevel: 0.25, lfoFreq: 0.30, lfoDepth: 0.40, lfoOffset: 0.60, lpFreq: 800 },
          cave: { noiseLevel: 0.04, lpFreq: 500, dripMinSec: 2, dripMaxSec: 6, dripFreqMin: 800, dripFreqMax: 1200, dripDecay: 0.9995 },
          rain: { noiseLevel: 0.20, lpFreq: 5000 },
        };
      }
    };
  }

  _fire(intensity) {
    const c = _config.fire;
    let noise = (Math.random() * 2 - 1) * intensity * c.baseNoiseLevel;
    if (Math.random() < c.crackleProb * intensity) this._grain = c.crackleGain * intensity;
    noise += this._grain;
    this._grain *= c.crackleDecay;
    const a1 = Math.min(1, (2 * Math.PI * c.lpFreq) / sampleRate);
    this._lp1 += a1 * (noise - this._lp1);
    const a2 = Math.min(1, (2 * Math.PI * (c.lpFreq * 0.25)) / sampleRate);
    this._lp2 += a2 * (this._lp1 - this._lp2);
    return this._lp1 - this._lp2 * c.hpMix;
  }

  _wind(intensity) {
    const c = _config.wind;
    this._lfoP += (2 * Math.PI * c.lfoFreq) / sampleRate;
    const lfo = (Math.sin(this._lfoP) * c.lfoDepth + c.lfoOffset) * intensity;
    const noise = (Math.random() * 2 - 1) * c.noiseLevel * lfo;
    const alpha = Math.min(1, (2 * Math.PI * c.lpFreq) / sampleRate);
    this._lp1 += alpha * (noise - this._lp1);
    return this._lp1;
  }

  _cave(intensity) {
    const c = _config.cave;
    const noise = (Math.random() * 2 - 1) * c.noiseLevel * intensity;
    const alpha = Math.min(1, (2 * Math.PI * c.lpFreq) / sampleRate);
    this._lp1 += alpha * (noise - this._lp1);
    let sample = this._lp1;

    const d = this._drip;
    d.t++;
    if (d.t >= d.nextSample) {
      d.active = true;
      d.t = 0;
      d.nextSample = Math.floor((c.dripMinSec + Math.random() * (c.dripMaxSec - c.dripMinSec)) * sampleRate);
      d.phase = 0;
      d.freq  = c.dripFreqMin + Math.random() * (c.dripFreqMax - c.dripFreqMin);
      d.env   = 0.3 * intensity;
    }
    if (d.active) {
      d.phase += (2 * Math.PI * d.freq) / sampleRate;
      d.env   *= c.dripDecay;
      sample  += Math.sin(d.phase) * d.env;
      if (d.env < 0.001) d.active = false;
    }
    return sample;
  }

  _rain(intensity) {
    const c = _config.rain;
    const noise = (Math.random() * 2 - 1) * c.noiseLevel * intensity;
    const alpha = Math.min(1, (2 * Math.PI * c.lpFreq) / sampleRate);
    this._lp1 += alpha * (noise - this._lp1);
    return this._lp1;
  }

  process(_inputs, outputs, params) {
    const out       = outputs[0];
    const intensity = params.intensity[0];

    for (let i = 0; i < out[0].length; i++) {
      let s = 0;
      switch (this._type) {
        case 'fire': s = this._fire(intensity); break;
        case 'wind': s = this._wind(intensity); break;
        case 'cave': s = this._cave(intensity); break;
        case 'rain': s = this._rain(intensity); break;
      }
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = s;
    }
    return true;
  }
}

registerProcessor('arcade-environment', EnvironmentProcessor);
