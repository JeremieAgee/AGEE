/**
 * ArcadeSound Tuner — admin-only real-time sound tuning panel.
 *
 * Activates when user._meta === 'admin' (checked against window.currentUser,
 * window.user, or any global you pass via ArcadeSoundTuner.setUser(userObj)).
 *
 * Include AFTER engine.js:
 *   <script src="/engine/sound/tuner.js"></script>
 *
 * Opens with:  ArcadeSoundTuner.open()   (auto-called when admin detected)
 * Closes with: ArcadeSoundTuner.close()
 */
window.ArcadeSoundTuner = (() => {
  'use strict';

  /* ── Auth check ─────────────────────────────────────── */
  let _user = null;

  function _isAdmin() {
    const u = _user || window.currentUser || window.user;
    return u && u._meta === 'admin';
  }

  /* ── State ──────────────────────────────────────────── */
  let _panel     = null;
  let _activeTab = 'sfx';
  let _gameName  = document.title || 'Game';

  // Per-session tuned overrides stored here so Export can dump them
  const _overrides = { sfx: {}, footstep: {}, environment: {} };

  /* ── Helpers ────────────────────────────────────────── */
  function _el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.forEach(c => {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    });
    return e;
  }

  function _slider(label, value, min, max, step, onChange) {
    const id  = 'ast-' + Math.random().toString(36).slice(2);
    const val = _el('span', { style: { minWidth: '42px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, String(value));
    const inp = _el('input', { type: 'range', id, min, max, step, value,
      style: { flex: '1', accentColor: '#7c6ef7', margin: '0 8px' },
      oninput: (e) => { val.textContent = Number(e.target.value).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0); onChange(Number(e.target.value)); },
    });
    return _el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', margin: '4px 0' } },
      _el('label', { for: id, style: { width: '130px', fontSize: '11px', color: '#bbb', flexShrink: '0' } }, label),
      inp, val,
    );
  }

  function _btn(label, onClick, color = '#444') {
    return _el('button', {
      style: { padding: '4px 10px', background: color, color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', margin: '2px' },
      onclick: onClick,
    }, label);
  }

  function _section(title, ...children) {
    return _el('div', { style: { marginBottom: '12px' } },
      _el('div', { style: { fontSize: '11px', fontWeight: 'bold', color: '#9d8ff7', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, title),
      ...children,
    );
  }

  /* ── SFX tab ─────────────────────────────────────────── */
  function _buildSFXTab() {
    const engine = window.ArcadeSound;
    if (!engine) return _el('div', {}, 'ArcadeSound not loaded.');

    const sfxNames = Object.keys(engine._internal.sfxDefs);

    // Pick selector
    let _selected = sfxNames[0];

    const playBtn = _btn('▶ Play', () => engine.play(_selected), '#5a4ecf');

    const nameList = _el('select', {
      style: { background: '#2a2a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 6px', width: '100%', marginBottom: '8px' },
      onchange: (e) => { _selected = e.target.value; },
    }, ...sfxNames.map(n => _el('option', { value: n }, n)));

    const regenBtn = _btn('↺ Re-render', () => {
      engine._internal.reloadSFX(_selected);
      setTimeout(() => engine.play(_selected), 150);
    }, '#3a5a3a');

    const note = _el('div', { style: { fontSize: '10px', color: '#888', marginTop: '6px' } },
      'SFX are synthesized from code definitions. Re-render applies after definition changes.'
    );

    // Volume multiplier (per-play gain via a test GainNode)
    let _testVol = 1.0;
    const volSlider = _slider('Test volume', 1.0, 0, 1, 0.01, v => { _testVol = v; });

    return _el('div', {},
      _section('Select & Play', nameList,
        _el('div', { style: { display: 'flex', gap: '6px' } }, playBtn, regenBtn),
      ),
      _section('Test Volume', volSlider),
      note,
    );
  }

  /* ── Footstep tab ──────────────────────────────────── */
  const _FOOTSTEP_MATERIALS = ['stone', 'wood', 'dirt', 'metal', 'grass', 'water'];
  const _FOOTSTEP_DEFAULTS = {
    stone: { freq:  850, Q: 1.4, heelGain: 0.50, toeGain: 0.22, decayMs: 105, toeDelayMs: 65 },
    wood:  { freq:  800, Q: 2.0, heelGain: 0.70, toeGain: 0.50, decayMs: 120, toeDelayMs: 70 },
    dirt:  { freq:  400, Q: 1.2, heelGain: 0.60, toeGain: 0.30, decayMs: 100, toeDelayMs: 55 },
    metal: { freq: 3000, Q: 8.0, heelGain: 0.90, toeGain: 0.60, decayMs: 200, toeDelayMs: 80 },
    grass: { freq:  300, Q: 1.0, heelGain: 0.30, toeGain: 0.20, decayMs: 80,  toeDelayMs: 50 },
    water: { freq:  600, Q: 1.5, heelGain: 0.50, toeGain: 0.40, decayMs: 150, toeDelayMs: 90 },
  };

  function _sendFootstepConfig(material, params) {
    const fn = window.ArcadeSound?._internal?.footstepNode;
    if (fn) fn.port.postMessage({ config: { material, params } });
    if (!_overrides.footstep[material]) _overrides.footstep[material] = {};
    Object.assign(_overrides.footstep[material], params);
  }

  function _buildFootstepTab() {
    let _mat = _FOOTSTEP_MATERIALS[0];
    const params = { ..._FOOTSTEP_DEFAULTS[_mat] };

    const sliderArea = _el('div', {});

    function _rebuildSliders() {
      sliderArea.innerHTML = '';
      const def = _FOOTSTEP_DEFAULTS[_mat];
      const cur = { ...def, ...(_overrides.footstep[_mat] || {}) };

      const specs = [
        ['Filter freq (Hz)', 'freq',       100, 6000, 10],
        ['Filter Q',         'Q',          0.5, 20,   0.1],
        ['Heel gain',        'heelGain',   0,   1,    0.01],
        ['Toe gain',         'toeGain',    0,   1,    0.01],
        ['Decay (ms)',       'decayMs',    10,  500,  5],
        ['Toe delay (ms)',   'toeDelayMs', 10,  200,  5],
      ];
      specs.forEach(([label, key, mn, mx, step]) => {
        sliderArea.appendChild(_slider(label, cur[key], mn, mx, step, v => {
          _sendFootstepConfig(_mat, { [key]: v });
        }));
      });
    }
    _rebuildSliders();

    const matSelect = _el('select', {
      style: { background: '#2a2a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 6px', width: '100%', marginBottom: '8px' },
      onchange: (e) => { _mat = e.target.value; _rebuildSliders(); },
    }, ..._FOOTSTEP_MATERIALS.map(m => _el('option', { value: m }, m)));

    const testBtn = _btn('▶ Test step', () => window.ArcadeSound?.footstep(_mat), '#5a4ecf');
    const resetBtn = _btn('Reset', () => {
      const fn = window.ArcadeSound?._internal?.footstepNode;
      if (fn) fn.port.postMessage({ resetConfig: true });
      delete _overrides.footstep[_mat];
      _rebuildSliders();
    }, '#6a3a3a');

    return _el('div', {},
      _section('Material', matSelect, _el('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } }, testBtn, resetBtn)),
      _section('Parameters', sliderArea),
    );
  }

  /* ── Environment tab ────────────────────────────────── */
  const _ENV_TYPES = ['fire', 'wind', 'cave', 'rain'];
  const _ENV_DEFAULTS = {
    fire: { baseNoiseLevel: 0.30, crackleProb: 0.015, crackleGain: 0.80, crackleDecay: 0.92, lpFreq: 4000, hpMix: 0.50 },
    wind: { noiseLevel: 0.25, lfoFreq: 0.30, lfoDepth: 0.40, lfoOffset: 0.60, lpFreq: 800 },
    cave: { noiseLevel: 0.04, lpFreq: 500, dripMinSec: 2, dripMaxSec: 6, dripFreqMin: 800, dripFreqMax: 1200, dripDecay: 0.9995 },
    rain: { noiseLevel: 0.20, lpFreq: 5000 },
  };
  const _ENV_SPECS = {
    fire: [['Base noise level','baseNoiseLevel',0,1,0.01],['Crackle prob','crackleProb',0,0.1,0.001],['Crackle gain','crackleGain',0,1,0.01],['Crackle decay','crackleDecay',0.5,0.999,0.001],['LP freq (Hz)','lpFreq',500,15000,50],['HP mix','hpMix',0,1,0.01]],
    wind: [['Noise level','noiseLevel',0,1,0.01],['LFO freq (Hz)','lfoFreq',0.05,5,0.05],['LFO depth','lfoDepth',0,1,0.01],['LFO offset','lfoOffset',0,1,0.01],['LP freq (Hz)','lpFreq',200,8000,50]],
    cave: [['Noise level','noiseLevel',0,0.2,0.001],['LP freq (Hz)','lpFreq',100,3000,50],['Drip min (s)','dripMinSec',0.5,10,0.5],['Drip max (s)','dripMaxSec',1,20,0.5],['Drip freq min','dripFreqMin',200,2000,50],['Drip freq max','dripFreqMax',500,4000,50],['Drip decay','dripDecay',0.99,0.9999,0.0001]],
    rain: [['Noise level','noiseLevel',0,0.5,0.01],['LP freq (Hz)','lpFreq',1000,20000,100]],
  };

  function _sendEnvConfig(type, params) {
    const en = window.ArcadeSound?._internal?.envNode;
    if (en) en.port.postMessage({ config: { type, params } });
    if (!_overrides.environment[type]) _overrides.environment[type] = {};
    Object.assign(_overrides.environment[type], params);
  }

  function _buildEnvTab() {
    let _type   = 'fire';
    let _active = false;

    const sliderArea = _el('div', {});

    function _rebuildSliders() {
      sliderArea.innerHTML = '';
      const specs = _ENV_SPECS[_type] || [];
      const cur   = { ..._ENV_DEFAULTS[_type], ...(_overrides.environment[_type] || {}) };
      specs.forEach(([label, key, mn, mx, step]) => {
        sliderArea.appendChild(_slider(label, cur[key], mn, mx, step, v => {
          _sendEnvConfig(_type, { [key]: v });
        }));
      });
    }
    _rebuildSliders();

    const typeSelect = _el('select', {
      style: { background: '#2a2a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 6px', width: '100%', marginBottom: '8px' },
      onchange: (e) => { _type = e.target.value; _rebuildSliders(); },
    }, ..._ENV_TYPES.map(t => _el('option', { value: t }, t)));

    const intensitySlider = _slider('Intensity', 1.0, 0, 1, 0.01, v => {
      if (_active) {
        const en = window.ArcadeSound?._internal?.envNode;
        if (en) en.parameters.get('intensity').setTargetAtTime(v, window.ArcadeSound._internal.envNode.context.currentTime, 0.1);
      }
    });

    const startBtn = _btn('▶ Start', () => {
      window.ArcadeSound?.startEnvironment(_type);
      _active = true;
    }, '#3a5a3a');
    const stopBtn = _btn('■ Stop', () => {
      window.ArcadeSound?.stopEnvironment();
      _active = false;
    }, '#6a3a3a');
    const resetBtn = _btn('Reset', () => {
      const en = window.ArcadeSound?._internal?.envNode;
      if (en) en.port.postMessage({ resetConfig: true });
      delete _overrides.environment[_type];
      _rebuildSliders();
    }, '#555');

    return _el('div', {},
      _section('Type & Control', typeSelect,
        _el('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } }, startBtn, stopBtn, resetBtn),
        intensitySlider,
      ),
      _section('Parameters', sliderArea),
    );
  }

  /* ── Music tab ──────────────────────────────────────── */
  function _buildMusicTab() {
    const themes = Object.keys(window.ArcadeSound?._internal?.themes || {});
    let _theme   = themes[0] || 'lofi_dungeon';

    const themeSelect = _el('select', {
      style: { background: '#2a2a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 6px', width: '100%', marginBottom: '8px' },
      onchange: (e) => { _theme = e.target.value; },
    }, ...themes.map(t => _el('option', { value: t }, t)));

    const startBtn = _btn('▶ Start', () => window.ArcadeSound?.startAmbient(_theme), '#3a5a3a');
    const stopBtn  = _btn('■ Stop',  () => window.ArcadeSound?.stopAmbient(),         '#6a3a3a');

    const volSlider = _slider('Music volume', 0.55, 0, 1, 0.01, v => {
      // Direct override of music gain if accessible; else use master
      window.ArcadeSound?.setVolume(v);
    });

    const masterSlider = _slider('Master volume', 0.7, 0, 1, 0.01, v => {
      window.ArcadeSound?.setVolume(v);
    });

    return _el('div', {},
      _section('Theme', themeSelect,
        _el('div', { style: { display: 'flex', gap: '6px' } }, startBtn, stopBtn),
      ),
      _section('Volume', masterSlider),
    );
  }

  /* ── Export tab ─────────────────────────────────────── */
  function _buildExportTab() {
    const area = _el('textarea', {
      style: { width: '100%', height: '180px', background: '#1a1a2a', color: '#9df', border: '1px solid #555', borderRadius: '4px', fontFamily: 'monospace', fontSize: '11px', padding: '8px', boxSizing: 'border-box', resize: 'vertical' },
      readonly: 'true',
    });

    const refreshBtn = _btn('Generate export', () => {
      const out = {
        game: _gameName,
        exportedAt: new Date().toISOString(),
        overrides: _overrides,
      };
      area.value = JSON.stringify(out, null, 2);
    }, '#5a4ecf');

    const copyBtn = _btn('Copy', () => {
      navigator.clipboard.writeText(area.value).catch(() => {});
    }, '#3a5a3a');

    const note = _el('div', { style: { fontSize: '10px', color: '#888', marginTop: '8px' } },
      'Paste these overrides into your game\'s sound config to persist tuning between sessions.'
    );

    return _el('div', {},
      _section('Export tuning overrides',
        _el('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } }, refreshBtn, copyBtn),
        area,
        note,
      ),
    );
  }

  /* ── Panel shell ────────────────────────────────────── */
  const TABS = ['sfx', 'footstep', 'environment', 'music', 'export'];

  function _buildPanel() {
    const content = _el('div', { style: { padding: '8px' } });
    let _drag = null;

    function _showTab(tab) {
      _activeTab = tab;
      content.innerHTML = '';
      tabBtns.forEach(b => b.style.background = b.dataset.tab === tab ? '#5a4ecf' : '#333');
      switch (tab) {
        case 'sfx':         content.appendChild(_buildSFXTab());         break;
        case 'footstep':    content.appendChild(_buildFootstepTab());    break;
        case 'environment': content.appendChild(_buildEnvTab());         break;
        case 'music':       content.appendChild(_buildMusicTab());       break;
        case 'export':      content.appendChild(_buildExportTab());      break;
      }
    }

    const tabBtns = TABS.map(tab =>
      _el('button', {
        'data-tab': tab,
        style: { padding: '4px 10px', background: tab === _activeTab ? '#5a4ecf' : '#333', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '11px', borderRadius: '3px' },
        onclick: () => _showTab(tab),
      }, tab)
    );

    const tabBar = _el('div', { style: { display: 'flex', gap: '4px', padding: '6px 8px', background: '#1a1a2a', borderBottom: '1px solid #333', flexWrap: 'wrap' } }, ...tabBtns);

    const header = _el('div', {
      style: { background: '#111', padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'grab', borderBottom: '1px solid #333', borderRadius: '8px 8px 0 0' },
    },
      _el('span', { style: { fontWeight: 'bold', fontSize: '12px', color: '#9d8ff7' } }, '🎛 Sound Tuner — ' + _gameName),
      _btn('✕', () => close(), '#333'),
    );

    const panel = _el('div', {
      id: 'arcade-sound-tuner',
      style: {
        position: 'fixed', top: '20px', right: '20px', width: '340px',
        background: '#222', color: '#eee', fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px', border: '1px solid #444', zIndex: '999999',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      },
    }, header, tabBar, _el('div', { style: { overflowY: 'auto', flex: '1' } }, content));

    // Draggable
    header.addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      _drag = { ox: e.clientX - r.left, oy: e.clientY - r.top };
      header.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', (e) => {
      if (!_drag) return;
      panel.style.right = 'auto';
      panel.style.left  = (e.clientX - _drag.ox) + 'px';
      panel.style.top   = (e.clientY - _drag.oy) + 'px';
    });
    document.addEventListener('mouseup', () => { _drag = null; if (header) header.style.cursor = 'grab'; });

    _showTab(_activeTab);
    return panel;
  }

  /* ── Public ─────────────────────────────────────────── */
  function open() {
    if (!_isAdmin()) { console.warn('[ArcadeSoundTuner] admin access required (user._meta === "admin")'); return; }
    if (_panel) return;
    _panel = _buildPanel();
    document.body.appendChild(_panel);
  }

  function close() {
    if (_panel) { _panel.remove(); _panel = null; }
  }

  function setUser(u) { _user = u; }
  function setGame(name) { _gameName = name; }

  // Auto-open when admin is already present at script load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (_isAdmin()) open(); });
  } else {
    if (_isAdmin()) open();
  }

  return { open, close, setUser, setGame };
})();
