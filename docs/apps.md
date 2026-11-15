# App notes

| App | Launcher | Schemes | Native code |
| --- | --- | --- | --- |
| Linear 1.32.8 (Electron 44.9.1) | `linear-desktop` | `linear` | 3 trackpad addons → shims |
| Notion 7.43.0 (Electron 45.1.0) | `notion-desktop` | `notion`, `notion-agents` | `better-sqlite3` → official Node-API prebuild; 3 others stubbed/trimmed |
| Figma 126.11.9 (Electron 44.11.2) | `figma-desktop` | `figma-desktop`; `figma` registered, **not** default | none loaded on Linux (Figma's own JS path); fonts → fontconfig module |
| Superhuman 1045.0.0 (Electron 45.2.3) | `superhuman-desktop` | `superhuman`; `mailto` registered, **not** default | none |

Installed commands end in `-desktop`: `linear` and `notion` are those apps'
command-line tools. A transplanted app can sit beside another Linux port of the same
app; `install.defaultSchemes` keeps it from taking over links the other one handles.

## Linear

Linear's web UI only leaves room for the window buttons when it thinks it runs on a
Mac, so a small page adapter pads its title-bar row on `https://linear.app`.
Native addons: [`apps/linear/NATIVE.md`](../apps/linear/NATIVE.md).

## Notion

Notion's tab bar is local UI, patched to leave room for the window buttons.
Its tray icons are derived from its menu-bar icon.

## Figma

Survey and reasoning: [`apps/figma/NATIVE.md`](../apps/figma/NATIVE.md).

- Browser sign-in returns through `figma-desktop://`, a scheme only this app
  registers, so it works beside another Figma port that owns `figma://`.
- Local fonts come from fontconfig, including variable fonts' named instances.

| Variable | Effect |
| --- | --- |
| `FIGMA_DESKTOP_MCP_PORT=N` | serve Figma's MCP server on N instead of 3845 (figma-linux-next uses 3845) |
| `FIGMA_DESKTOP_FRAMELESS=1` | frameless main window |

## Superhuman

### Sign-in

Superhuman's sign-in opens in your browser and should end by handing the result
back to the app. Superhuman's page only does that for Windows and macOS browsers;
on Linux it says "login attempt expired". Two ways through (`apps/superhuman/signin/`):

- **Browser extension** (Chromium-based browsers, one-time): `chrome://extensions` →
  Developer mode → Load unpacked → `~/.local/share/superhuman-desktop/browser-extension`.
  Sign-in then returns to the app on its own. See its README.
- **Without it:** copy the URL of the browser tab that says "expired", then run
  **Superhuman Desktop — Finish browser sign-in** from your launcher
  (`superhuman-desktop-finish-login`). It forwards that URL to the app and clears the
  clipboard. Needs wl-clipboard (Wayland) or xclip/xsel (X11).

Both accept only Superhuman's own HTTPS callback carrying a native-app code and one
Google or Microsoft login, and change nothing in it: the app still checks it against
the sign-in it started. Superhuman claims `superhuman://` each time it starts, so
with two Superhuman ports installed, sign in with the one opened last.
