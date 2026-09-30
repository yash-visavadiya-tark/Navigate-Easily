# Changelog

## 1.1.1 — 2026-09-30

### Fixed
- Choosing a page on a site that isn't an Angular app changed the address bar but didn't open the page. Those sites now load the page normally. Angular apps still navigate in place.
- Tabs left open across an extension reload or update threw "Extension context invalidated" every second, and the palette failed to load. They now stay quiet, and the shortcut shows a message asking you to refresh the page.

## 1.1.0 — 2026-09-28

### Added
- The palette searches by page title as well as path. Each row shows the title with the path beneath it, and every word you type must match the title or path, in any order.
- Visited pages now store their tab title. Existing visit history carries over automatically.

### Fixed
- The once-a-second URL check always saw a change and re-ran visit recording on every tick.
- Manifest version corrected to `1.1.0` (it said `2.0.0`, which was never released), with an updated description.

## 1.0.0 — 2026-07-07

Git tag: `v1`.

- Ctrl+K / ⌘+K route palette with filtering, keyboard navigation, and a form for route parameters.
- Angular route discovery from production bundles (webpack and esbuild), covering nested, lazy-loaded, imperative, and `routerLink` routes.
- Fallback that lists same-origin links on sites that aren't Angular.
- Visit tracking per site, with most-visited pages ranked first.
- Auto-discovery toggle, off by default, which limits the palette to visited pages.
- In-place navigation without a page reload.
- Configurable open shortcut.
