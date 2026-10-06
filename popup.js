(function () {
  'use strict';

  var AUTO_DISCOVER_KEY = 'config::autoDiscover'; // global (all sites), default off
  var SHORTCUT_KEY = 'config::shortcut';          // global; { ctrl, meta, alt, shift, key } | unset

  function heuristicDefault(paramName) {
    var numeric = /^(id|count|page|num|number|qty|quantity)$/i.test(paramName)
      || /(id|count|num|number)$/i.test(paramName);
    return numeric ? '0' : 'test';
  }

  // ---- Global auto-discovery toggle ----
  var autoToggle = document.getElementById('autoDiscover');
  var paramsSection = document.getElementById('paramsSection');

  function applyAutoState(on) {
    autoToggle.checked = on;
    // Param config only makes sense for discovered routes with :params. In visited-only mode the
    // stored routes are concrete URLs, so hide the whole section.
    paramsSection.style.display = on ? '' : 'none';
  }

  chrome.storage.local.get([AUTO_DISCOVER_KEY], function (r) {
    applyAutoState(r[AUTO_DISCOVER_KEY] === true); // default OFF when unset
  });
  autoToggle.addEventListener('change', function () {
    var o = {}; o[AUTO_DISCOVER_KEY] = autoToggle.checked;
    chrome.storage.local.set(o);
    applyAutoState(autoToggle.checked);
  });

  // ---- Configurable open shortcut ----
  var shortcutBtn = document.getElementById('shortcutBtn');
  var shortcutHelp = document.getElementById('shortcutHelp');
  var resetShortcut = document.getElementById('resetShortcut');
  var HELP_TEXT = 'Click to change.';
  var recording = false;

  function keysFor(sc) {
    if (!sc) return ['Ctrl / ⌘', 'K'];
    var parts = [];
    if (sc.ctrl) parts.push('Ctrl');
    if (sc.meta) parts.push('⌘');
    if (sc.alt) parts.push('Alt');
    if (sc.shift) parts.push('Shift');
    parts.push((sc.key || '').length === 1 ? sc.key.toUpperCase() : sc.key);
    return parts;
  }

  function showKeys(keys) {
    shortcutBtn.textContent = '';
    keys.forEach(function (k, i) {
      if (i) {
        var plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = '+';
        shortcutBtn.appendChild(plus);
      }
      var kbd = document.createElement('kbd');
      kbd.textContent = k;
      shortcutBtn.appendChild(kbd);
    });
  }

  function setHelp(text, isError) {
    shortcutHelp.textContent = text;
    shortcutHelp.classList.toggle('error', !!isError);
  }

  function showShortcut(sc) {
    showKeys(keysFor(sc));
    resetShortcut.hidden = !sc;
  }

  function stopRecording() {
    recording = false;
    shortcutBtn.classList.remove('recording');
    setHelp(HELP_TEXT);
    chrome.storage.local.get([SHORTCUT_KEY], function (r) { showShortcut(r[SHORTCUT_KEY] || null); });
  }
  stopRecording();

  shortcutBtn.addEventListener('click', function () {
    recording = true;
    shortcutBtn.classList.add('recording');
    shortcutBtn.textContent = 'Press a key combo…';
    setHelp('Esc cancels.');
  });
  shortcutBtn.addEventListener('blur', function () { if (recording) stopRecording(); });

  shortcutBtn.addEventListener('keydown', function (e) {
    if (!recording) return;
    e.preventDefault();
    var k = e.key;
    if (k === 'Escape') { stopRecording(); return; }
    // Wait for a non-modifier key to complete the combo.
    if (['Control', 'Meta', 'Alt', 'Shift'].indexOf(k) !== -1) return;
    // A bare key (or Shift+key) would fire while typing in non-input widgets and clash with
    // sites' own single-key shortcuts; function keys are safe on their own.
    if (!(e.ctrlKey || e.metaKey || e.altKey) && !/^F\d{1,2}$/.test(k)) {
      setHelp('Needs Ctrl, Alt or ⌘.', true);
      return;
    }
    var sc = { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, key: k.length === 1 ? k.toLowerCase() : k };
    var o = {}; o[SHORTCUT_KEY] = sc;
    chrome.storage.local.set(o, stopRecording);
  });

  resetShortcut.addEventListener('click', function () {
    chrome.storage.local.remove(SHORTCUT_KEY, stopRecording);
    shortcutBtn.focus();
  });

  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    var content = document.getElementById('content');

    var url = null;
    try { url = new URL(tab.url); } catch (e) { /* no tab, or a page whose URL we can't read */ }
    // Browser pages (new tab, chrome://, file://) never get the content script, so nothing to configure.
    if (!url || !/^https?:$/.test(url.protocol)) {
      content.innerHTML = '<div class="empty">Open a website to configure its route params.</div>';
      return;
    }
    var origin = url.origin;

    var originEl = document.createElement('div');
    originEl.className = 'origin';
    originEl.textContent = url.host;
    originEl.title = origin;
    content.appendChild(originEl);

    var routeKey = 'routecache::' + origin;
    var paramKey = 'params::' + origin;

    chrome.storage.local.get([routeKey, paramKey], function (result) {
      var cache = result[routeKey];
      var savedParams = result[paramKey] || {};

      function showEmpty(text) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = text;
        content.appendChild(empty);
      }

      if (!cache || !cache.routes || !cache.routes.length) {
        showEmpty('No routes discovered yet. Open the palette on this site first.');
        return;
      }

      var paramNames = Array.from(new Set(
        cache.routes.reduce(function (acc, r) { return acc.concat(r.params || []); }, [])
      )).sort();

      if (!paramNames.length) {
        showEmpty('This site\'s routes have no path params to configure.');
        return;
      }

      var caption = document.createElement('div');
      caption.className = 'caption';
      caption.textContent = 'Values used to fill :params when you jump to a route. Defaults are guessed from the name.';
      content.appendChild(caption);

      paramNames.forEach(function (name) {
        var row = document.createElement('div');
        row.className = 'row';

        var input = document.createElement('input');
        input.id = 'param-' + name;
        input.value = savedParams[name] !== undefined ? savedParams[name] : heuristicDefault(name);

        var label = document.createElement('label');
        label.htmlFor = input.id;
        label.textContent = ':' + name;

        var saved = document.createElement('span');
        saved.className = 'saved';
        saved.setAttribute('aria-live', 'polite');

        var savedTimer;
        input.addEventListener('change', function () {
          savedParams[name] = input.value;
          var toSave = {};
          toSave[paramKey] = savedParams;
          chrome.storage.local.set(toSave, function () {
            saved.textContent = '✓ Saved';
            clearTimeout(savedTimer);
            savedTimer = setTimeout(function () { saved.textContent = ''; }, 1500);
          });
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(saved);
        content.appendChild(row);
      });
    });
  });
})();
