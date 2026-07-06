// Pure route-extraction logic (no DOM / no chrome APIs) so it can be unit-tested standalone.
//
// Design: a compiled Angular bundle expresses routes through several independent signals, and
// no single one is complete. Rather than perfectly reconstruct the route *tree* from minified
// code (fragile: shared chunks, multi-import loadChildren, imperative navigation), we harvest
// every high-confidence signal and let the caller union them:
//
//   1. Declarative route configs   -- { path: 'x', component/children/loadChildren: ... }
//      Composed within a file via a bracket-frame tree so nested children get full paths.
//      Lazy `loadChildren` boundaries are linked across chunks by the caller (best-effort).
//   2. Imperative navigation        -- router.navigate(['a/b/c'])  /  navigateByUrl('a/b/c')
//      These strings are ALREADY complete paths, valid regardless of which file they live in.
//   3. Static routerLink bindings   -- compiled Ivy emits `"routerLink", "/a/b"` literals.
//
// jsTokens (vendor/js-tokens.js) is used only for signal 1, to skip strings/regex/templates so
// bracket-matching never desyncs on unrelated code.
(function () {
  'use strict';

  var ROUTE_SIBLING_KEYS = /\b(component|loadComponent|loadChildren|redirectTo|pathMatch|children|canActivate|title)\s*:/;
  var SKIP_TYPES = { WhiteSpace: 1, LineTerminatorSequence: 1, MultiLineComment: 1, SingleLineComment: 1 };

  function stripQuotes(s) {
    return s.length >= 2 ? s.slice(1, -1) : s;
  }

  function nextSignificant(tokens, i) {
    while (i < tokens.length && SKIP_TYPES[tokens[i].type]) i++;
    return i < tokens.length ? { token: tokens[i], index: i } : null;
  }

  function keyName(t) {
    if (t.type === 'IdentifierName') return t.value;
    if (t.type === 'StringLiteral') return stripQuotes(t.value);
    return null;
  }

  // Normalize any candidate path to a comparable route string, or return null if it can't be a
  // route. Strips query/fragment, leading slashes, collapses `//`. Rejects absolute URLs, asset
  // files, and anything with characters a real Angular route segment never contains.
  function normalizeRoutePath(raw) {
    if (typeof raw !== 'string') return null;
    var p = raw.split('#')[0].split('?')[0].trim();
    p = p.replace(/^\.?\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
    if (!p) return null;
    if (p === '**') return null;
    if (/^[a-z]+:\/\//i.test(raw)) return null;              // http://, ftp://, resource://
    if (/\.(js|css|svg|png|jpe?g|gif|woff2?|ttf|ico|json|html?)$/i.test(p)) return null;
    if (!/^[A-Za-z0-9_\-/:.~%]+$/.test(p)) return null;      // no spaces, no expression chars
    if (!/[A-Za-z]/.test(p)) return null;                    // must contain a letter (skip pure numbers/punct)
    return p;
  }

  function extractParams(path) {
    var out = [];
    var re = /:([A-Za-z0-9_]+)/g;
    var m;
    while ((m = re.exec(path))) out.push(m[1]);
    return out;
  }

  function joinPath(a, b) {
    return [a, b].filter(Boolean).join('/').replace(/\/+/g, '/');
  }

  // ---- Signal 1: declarative route configs (bracket-frame tree) ----

  // Collect every webpack chunk id referenced within a loadChildren value expression, e.g.
  // ()=>n.e(841).then(...)               -> ['841']
  // ()=>Promise.all([n.e(27),n.e(841)])  -> ['27','841']   (must get ALL, not just the first --
  // the feature's real route chunk is often not the first .e() when shared deps are involved).
  // Bounded to this property's value: stops at a depth-0 comma or a closing bracket past depth 0.
  function collectChunkIds(tokens, fromIdx) {
    var ids = [];
    var depth = 0;
    for (var i = fromIdx; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'Punctuator') {
        if (t.value === '(' || t.value === '[' || t.value === '{') {
          depth++;
        } else if (t.value === ')' || t.value === ']' || t.value === '}') {
          if (depth === 0) break;
          depth--;
        } else if (t.value === ',' && depth === 0) {
          break;
        } else if (t.value === '.') {
          var e = nextSignificant(tokens, i + 1);
          if (e && e.token.type === 'IdentifierName' && e.token.value === 'e') {
            var paren = nextSignificant(tokens, e.index + 1);
            if (paren && paren.token.value === '(') {
              var num = nextSignificant(tokens, paren.index + 1);
              if (num && num.token.type === 'NumericLiteral') ids.push(num.token.value);
            }
          }
        }
      }
    }
    return ids;
  }

  // esbuild-style literal import() specifier within a loadChildren value (Angular 17+ builder).
  function findImportSpecifier(tokens, fromIdx) {
    var depth = 0;
    for (var i = fromIdx; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'Punctuator') {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}') { if (depth === 0) break; depth--; }
        else if (t.value === ',' && depth === 0) break;
      } else if (t.type === 'IdentifierName' && t.value === 'import') {
        var paren = nextSignificant(tokens, i + 1);
        if (paren && paren.token.value === '(') {
          var str = nextSignificant(tokens, paren.index + 1);
          if (str && str.token.type === 'StringLiteral') return stripQuotes(str.token.value);
        }
      }
    }
    return null;
  }

  // Single forward pass building a flat list of `{...}` frames, each pointing at its nearest
  // enclosing frame, with `path`/`loadChildren` values attributed to whichever frame is open.
  function buildFrames(text) {
    var frames = [];
    var stack = [];
    var current = -1;
    var pos = 0;
    var tokens = Array.from(jsTokens(text));

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'Punctuator') {
        if (t.value === '{') {
          var idx = frames.length;
          frames.push({ start: pos, end: -1, parent: current, path: null, importSpec: null, chunkIds: [] });
          stack.push({ brace: true, idx: idx });
          current = idx;
        } else if (t.value === '}') {
          var top = stack.pop();
          if (top && top.brace) { frames[top.idx].end = pos + 1; current = frames[top.idx].parent; }
        } else if (t.value === '[' || t.value === '(') {
          stack.push({ brace: false });
        } else if (t.value === ']' || t.value === ')') {
          stack.pop();
        }
      } else if (current !== -1 && (t.type === 'IdentifierName' || t.type === 'StringLiteral')) {
        var name = keyName(t);
        if (name === 'path' || name === 'loadChildren') {
          var colon = nextSignificant(tokens, i + 1);
          if (colon && colon.token.value === ':') {
            if (name === 'path') {
              var v = nextSignificant(tokens, colon.index + 1);
              if (v && v.token.type === 'StringLiteral' && frames[current].path === null) {
                frames[current].path = stripQuotes(v.token.value);
              }
            } else {
              var spec = findImportSpecifier(tokens, colon.index + 1);
              if (spec) frames[current].importSpec = spec;
              var ids = collectChunkIds(tokens, colon.index + 1);
              if (ids.length) frames[current].chunkIds = ids;
            }
          }
        }
      }
      pos += t.value.length;
    }
    return frames;
  }

  function fullLocalPath(frameIdx, frames) {
    var segs = [];
    for (var idx = frameIdx; idx !== -1; idx = frames[idx].parent) {
      if (frames[idx].path) segs.unshift(frames[idx].path);
    }
    return segs.join('/').replace(/\/+/g, '/');
  }

  // ---- Signals 2 & 3: imperative navigation + static routerLink (plain regex over full text) ----

  function harvestGlobalLiterals(text) {
    var out = [];

    // router.navigate([ 'a', 'b', ... ])  -- join leading string-literal segments.
    var navRe = /\.navigate\(\s*\[([\s\S]{0,300}?)\]/g;
    var m;
    while ((m = navRe.exec(text))) {
      var segs = [];
      var strRe = /(['"])((?:(?!\1).)*)\1/g;
      var s;
      while ((s = strRe.exec(m[1]))) segs.push(s[2]);
      if (segs.length) out.push(segs.join('/'));
    }

    // router.navigateByUrl('a/b/c')  /  parseUrl('a/b/c')  -- single string argument.
    var byUrlRe = /\.(?:navigateByUrl|parseUrl)\(\s*(['"])((?:(?!\1).)*)\1/g;
    while ((m = byUrlRe.exec(text))) out.push(m[2]);

    // Compiled static routerLink: Ivy emits `"routerLink","/a/b"`. Only trust absolute ('/')
    // values here -- relative routerLinks depend on the current route and can't be resolved.
    var linkRe = /["']routerLink["']\s*,\s*(['"])((?:(?!\1).)*)\1/g;
    while ((m = linkRe.exec(text))) {
      if (m[2].charAt(0) === '/') out.push(m[2]);
    }

    return out;
  }

  // Parse one file. Returns raw structural data; the caller composes cross-chunk prefixes and
  // dedupes across files.
  //   declaredRoutes: [{ localPath }]              -- composed within THIS file only
  //   chunkLinks:     [{ parentLocalPath, chunkIds, importSpec }]  -- lazy boundaries to follow
  //   globalPaths:    [ 'complete/path', ... ]     -- from navigate()/navigateByUrl/routerLink
  function parseFile(text) {
    var frames;
    try {
      frames = buildFrames(text);
    } catch (e) {
      frames = [];
    }

    var declaredRoutes = [];
    var chunkLinks = [];

    frames.forEach(function (f, idx) {
      if (f.chunkIds.length || f.importSpec) {
        chunkLinks.push({ parentLocalPath: fullLocalPath(idx, frames), chunkIds: f.chunkIds, importSpec: f.importSpec });
      }
      if (f.path === null || f.end === -1) return;
      if (f.path === '**') return;
      if (!ROUTE_SIBLING_KEYS.test(text.slice(f.start, f.end))) return;
      declaredRoutes.push({ localPath: fullLocalPath(idx, frames) });
    });

    return {
      declaredRoutes: declaredRoutes,
      chunkLinks: chunkLinks,
      globalPaths: harvestGlobalLiterals(text)
    };
  }

  // Webpack chunk-id -> filename map from runtime.js, e.g.
  //   r.u=e=>(592===e?"common":e)+"."+{14:"7d8c...",27:"5a28...",...}[e]+".js"
  // Returns { [id]: 'name.hash.js' } or null. Anchored to the `r.u=` assignment so it doesn't
  // false-positive on unrelated numeric-object literals elsewhere in a 4MB main bundle.
  function parseChunkMap(text) {
    // Find the ".js" chunk-URL builder and the hash object literal that precedes it.
    var uFnRe = /\+\s*(\{(?:\s*\d+\s*:\s*"[0-9a-fA-F]+"\s*,?)+\})\s*\[\s*\w+\s*\]\s*\+\s*"\.js"/;
    var m = uFnRe.exec(text);
    if (!m) return null;

    var hashes = {};
    var entryRe = /(\d+)\s*:\s*"([0-9a-fA-F]+)"/g;
    var e;
    while ((e = entryRe.exec(m[1]))) hashes[e[1]] = e[2];
    if (!Object.keys(hashes).length) return null;

    // Optional named chunks: `592===e?"common":`
    var named = {};
    var namedRe = /(\d+)\s*===\s*\w+\s*\?\s*"([^"]+)"\s*:/g;
    while ((e = namedRe.exec(text))) named[e[1]] = e[2];

    var result = {};
    Object.keys(hashes).forEach(function (id) {
      result[id] = (named[id] || id) + '.' + hashes[id] + '.js';
    });
    return result;
  }

  window.RouteExtract = {
    parseFile: parseFile,
    parseChunkMap: parseChunkMap,
    normalizeRoutePath: normalizeRoutePath,
    extractParams: extractParams,
    joinPath: joinPath
  };
})();
