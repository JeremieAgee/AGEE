/**
 * ArcadeSoundSettings - shared player-facing volume controls.
 *
 * Include after /engine/sound/engine.js on any game page.
 */
window.ArcadeSoundSettings = (() => {
  'use strict';

  const STORAGE_KEY = 'ageeArcade.soundVolumes';
  const DEFAULTS = { master: 0.7, music: 1, sfx: 1 };
  const LABELS = {
    master: 'Master',
    music: 'Music',
    sfx: 'Sound FX',
  };

  let _mounted = false;
  let _open = false;
  let _values = load();
  const _inputs = {};
  const _outputs = {};

  function clamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        master: clamp(parsed.master ?? DEFAULTS.master),
        music: clamp(parsed.music ?? DEFAULTS.music),
        sfx: clamp(parsed.sfx ?? DEFAULTS.sfx),
      };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    } catch (_) {}
  }

  function apply() {
    window.ArcadeSound?.setVolumes?.(_values);
  }

  function percent(value) {
    return Math.round(clamp(value) * 100) + '%';
  }

  function renderSlider(key) {
    const row = document.createElement('label');
    row.className = 'arcade-sound-row';
    row.htmlFor = 'arcade-sound-' + key;

    const top = document.createElement('span');
    top.className = 'arcade-sound-row-top';

    const name = document.createElement('span');
    name.textContent = LABELS[key];

    const value = document.createElement('span');
    value.className = 'arcade-sound-value';
    value.textContent = percent(_values[key]);
    _outputs[key] = value;

    top.append(name, value);

    const input = document.createElement('input');
    input.id = 'arcade-sound-' + key;
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(_values[key]);
    input.addEventListener('input', () => {
      _values[key] = clamp(input.value);
      _outputs[key].textContent = percent(_values[key]);
      save();
      apply();
    });
    _inputs[key] = input;

    row.append(top, input);
    return row;
  }

  function setOpen(open) {
    _open = Boolean(open);
    const panel = document.getElementById('arcade-sound-panel');
    const button = document.getElementById('arcade-sound-toggle');
    if (!panel || !button) return;
    panel.hidden = !_open;
    button.setAttribute('aria-expanded', String(_open));
  }

  function injectStyles() {
    if (document.getElementById('arcade-sound-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'arcade-sound-settings-style';
    style.textContent = `
      .arcade-sound-settings {
        position: fixed;
        left: 14px;
        bottom: 14px;
        z-index: 650;
        font-family: Inter, Arial, sans-serif;
        color: #f4f7ff;
      }
      .arcade-sound-toggle {
        width: 44px;
        height: 44px;
        border-radius: 8px;
        border: 1px solid rgba(180, 198, 255, 0.36);
        background: rgba(8, 10, 18, 0.78);
        color: #f4f7ff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.8px;
        line-height: 1;
        cursor: pointer;
        backdrop-filter: blur(6px);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
      }
      .arcade-sound-toggle:hover,
      .arcade-sound-toggle:focus-visible {
        border-color: rgba(244, 247, 255, 0.72);
        outline: none;
      }
      .arcade-sound-panel {
        position: absolute;
        left: 0;
        bottom: 54px;
        width: min(280px, calc(100vw - 28px));
        padding: 14px;
        border-radius: 8px;
        border: 1px solid rgba(180, 198, 255, 0.32);
        background: rgba(8, 10, 18, 0.94);
        box-shadow: 0 20px 70px rgba(0, 0, 0, 0.48);
        backdrop-filter: blur(8px);
      }
      .arcade-sound-title {
        margin: 0 0 12px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 1.6px;
        text-transform: uppercase;
        color: #f4f7ff;
      }
      .arcade-sound-row {
        display: block;
        margin-top: 12px;
      }
      .arcade-sound-row-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 7px;
        font-size: 12px;
        color: #b8c3df;
      }
      .arcade-sound-value {
        min-width: 40px;
        text-align: right;
        color: #f4f7ff;
        font-variant-numeric: tabular-nums;
      }
      .arcade-sound-row input {
        width: 100%;
        accent-color: #5ca8ff;
      }
      @media (max-width: 640px) {
        .arcade-sound-settings {
          left: 14px;
          bottom: 14px;
        }
        .arcade-sound-toggle {
          width: 42px;
          height: 42px;
        }
        .arcade-sound-panel {
          left: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function mount() {
    if (_mounted || !document.body) return;
    _mounted = true;
    injectStyles();
    apply();

    const root = document.createElement('div');
    root.className = 'arcade-sound-settings';

    const button = document.createElement('button');
    button.id = 'arcade-sound-toggle';
    button.className = 'arcade-sound-toggle';
    button.type = 'button';
    button.textContent = 'VOL';
    button.title = 'Sound settings';
    button.setAttribute('aria-label', 'Sound settings');
    button.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.id = 'arcade-sound-panel';
    panel.className = 'arcade-sound-panel';
    panel.hidden = true;

    const title = document.createElement('h2');
    title.className = 'arcade-sound-title';
    title.textContent = 'Sound';

    panel.append(title, renderSlider('master'), renderSlider('music'), renderSlider('sfx'));
    root.append(button, panel);
    document.body.appendChild(root);

    root.addEventListener('pointerdown', event => event.stopPropagation());
    root.addEventListener('click', event => event.stopPropagation());
    root.addEventListener('keydown', event => event.stopPropagation());
    button.addEventListener('click', () => setOpen(!_open));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setOpen(false);
    });
    document.addEventListener('pointerdown', event => {
      if (_open && !root.contains(event.target)) setOpen(false);
    });
  }

  function setVolumes(values = {}) {
    ['master', 'music', 'sfx'].forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(values, key)) return;
      _values[key] = clamp(values[key]);
      if (_inputs[key]) _inputs[key].value = String(_values[key]);
      if (_outputs[key]) _outputs[key].textContent = percent(_values[key]);
    });
    save();
    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  return { mount, setVolumes, getVolumes: () => ({ ..._values }) };
})();
