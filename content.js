(function () {
  'use strict';

  var RE = window.RouteExtract;
  var DEBUG = true; // ponytail: flip false once verified; leaves a `[navigate-easily]` summary log

  // ============================================================================
  // Route discovery
  //
  // 1. Seed with the eager entry bundles named in index.html (main/runtime/etc).
  // 2. When we find webpack's chunk-id -> filename map (in runtime.js), enqueue EVERY lazy
  //    chunk it lists -- so we scan the whole app's code, not just chunks reachable by chasing
  //    a fragile loadChildren link graph.
  // 3. Per file, union three signals: declarative route configs (composed, prefixed across
  //    lazy boundaries), imperative navigate()/navigateByUrl() literals, and static routerLink
  //    values. The literals are already-complete paths, so they're collected regardless of
  //    whether we know the file's mount prefix -- this is what makes coverage robust even when
  //    the declarative tree can't be perfectly reconstructed from minified code.
  // ============================================================================

  // Entry bundles: separator before the hash may be `.` (webpack: main.7431db.js) or `-`
  // (esbuild, Angular 17+ default: main-ULYQ3E5P.js); the hash may be hex or base36-ish; and in
  // dev there may be no hash at all (main.js).
  var ENTRY_BUNDLE_NAME = /^(runtime|polyfills|scripts|main|vendor|common)([.\-][0-9a-zA-Z]+)*\.js$/i;
  // Lazy chunks we must NOT treat as roots: esbuild `chunk-XXXX.js` / webpack numbered `123.hash.js`.
  var LAZY_CHUNK_NAME = /^(chunk[.\-]|\d+\.)/i;

  function isEntryBundle(url) {
    return ENTRY_BUNDLE_NAME.test(url.pathname.split('/').pop());
  }

  function isLazyChunkName(url) {
    return LAZY_CHUNK_NAME.test(url.pathname.split('/').pop());
  }

  function sameOriginFetchable(url) {
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === location.origin;
  }

  function heuristicDefault(paramName) {
    var numeric = /^(id|count|page|num|number|qty|quantity)$/i.test(paramName)
      || /(id|count|num|number)$/i.test(paramName);
    return numeric ? '0' : 'test';
  }

  async function discoverRoutes() {
    var found = new Map();           // normalizedPath -> { path, params }
    var textCache = new Map();       // url -> text | null
    var parsedCache = new Map();     // url -> parseFile() result
    var chunkMap = new Map();        // chunkId -> filename
    var pendingMounts = [];          // { chunkId, prefix } waiting for the chunk map
    var mountQueue = [];             // { url, prefix }  (prefix null = harvest globals only)
    var mountDone = new Set();       // `${url}\n${prefix}` -- lets one chunk mount at many paths
    var globalsDone = new Set();     // url -- navigate/routerLink literals harvested once per file
    var dbg = { files: [], entry: [], chunkFiles: [], fetchFailures: [] };

    function addPath(raw) {
      var p = RE.normalizeRoutePath(raw);
      if (p && !found.has(p)) found.set(p, { path: p, params: RE.extractParams(p) });
    }

    function enqueueMount(url, prefix) {
      var key = url + '\n' + prefix;
      if (mountDone.has(key)) return;
      mountDone.add(key);
      mountQueue.push({ url: url, prefix: prefix });
    }

    function resolvePending() {
      pendingMounts = pendingMounts.filter(function (pm) {
        var fn = chunkMap.get(pm.chunkId);
        if (!fn) return true;
        try { enqueueMount(new URL(fn, document.baseURI).href, pm.prefix); } catch (e) { /* skip */ }
        return false;
      });
    }

    async function fetchText(url) {
      if (textCache.has(url)) return textCache.get(url);
      var text = null;
      try {
        var res = await fetch(url);
        if (res.ok) text = await res.text();
        else dbg.fetchFailures.push({ url: url, status: res.status });
      } catch (e) {
        dbg.fetchFailures.push({ url: url, error: String(e) });
      }
      textCache.set(url, text);
      return text;
    }

    // Fetch + parse once per URL. On first parse: harvest global literals (complete paths) and
    // merge any chunk map this file contains (then enqueue all its chunks + resolve pending).
    async function getParsed(url) {
      if (parsedCache.has(url)) return parsedCache.get(url);
      var text = await fetchText(url);
      var parsed = text == null
        ? { declaredRoutes: [], chunkLinks: [], globalPaths: [] }
        : RE.parseFile(text);

      if (text != null) {
        var map = RE.parseChunkMap(text);
        if (map) {
          Object.keys(map).forEach(function (id) {
            if (!chunkMap.has(id)) chunkMap.set(id, map[id]);
          });
          Object.keys(map).forEach(function (id) {
            try {
              var u = new URL(map[id], document.baseURI).href;
              dbg.chunkFiles.push(u);
              enqueueMount(u, null); // scan every chunk for global literals even if unmounted
            } catch (e) { /* skip */ }
          });
          resolvePending();
        }

        // Chase EVERY literal import() specifier (esbuild has no chunk map -- code is split via
        // native dynamic import, incl. loadComponent and plain lazy imports). Enqueued with a
        // null prefix so we harvest their navigate()/routerLink literals globally without
        // mis-mounting their declarative paths. This is what surfaces routes that only appear
        // as hardcoded strings deep inside feature-component chunks.
        var importRe = /import\(\s*["']([^"']+)["']\s*\)/g;
        var im;
        while ((im = importRe.exec(text))) {
          try {
            var iu = new URL(im[1], url);
            if (sameOriginFetchable(iu)) enqueueMount(iu.href, null);
          } catch (e) { /* skip */ }
        }
      }

      if (!globalsDone.has(url)) {
        globalsDone.add(url);
        parsed.globalPaths.forEach(addPath);
      }

      parsedCache.set(url, parsed);
      return parsed;
    }

    async function processMount(url, prefix) {
      var parsed = await getParsed(url);
      if (prefix === null) return; // globals already harvested in getParsed

      parsed.declaredRoutes.forEach(function (r) {
        addPath(RE.joinPath(prefix, r.localPath));
      });

      parsed.chunkLinks.forEach(function (link) {
        var childPrefix = RE.joinPath(prefix, link.parentLocalPath);
        // esbuild-style: literal import specifier resolves straight to a URL.
        if (link.importSpec) {
          try {
            var u = new URL(link.importSpec, url);
            if (sameOriginFetchable(u)) enqueueMount(u.href, childPrefix);
          } catch (e) { /* skip */ }
        }
        // webpack-style: follow ALL referenced chunk ids (feature chunk may not be the first).
        link.chunkIds.forEach(function (id) {
          var fn = chunkMap.get(id);
          if (fn) {
            try { enqueueMount(new URL(fn, document.baseURI).href, childPrefix); } catch (e) { /* skip */ }
          } else {
            pendingMounts.push({ chunkId: id, prefix: childPrefix });
          }
        });
      });
    }

    var scriptUrls = [];
    document.querySelectorAll('script[src]').forEach(function (s) {
      try {
        var u = new URL(s.src, location.href);
        if (sameOriginFetchable(u)) scriptUrls.push(u);
      } catch (e) { /* skip */ }
    });

    var entries = scriptUrls.filter(isEntryBundle);
    // Safety net: if no filename matched the known entry-bundle conventions (e.g. an unusual
    // build config or a naming scheme we don't recognize), fall back to every same-origin
    // script that isn't clearly a lazy chunk -- better to over-fetch a few files than find
    // nothing. Lazy chunks are excluded so an already-loaded one can't be mounted as a root.
    if (!entries.length) entries = scriptUrls.filter(function (u) { return !isLazyChunkName(u); });

    entries.forEach(function (u) {
      enqueueMount(u.href, '');
      dbg.entry.push(u.href);
    });

    while (mountQueue.length) {
      var item = mountQueue.shift();
      await processMount(item.url, item.prefix);
    }

    var routes = Array.from(found.values()).sort(function (a, b) {
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    if (DEBUG) {
      console.log('[navigate-easily] scan complete:', {
        totalRoutesFound: routes.length,
        entryBundles: dbg.entry,
        chunkFilesDiscovered: dbg.chunkFiles.length,
        filesFetched: textCache.size,
        fetchFailures: dbg.fetchFailures,
        unresolvedChunkMounts: pendingMounts,
        routes: routes.map(function (r) { return r.path; })
      });
    }
    return routes;
  }

  // ============================================================================
  // Adapters
  //
  // Each adapter is { name, detect(), extract() }. The registry tries them in order and uses
  // the first that both detects its framework AND yields routes -- so a real Angular app gets
  // the full bundle-scan exactly as before, and anything else falls through to the universal
  // DOM-link scraper. Requiring routes.length > 0 (not just detect()) means a false-positive
  // Angular detection on a non-Angular page still falls back instead of showing an empty list.
  // ============================================================================

  var AngularAdapter = {
    name: 'angular',
    detect: function () {
      // ng-version is added to the bootstrap root element in prod builds too, but only once
      // Angular has bootstrapped -- which may be after document_idle. So also accept Angular's
      // characteristic entry-bundle filenames, which are in the initial HTML immediately.
      if (document.querySelector('[ng-version]')) return true;
      var scripts = document.querySelectorAll('script[src]');
      for (var i = 0; i < scripts.length; i++) {
        if (/\/(main|runtime|polyfills)\.[0-9a-fA-F]{8,}\.js(\?|$)/i.test(scripts[i].src)) return true;
      }
      return false;
    },
    extract: function () { return discoverRoutes(); }
  };

  // Universal fallback: harvest same-origin <a href> links from the live DOM. Framework-
  // agnostic (works on React/Vue/Rails/static/etc.), but only sees routes linked from the
  // current page -- it can't discover pages the app never renders a link to.
  var DomLinksAdapter = {
    name: 'dom-links',
    detect: function () { return true; },
    extract: function () {
      var seen = new Map();
      document.querySelectorAll('a[href]').forEach(function (a) {
        try {
          var u = new URL(a.href, location.href);
          if (u.origin !== location.origin) return;
          var p = RE.normalizeRoutePath(u.pathname);
          if (p && !seen.has(p)) seen.set(p, { path: p, params: [] });
        } catch (e) { /* skip */ }
      });
      var routes = Array.from(seen.values()).sort(function (a, b) {
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      return Promise.resolve(routes);
    }
  };

  var ADAPTERS = [AngularAdapter, DomLinksAdapter];

  async function resolveRoutes() {
    for (var i = 0; i < ADAPTERS.length; i++) {
      var adapter = ADAPTERS[i];
      if (!adapter.detect()) continue;
      var routes = await adapter.extract();
      if (routes && routes.length) {
        if (DEBUG) console.log('[navigate-easily] using adapter:', adapter.name, '(' + routes.length + ' routes)');
        return { adapter: adapter.name, routes: routes };
      }
    }
    return { adapter: 'none', routes: [] };
  }

  var CACHE_KEY = 'routecache::' + location.origin;
  var AUTO_DISCOVER_KEY = 'config::autoDiscover'; // global (all sites), default off
  var SHORTCUT_KEY = 'config::shortcut';          // global; { ctrl, meta, alt, shift, key } | unset

  // In-memory copy of the configured shortcut so keydown matching stays synchronous. Kept in
  // sync via chrome.storage.onChanged so a change in the popup applies without a page reload.
  // null = use the built-in default matcher (Ctrl OR Cmd + K), cross-platform.
  var currentShortcut = null;
  chrome.storage.local.get([SHORTCUT_KEY], function (r) { currentShortcut = r[SHORTCUT_KEY] || null; });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[SHORTCUT_KEY]) currentShortcut = changes[SHORTCUT_KEY].newValue || null;
  });

  function matchesShortcut(e) {
    var key = (e.key || '').toLowerCase();
    if (!currentShortcut) {
      // Default: Ctrl+K on Win/Linux, Cmd+K on Mac, no other modifiers.
      return key === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    }
    var sc = currentShortcut;
    return key === (sc.key || '').toLowerCase()
      && !!e.ctrlKey === !!sc.ctrl && !!e.metaKey === !!sc.meta
      && !!e.altKey === !!sc.alt && !!e.shiftKey === !!sc.shift;
  }

  function getStoredRoutes() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([CACHE_KEY], function (r) {
        var c = r && r[CACHE_KEY];
        resolve((c && c.routes) || []);
      });
    });
  }

  function isAutoDiscoverOn() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([AUTO_DISCOVER_KEY], function (r) {
        resolve(r[AUTO_DISCOVER_KEY] === true); // default OFF when unset
      });
    });
  }

  var routesPromise = null;
  var lastAdapter = null;
  function getRoutes() {
    if (!routesPromise) {
      routesPromise = resolveRoutes().then(function (result) {
        lastAdapter = result.adapter;
        // Accumulate into storage as a UNION of what was known before and what this scan found,
        // so a page whose scan happens to yield fewer routes (or an empty/transient run) never
        // wipes routes discovered on a richer page. The persisted set only ever grows.
        return getStoredRoutes().then(function (prev) {
          var byPath = new Map();
          prev.forEach(function (x) { byPath.set(x.path, x); });
          result.routes.forEach(function (x) { byPath.set(x.path, x); });
          var merged = Array.from(byPath.values());
          var value = {};
          value[CACHE_KEY] = { scannedAt: Date.now(), adapter: result.adapter, routes: merged };
          chrome.storage.local.set(value);
          return result.routes;
        });
      });
    }
    return routesPromise;
  }

  // The DOM-links fallback reads the live DOM, which on an SPA keeps changing as pages render,
  // so re-scan it on each open. Angular results come from static bundles -- cache those.
  function getRoutesForOpen() {
    return getRoutes().then(function (routes) {
      if (lastAdapter === 'dom-links') return DomLinksAdapter.extract();
      return routes;
    });
  }
  // Eager scan at document_idle so results are ready by first Ctrl+K -- but only if
  // auto-discovery is enabled, so turning it off also stops the bundle fetching/parsing work.
  isAutoDiscoverOn().then(function (on) { if (on) getRoutes(); });

  // ============================================================================
  // Passive visit tracking
  //
  // Static bundle parsing can only find routes that exist as strings in the code. It cannot see
  // routes that are data-driven (menu/nav tree loaded from an API at runtime) or otherwise never
  // literally present in a bundle. To cover *those* -- i.e. every remaining scenario -- we simply
  // remember every path actually visited, persisted per-origin forever, and merge it into the
  // palette. Visit a page once and it's permanently available to jump back to.
  // ============================================================================

  var VISITED_KEY = 'visited::' + location.origin;
  var VISITED_CAP = 2000;
  var lastRecorded = null;
  var lastTitle = null;

  // Visited store is a { path: { count, title } } map, so routes can be ranked by how often
  // they're visited and searched by their human-readable tab title. Migrates the older formats
  // (array of paths, then { path: count }) transparently.
  function normalizeVisits(v) {
    var out = {};
    if (Array.isArray(v)) {
      v.forEach(function (p) { out[p] = { count: 1 }; });
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        var e = v[k];
        if (typeof e === 'number') out[k] = { count: e };
        else if (e && typeof e === 'object') out[k] = { count: e.count || 1, title: e.title };
        else out[k] = { count: 1 };
      });
    }
    return out;
  }

  function updateVisits(mutate) {
    chrome.storage.local.get([VISITED_KEY], function (r) {
      var visits = normalizeVisits(r && r[VISITED_KEY]);
      mutate(visits);
      var o = {}; o[VISITED_KEY] = visits;
      chrome.storage.local.set(o);
    });
  }

  function recordVisit() {
    var p = RE.normalizeRoutePath(location.pathname);
    if (!p || p === lastRecorded) return; // the guard stops the 1s poll double-counting one stay
    lastRecorded = p;
    lastTitle = null;
    updateVisits(function (visits) {
      visits[p] = { count: ((visits[p] && visits[p].count) || 0) + 1, title: visits[p] && visits[p].title };
      var keys = Object.keys(visits);
      if (keys.length > VISITED_CAP) { // keep the most-visited when capping
        keys.sort(function (a, b) { return visits[b].count - visits[a].count; });
        keys.slice(VISITED_CAP).forEach(function (k) { delete visits[k]; });
      }
    });
  }

  // SPAs change the URL first and set the title only once the route resolves, so the title is
  // read on the poll ticks after arriving (not at navigation time, when it's usually still the
  // previous page's) and rewritten whenever it changes -- the last title seen for a path wins.
  // ponytail: leaving a page before its title settles can keep the previous page's title until
  // the next visit; add a settle delay if that shows up in practice.
  function recordTitle() {
    var t = document.title.trim();
    if (!lastRecorded || !t || t === lastTitle) return;
    lastTitle = t;
    var p = lastRecorded;
    updateVisits(function (visits) {
      if (visits[p]) visits[p].title = t;
    });
  }

  function getVisits() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([VISITED_KEY], function (r) {
        resolve(normalizeVisits(r && r[VISITED_KEY]));
      });
    });
  }

  if (window.top === window) { // don't record iframe URLs, only real top-level navigations
    recordVisit();
    window.addEventListener('popstate', recordVisit);
    window.addEventListener('hashchange', recordVisit);
    // SPA pushState navigations fire no event, so poll for URL changes -- cheap, once a second.
    setInterval(function () {
      if (RE.normalizeRoutePath(location.pathname) !== lastRecorded) recordVisit();
      else recordTitle();
    }, 1000);
  }

  // What the palette shows: the union of everything we know about this origin --
  //   live scan (this page)  ∪  persisted discovered (accumulated over past visits)  ∪  visited.
  // Ranked by visit count (most-visited first), then alphabetically. Reading the persisted set
  // too means the full discovered list always shows even if the current page's live scan is
  // weaker. Visited-only paths are tagged so they're distinguishable.
  function annotateAndRank(routes, visits) {
    routes.forEach(function (r) {
      var v = visits[r.path];
      r.count = v ? v.count : 0;
      r.title = v && v.title;
    });
    return routes.sort(function (a, b) {
      return (b.count - a.count) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    });
  }

  function getMergedRoutes() {
    return Promise.all([isAutoDiscoverOn(), getVisits()]).then(function (cfg) {
      var auto = cfg[0], visits = cfg[1];

      // Auto-discovery off: show only the visited-routes store, and skip all scanning entirely.
      if (!auto) {
        var visitedOnly = Object.keys(visits).map(function (p) {
          return { path: p, params: RE.extractParams(p), visited: true };
        });
        return annotateAndRank(visitedOnly, visits);
      }

      return Promise.all([getRoutesForOpen(), getStoredRoutes()]).then(function (parts) {
        var byPath = new Map();
        function addDiscovered(r) {
          if (!byPath.has(r.path)) byPath.set(r.path, { path: r.path, params: r.params || RE.extractParams(r.path) });
        }
        parts[0].forEach(addDiscovered);  // live scan
        parts[1].forEach(addDiscovered);  // persisted discovered
        Object.keys(visits).forEach(function (p) {  // visited-only paths not in discovered
          if (!byPath.has(p)) byPath.set(p, { path: p, params: RE.extractParams(p), visited: true });
        });
        return annotateAndRank(Array.from(byPath.values()), visits);
      });
    });
  }

  window.__navigateEasilyDebug = function () {
    return getMergedRoutes().then(function (routes) { return { count: routes.length, routes: routes }; });
  };

  // ============================================================================
  // Palette UI
  // ============================================================================

  var host = null, shadow = null, els = {};
  var mode = 'list';               // 'list' | 'params'
  var allRoutes = [], filtered = [], selectedIndex = 0;
  var activeRoute = null, savedParams = {};

  function isEditable(el) {
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }
  function isPaletteOpen() { return !!host; }

  function buildHost() {
    host = document.createElement('div');
    host.id = 'navigate-easily-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);';
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      '.ne-wrap{display:flex;justify-content:center;padding-top:12vh;font-family:system-ui,sans-serif;}' +
      '.ne-palette{width:560px;max-width:90vw;max-height:60vh;background:#1e1e1e;color:#eee;' +
      'border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;}' +
      '.ne-input{border:none;outline:none;padding:14px 16px;font-size:15px;background:#2a2a2a;color:#fff;}' +
      '.ne-count{padding:4px 16px;font-size:11px;color:#777;background:#242424;}' +
      '.ne-list{list-style:none;margin:0;padding:6px;overflow-y:auto;}' +
      '.ne-item{padding:8px 10px;border-radius:5px;cursor:pointer;font-size:13px;' +
      'display:flex;justify-content:space-between;align-items:center;gap:12px;}' +
      '.ne-item.ne-selected{background:#3a5ccc;color:#fff;}' +
      '.ne-main{display:flex;flex-direction:column;min-width:0;}' +
      '.ne-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.ne-path{font-family:monospace;}' +
      '.ne-sub{font-size:11px;color:#888;margin-top:2px;}' +
      '.ne-selected .ne-sub{color:#cdd6f7;}' +
      '.ne-meta{font-family:monospace;color:#888;flex-shrink:0;}' +
      '.ne-empty,.ne-hint{padding:14px 16px;font-size:13px;color:#999;}' +
      '.ne-params{padding:10px 16px;}' +
      '.ne-param-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;}' +
      '.ne-param-row label{font-family:monospace;font-size:12px;color:#9ab;min-width:80px;}' +
      '.ne-param-row input{flex:1;padding:6px 8px;background:#2a2a2a;border:1px solid #444;color:#fff;border-radius:4px;}' +
      '.ne-path-label{font-family:monospace;font-size:13px;color:#ccc;padding:10px 16px 0;}';

    var wrap = document.createElement('div');
    wrap.className = 'ne-wrap';
    var palette = document.createElement('div');
    palette.className = 'ne-palette';
    var input = document.createElement('input');
    input.className = 'ne-input';
    input.placeholder = 'Search by page title or path…';
    var count = document.createElement('div');
    count.className = 'ne-count';
    var list = document.createElement('ul');
    list.className = 'ne-list';
    var empty = document.createElement('div');
    empty.className = 'ne-empty';
    empty.hidden = true;

    palette.appendChild(input);
    palette.appendChild(count);
    palette.appendChild(list);
    palette.appendChild(empty);
    wrap.appendChild(palette);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    els = { wrap: wrap, palette: palette, input: input, count: count, list: list, empty: empty };

    host.addEventListener('mousedown', function (e) {
      if (e.target === host || e.target === wrap) closePalette();
    });
    // Stop every key event that happens inside the palette from reaching the host page. Sites
    // like GitHub attach document-level keydown shortcuts (their `hotkey` lib) that otherwise
    // fire while we're typing -- e.g. stealing focus to their own search box. stopPropagation
    // here (bubble phase, at the target) prevents the event reaching document before the page's
    // listeners see it, without preventDefault so normal typing still lands in our input.
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      host.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    input.addEventListener('keydown', onPaletteKeydown);
    input.addEventListener('input', function () { renderList(input.value); });

    document.body.appendChild(host);
  }

  function openPalette() {
    if (isPaletteOpen()) return;
    buildHost();
    mode = 'list';
    els.count.textContent = 'Scanning…';
    getMergedRoutes().then(function (routes) {
      allRoutes = routes;
      if (isPaletteOpen()) renderList(els.input.value);
    });
    els.input.focus();
  }

  function closePalette() {
    if (!host) return;
    host.remove();
    host = null; shadow = null; els = {};
  }

  function renderList(filterText) {
    // Every space-separated word must appear in the title or the displayed path, in any order,
    // so "order edit" finds a page titled "Edit Order".
    var words = (filterText || '').toLowerCase().split(/\s+/).filter(Boolean);
    filtered = allRoutes.filter(function (r) {
      var haystack = ((r.title || '') + ' /' + r.path).toLowerCase();
      return words.every(function (w) { return haystack.indexOf(w) !== -1; });
    });
    selectedIndex = 0;
    els.list.innerHTML = '';
    els.count.textContent = filtered.length + ' / ' + allRoutes.length + ' routes';

    if (!allRoutes.length) {
      els.empty.hidden = false;
      els.empty.textContent = 'No routes found on this page.';
      return;
    }
    if (!filtered.length) {
      els.empty.hidden = false;
      els.empty.textContent = 'No matching routes.';
      return;
    }
    els.empty.hidden = true;

    filtered.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'ne-item' + (i === selectedIndex ? ' ne-selected' : '');
      var main = document.createElement('div');
      main.className = 'ne-main';
      if (r.title) {
        var titleSpan = document.createElement('span');
        titleSpan.textContent = r.title;
        main.appendChild(titleSpan);
      }
      var pathSpan = document.createElement('span');
      pathSpan.className = 'ne-path' + (r.title ? ' ne-sub' : '');
      pathSpan.textContent = '/' + r.path;
      main.appendChild(pathSpan);
      li.appendChild(main);
      var meta = document.createElement('span');
      meta.className = 'ne-meta';
      var bits = [];
      if (r.params.length) bits.push(r.params.map(function (p) { return ':' + p; }).join(' '));
      if (r.visited) bits.push('visited'); // Update the text to reflect the number of visits
      meta.textContent = bits.join('  ');
      if (bits.length) li.appendChild(meta);
      li.addEventListener('mousedown', function (e) { e.preventDefault(); selectRoute(r); });
      els.list.appendChild(li);
    });
  }

  function updateSelectedHighlight() {
    Array.from(els.list.children).forEach(function (li, i) {
      li.classList.toggle('ne-selected', i === selectedIndex);
    });
    var el = els.list.children[selectedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function selectRoute(route) {
    activeRoute = route;
    if (!route.params.length) { navigateFinal(route.path); return; }
    chrome.storage.local.get(['params::' + location.origin], function (result) {
      savedParams = (result && result['params::' + location.origin]) || {};
      renderParamsStep(route);
    });
  }

  function renderParamsStep(route) {
    mode = 'params';
    els.list.innerHTML = '';
    els.empty.hidden = true;

    var label = document.createElement('div');
    label.className = 'ne-path-label';
    label.textContent = '/' + route.path;
    els.palette.insertBefore(label, els.count.nextSibling);

    var container = document.createElement('div');
    container.className = 'ne-params';
    var inputsByParam = {};
    route.params.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'ne-param-row';
      var lbl = document.createElement('label');
      lbl.textContent = ':' + p;
      var inp = document.createElement('input');
      inp.value = savedParams[p] !== undefined ? savedParams[p] : heuristicDefault(p);
      inputsByParam[p] = inp;
      row.appendChild(lbl);
      row.appendChild(inp);
      container.appendChild(row);
    });

    var hint = document.createElement('div');
    hint.className = 'ne-hint';
    hint.textContent = 'Enter to go (one-time values -- edit saved defaults from the toolbar popup). Esc to go back.';

    els.palette.insertBefore(container, els.empty);
    els.palette.insertBefore(hint, els.empty);
    els._paramLabel = label;
    els._paramContainer = container;
    els._paramHint = hint;
    els._paramInputs = inputsByParam;

    var firstInput = container.querySelector('input');
    if (firstInput) firstInput.focus();
  }

  function exitParamsStep() {
    mode = 'list';
    if (els._paramLabel) els._paramLabel.remove();
    if (els._paramContainer) els._paramContainer.remove();
    if (els._paramHint) els._paramHint.remove();
    els.input.focus();
    renderList(els.input.value);
  }

  function navigateFinal(resolvedPath) {
    var url = '/' + resolvedPath;
    // Client-side navigation, no full reload: push the URL and fire popstate, which Angular's
    // Router (and most SPA routers) listen for. Content scripts share the page's window.history
    // and window event target, so this drives the app's in-place routing. Fall back to a real
    // navigation only if the History API is unavailable or throws (e.g. a cross-document URL).
    try {
      history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    } catch (e) {
      location.href = url;
    }
    closePalette();
  }

  function resolveParamsAndNavigate(route) {
    var resolved = route.path;
    route.params.forEach(function (p) {
      var inp = els._paramInputs && els._paramInputs[p];
      var val = inp ? inp.value : (savedParams[p] !== undefined ? savedParams[p] : heuristicDefault(p));
      resolved = resolved.replace(':' + p, encodeURIComponent(val));
    });
    navigateFinal(resolved);
  }

  function onPaletteKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'params') exitParamsStep(); else closePalette();
      return;
    }
    if (mode === 'list') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        updateSelectedHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelectedHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var r = filtered[selectedIndex];
        if (r) selectRoute(r);
      }
    } else if (mode === 'params') {
      if (e.key === 'Enter') {
        e.preventDefault();
        resolveParamsAndNavigate(activeRoute);
      }
    }
  }

  function onGlobalKeydown(e) {
    if (isPaletteOpen() || !matchesShortcut(e)) return;
    if (isEditable(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    openPalette();
  }

  document.addEventListener('keydown', onGlobalKeydown, true);
})();
