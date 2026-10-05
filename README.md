# Research OS

A calm productivity dashboard for academics and researchers — priority tasks, daily research habits, a deep-work timer and insights. A progressive web app (PWA) packaged for the Microsoft Store with PWABuilder.

- Live site: https://haymohsen.github.io/research-os/
- Privacy policy: https://haymohsen.github.io/research-os/privacy.html
- Support: haymohsen@gmail.com

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell, inline SVG icon sprite |
| `styles.css` | Fluent / Windows 11 styling, light and dark themes |
| `app.js` | All application logic (tasks, habits, timer, insights, settings, backup) |
| `sw.js` | Service worker — offline cache and update flow |
| `manifest.webmanifest` | Web app manifest (icons, shortcuts, screenshots) |
| `privacy.html` | Privacy policy page linked from the Store listing |
| `icons/`, `screenshots/` | Icon set and manifest screenshots |

No build step, no frameworks, no external requests. All user data is stored in `localStorage` under the key `researchos.v1`.

## Releasing an update

1. Change the files.
2. Bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js`.
3. Commit/upload to the `main` branch — GitHub Pages publishes within about a minute and installed apps offer "Update ready → Restart now".

## Licence notes

Application code © 2026 Hani Muhsen. Interface icons are from [Lucide](https://lucide.dev) (ISC licence).
