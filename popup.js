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
  var resetShortcut = document.getElementById('resetShortcut');
  var recording = false;

  function labelFor(sc) {
    if (!sc) return 'Default (Ctrl / ⌘ + K)';
    var parts = [];
    if (sc.ctrl) parts.push('Ctrl');
    if (sc.meta) parts.push('⌘');
    if (sc.alt) parts.push('Alt');
    if (sc.shift) parts.push('Shift');
    parts.push((sc.key || '').length === 1 ? sc.key.toUpperCase() : sc.key);
    return parts.join(' + ');
  }

  function renderShortcut() {
    chrome.storage.local.get([SHORTCUT_KEY], function (r) {
      shortcutBtn.textContent = labelFor(r[SHORTCUT_KEY] || null);
    });
  }
  renderShortcut();

  shortcutBtn.addEventListener('click', function () {
    recording = true;
    shortcutBtn.classList.add('recording');
    shortcutBtn.textContent = 'Press a key combo…';
  });

  shortcutBtn.addEventListener('keydown', function (e) {
    if (!recording) return;
    e.preventDefault();
    var k = e.key;
    if (k === 'Escape') { recording = false; shortcutBtn.classList.remove('recording'); renderShortcut(); return; }
    // Wait for a non-modifier key to complete the combo.
    if (['Control', 'Meta', 'Alt', 'Shift'].indexOf(k) !== -1) return;
    var sc = { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, key: k.length === 1 ? k.toLowerCase() : k };
    var o = {}; o[SHORTCUT_KEY] = sc;
    chrome.storage.local.set(o, function () {
      recording = false;
      shortcutBtn.classList.remove('recording');
      shortcutBtn.textContent = labelFor(sc);
    });
  });

  resetShortcut.addEventListener('click', function () {
    chrome.storage.local.remove(SHORTCUT_KEY, function () {
      recording = false;
      shortcutBtn.classList.remove('recording');
      renderShortcut();
    });
  });

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.url) return;

    var origin;
    try {
      origin = new URL(tab.url).origin;
    } catch (e) {
      return;
    }

    document.getElementById('origin').textContent = origin;

    var routeKey = 'routecache::' + origin;
    var paramKey = 'params::' + origin;

    chrome.storage.local.get([routeKey, paramKey], function (result) {
      var cache = result[routeKey];
      var savedParams = result[paramKey] || {};
      var content = document.getElementById('content');

      if (!cache || !cache.routes || !cache.routes.length) {
        content.innerHTML = '<div class="empty">No routes discovered yet -- open the app and press Ctrl+K first.</div>';
        return;
      }

      var paramNames = Array.from(new Set(
        cache.routes.reduce(function (acc, r) { return acc.concat(r.params || []); }, [])
      )).sort();

      if (!paramNames.length) {
        content.innerHTML = '<div class="empty">This app\'s routes have no path params to configure.</div>';
        return;
      }

      var caption = document.createElement('div');
      caption.className = 'caption';
      caption.textContent = 'Defaults are guessed from the param name unless set here.';
      content.appendChild(caption);

      paramNames.forEach(function (name) {
        var row = document.createElement('div');
        row.className = 'row';

        var label = document.createElement('label');
        label.textContent = ':' + name;

        var input = document.createElement('input');
        input.value = savedParams[name] !== undefined ? savedParams[name] : heuristicDefault(name);
        input.addEventListener('change', function () {
          savedParams[name] = input.value;
          var toSave = {};
          toSave[paramKey] = savedParams;
          chrome.storage.local.set(toSave);
        });

        row.appendChild(label);
        row.appendChild(input);
        content.appendChild(row);
      });
    });
  });
})();
