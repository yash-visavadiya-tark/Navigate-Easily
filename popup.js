(function () {
  'use strict';

  var AUTO_DISCOVER_KEY = 'config::autoDiscover'; // global (all sites), default on

  function heuristicDefault(paramName) {
    var numeric = /^(id|count|page|num|number|qty|quantity)$/i.test(paramName)
      || /(id|count|num|number)$/i.test(paramName);
    return numeric ? '0' : 'test';
  }

  // Global auto-discovery toggle.
  var autoToggle = document.getElementById('autoDiscover');
  chrome.storage.local.get([AUTO_DISCOVER_KEY], function (r) {
    autoToggle.checked = r[AUTO_DISCOVER_KEY] === true; // default OFF when unset
  });
  autoToggle.addEventListener('change', function () {
    var o = {}; o[AUTO_DISCOVER_KEY] = autoToggle.checked;
    chrome.storage.local.set(o);
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
