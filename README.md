# Navigate Easily

A Chrome extension that opens a **Ctrl+K / ⌘+K palette** on any web app, so you can search for a page by its title or path and jump straight to it, instead of clicking through menus.

Every page you visit is remembered with its tab title, and the most-visited pages show first. For Angular apps you can also turn on **auto-discovery**, which reads the app's JavaScript bundles and lists every route it defines, including pages the UI never links to.

## Install

The extension isn't in the Chrome Web Store. Load it unpacked:

1. Clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder.

After pulling new changes, click the reload icon on the extension's card in `chrome://extensions`, then refresh any open tabs.

## Use

- Press **Ctrl+K** (Windows/Linux) or **⌘+K** (Mac) on any page. The shortcut is ignored while you're typing in a text field.
- Type to search. Every word must appear in the page title or path, in any order, and case doesn't matter: `order edit` finds "Edit Order #7".
- Use **↑ / ↓** and **Enter** to go, or click a row. Press **Esc** to close.
- Routes with parameters (e.g. `/orders/:id`) open a small form to fill in the values before navigating.

On Angular apps, navigation happens in place, without a full page reload. On other sites, the page loads normally.

## Settings (toolbar popup)

| Setting | What it does |
|---|---|
| **Auto-discover routes** | Off by default, and applies to all sites. When on, the extension scans the app's bundles for routes. When off, the palette shows only pages you've visited. |
| **Open shortcut** | Click, then press the key combination you want. Use **Reset to default** to go back to Ctrl / ⌘ + K. |
| **Route params** | Shown only when auto-discovery is on. Sets default values for route parameters on the current site. If none is set, it guesses `0` for id-like names and `test` for anything else. |

## How route discovery works

- **Visit tracking (always on):** each page you open is saved for that site, with how many times you've visited it and its tab title. The title is read about a second after you arrive, because single-page apps usually set the title after the URL changes.
- **Angular bundle scan (auto-discovery):** fetches the app's same-origin JavaScript (webpack and esbuild builds). It collects route configs, including nested and lazy-loaded ones, `router.navigate(...)` / `navigateByUrl(...)` calls, and static `routerLink` values. Routes it finds are kept, so the list only grows.
- **Link fallback:** on apps that aren't Angular, it lists the same-origin links on the current page.

## Data and privacy

Everything is stored locally in `chrome.storage.local` and never leaves your browser. The only network requests are auto-discovery fetching the current site's own scripts. Visit tracking runs on every site and stores up to 2,000 paths (with their titles) per site. Page titles can contain personal details, such as an email address in an inbox title.

## Known limitations

- **React, Vue and other single-page apps** get a full page load, not the instant in-place jump that Angular apps get.
- **Hash routing** (`/#/orders`) isn't supported.
- **Apps served under a sub-path** (e.g. `/myapp/`) navigate to the wrong URL for auto-discovered routes.
- **Fast navigation:** if you leave a page within about a second, it can keep the previous page's title until your next visit.

## Development

It's plain JavaScript with no build step. Edit the files, then reload the extension.

| File | Role |
|---|---|
| `content.js` | Runs on every page: discovery, visit tracking, and the palette UI |
| `route-extract.js` | Pure route-parsing logic, with no DOM or Chrome APIs |
| `popup.html`, `popup.js` | Toolbar popup settings |
| `vendor/js-tokens.js` | Vendored JS tokenizer (MIT) used by the bundle parser |

To inspect what the palette would show, open DevTools on the page, switch the console's context dropdown from **top** to **Navigate Easily**, and run `await __navigateEasilyDebug()`.

See [CHANGELOG.md](CHANGELOG.md) for version history.
