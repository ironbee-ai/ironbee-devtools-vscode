# Agent Guidelines for ironbee-devtools-vscode

> **Keep this file up to date.** When you change conventions, architecture, or project structure,
> update the relevant sections here as part of the same change. This file is the source of truth
> for AI coding agents working on this codebase.

## What this project is

`@ironbee-ai/devtools-vscode` (extension `name`: `ironbee-devtools-vscode`, displayName: **IronBee DevTools**)
is the VS Code / Cursor extension front-end for **IronBee DevTools** — the Verification and
Intelligence Layer for AI Coding Agents.

The extension does **not** implement MCP tools itself. It **bundles** the
[`@ironbee-ai/devtools`](https://www.npmjs.com/package/@ironbee-ai/devtools) MCP server (a regular
npm dependency, shipped inside the VSIX under `node_modules/`) and registers it with the IDE so that
GitHub Copilot / Cursor agents can use it. The extension's job is: register the server, expose its
configuration as VS Code settings, install Playwright browsers, and run the optional Visualizer UI.

- License: **Elastic License 2.0 (ELv2)** — see `LICENSE`. Keep `package.json` `"license"` as `Elastic-2.0`.
- Publisher: `ironbee-ai`. Marketplace / Open VSX id: `ironbee-ai.ironbee-devtools-vscode`.

## Project Structure

```
src/
  extension.ts              # Activation entry point. Owns the whole lifecycle:
                            #   - CONFIG_PREFIX + command/view registration
                            #   - MCP registration (Cursor cursor.mcp API OR vscode.lm provider)
                            #   - SETTINGS_TO_ENV: maps VS Code settings -> server env vars
                            #   - bundled server path resolution (ensureMcpServerInstalled)
                            #   - first-run/upgrade install + uninstall (.extension-version marker)
                            #   - Cursor hooks bridge install/remove, Cursor rule copy
                            #   - update-available + GitHub-star prompts, status bar, telemetry calls
  settingsWebview.ts        # SettingsWebviewProvider — Explorer sidebar webview for common settings
  telemetry.ts              # PostHog events + ~/.ironbee-devtools/config.json (anonymousId, opt-out).
                            #   NOTE: this config dir is SHARED with the bundled @ironbee-ai/devtools
                            #   server — it must match the dir that server reads/writes.
  playwrightBrowsersInstall.ts # Downloads Playwright browsers via playwright-core's installer
                            #   (no npx); Chromium/Firefox/WebKit groups; system-Chrome fallback.
  cursorRule.ts             # Renders rules/ironbee-devtools-use.mdc from the template: fills each
                            #   enabled platform's <!--IRONBEE:PLATFORM:x--> marker block with its
                            #   fragment; disabled platforms keep the placeholder comment (no effect).
  visualizer/
    ws.ts                   # WebSocket server that streams tool/agent events to the Visualizer panel
    mcp-app-inline.ts       # Inline HTML for the Visualizer webview panel (loads <root>/visualizer/dist)

visualizer/                 # SEPARATE Vite + Phaser app (its own package.json "ironbee-devtools-vscode-visualizer", build, tsconfig).
  src/                      # Phaser scenes/characters/HUD. Built to visualizer/dist and embedded.
  public/assets/
    chars/                  # Game sprite/tilemap pack (imported as ?inline data URLs in gameAssets.ts)

scripts/cursor-hook.mjs     # Cursor Hooks -> Visualizer bridge. Installed into a workspace's
                            #   .cursor/scripts/ as ironbee-devtools-hook.mjs on visualizer enable.
rules/ironbee-devtools-use.mdc # Cursor rule TEMPLATE. Rendered per-project into each open workspace's
                            #   <workspace>/.cursor/rules/ (syncCursorRuleToWorkspaces) — shaped by that
                            #   folder's enabled platforms; re-rendered on activate, platform-toggle
                            #   change, and workspace-folders change. (Legacy global ~/.cursor/rules copy is removed.)
  platforms/rule.{browser,node,backend}.md # per-platform rule fragments injected when enabled.
images/                     # Marketplace icon + media.
.github/workflows/          # build.yml (CI build) + publish-vscode-extension.yml (release -> Open VSX).
```

`tsconfig.json` compiles only `src/**` to `dist/` (it **excludes** `visualizer`, which builds itself).

## Naming contracts (do not drift)

These strings are coupled across files — change them together:

- **Settings/command/view namespace:** `ironbeeDevTools` (e.g. `ironbeeDevTools.enable`,
  command `ironbeeDevTools.toggleExtension`, view `ironbeeDevTools.settingsView`). Defined as
  `CONFIG_PREFIX` in `extension.ts` and as every key under `contributes` in `package.json`.
- **MCP server names (one per enabled platform):** `ironbee-dt-browser` / `-node` / `-backend`
  (`mcpServerName(platform)` in `extension.ts` — short `dt` keeps server-name + tool-name under client limits). VS Code provider id: `ironbee-devtools`.
- **Bundled server entrypoint:** `node_modules/@ironbee-ai/devtools/dist/index.js`.
- **Extension id:** `ironbee-ai.ironbee-devtools-vscode` (`EXTENSION_ID`, `@ext:` settings link, Open VSX API URL).
- **Telemetry/config dir:** `~/.ironbee-devtools/` (must match the bundled server).
- **Cursor rule file:** `ironbee-devtools-use.mdc`. **Cursor hook script (installed name):** `ironbee-devtools-hook.mjs`.

## How MCP registration works

The extension registers **one MCP server per enabled platform** (`getEnabledPlatforms()` reads the
`ironbeeDevTools.platform.*.enable` toggles). Each server runs the same bundled `dist/index.js` with a
different `PLATFORM` env value (`getMcpServerConfig(platform)`).

**Platform toggles are project-scoped:** the settings webview writes `ironbeeDevTools.platform.*` keys
to `ConfigurationTarget.Workspace` (falling back to Global only when no folder is open), so each project
picks its own platforms in `.vscode/settings.json`. Other settings still write Global. `getEnabledPlatforms(scope)`
takes an optional folder URI to read folder-effective config (used when rendering the per-folder rule).

`extension.ts` `activate()`:
1. Resolves the bundled server path (`ensureMcpServerInstalled`).
2. **Cursor:** for each enabled platform calls `cursor.mcp.registerServer({ name: 'ironbee-dt-<platform>', server: { command:'node', args:[serverPath, '--cursor-mcp-server'], env: { …, PLATFORM } } })`. Re-register on enable, unregister all platform names on disable/deactivate/toggle.
3. **VS Code 1.101+:** registers one `McpServerDefinitionProvider` (`vscode.lm.registerMcpServerDefinitionProvider('ironbee-devtools', …)`) whose `provideMcpServerDefinitions()` returns one `McpStdioServerDefinition` per enabled platform.

Settings are forwarded to the server as **environment variables** via the `SETTINGS_TO_ENV` map in
`extension.ts` (merged env = `process.env` + mapped settings). `PLATFORM` is **not** in that map — it is
set per-server based on which platform that server instance runs.

## Keeping in sync with `@ironbee-ai/devtools` (the bundled server)

The server is the source of truth for tool/config behavior; this extension only surfaces it. When you
bump the `@ironbee-ai/devtools` dependency, check whether any of the following changed and mirror it:

- **New/renamed server env vars** → update `SETTINGS_TO_ENV` and the matching `contributes.configuration`
  property in `package.json` (and its description), plus the README "Available Settings" table.
- **New/removed `PLATFORM` values** → add/remove the platform in `PLATFORMS` (extension.ts), a matching
  `ironbeeDevTools.platform.<name>.enable` toggle in `package.json` + the settings webview, a
  `<!--IRONBEE:PLATFORM:<name>-->` block in `rules/ironbee-devtools-use.mdc`, a
  `rules/platforms/rule.<name>.md` fragment, and the platform list in `cursorRule.ts` (`RULE_PLATFORMS`).
- **New/removed tool domains** → update the relevant `ironbeeDevTools.platform.<name>.availableToolDomains`
  description (each platform server gets its own domain filter via `AVAILABLE_TOOL_DOMAINS`, set per-platform in `getMcpServerConfig`).
- **Server config-dir / telemetry-file location** → update `CONFIG_DIR` in `telemetry.ts`.
- Do **not** add new extension capabilities speculatively — only mirror what the bundled server actually exposes.

## Code Style & Conventions

Style matches the IronBee house style (same as `ironbee-cli`). Linting is **ESLint flat config**
(`eslint.config.js`, scoped to `src/**/*.ts`) — there is no Prettier. Run `npm run lint` (check) /
`npm run lint:fix` (auto-fix) before committing; CI runs `npm run lint`. Enforced rules:

- **4-space indentation** (`indent`, `SwitchCase: 1`) and **always braces** (`curly: all`) — auto-fixable.
- **Explicit return type on every function** (`@typescript-eslint/explicit-function-return-type`), including arrow callbacks (e.g. `(): void =>`).
- **Explicit type annotation on every variable, parameter, and class property** (`@typescript-eslint/typedef`) — even `const x: string = …`. (Destructuring is exempt.) `any` is allowed where needed but prefer precise types.
- Match the existing comment style: short, "why" not "what".
- Keep user-facing strings branded as **IronBee DevTools** and log prefixes as `[IronBee DevTools]`.

## Build, Run, Release

```bash
npm install                 # installs deps incl. bundled @ironbee-ai/devtools
npm run build               # build:visualizer (cd visualizer && npm i && build) then compile (tsc)
npm run compile             # tsc -p ./  (extension only)
npm run watch               # tsc -watch
npm run package             # vsce package  -> .vsix
```

- Press F5 in VS Code to launch the Extension Development Host for manual testing.
- The extension `name` is intentionally **unscoped** (`ironbee-devtools-vscode`): `vsce` rejects scoped
  names. The conceptual npm scope `@ironbee-ai/devtools-vscode` cannot be the marketplace `name`.
- **VSIX packaging:** one universal VSIX. `.vscodeignore` ships production `node_modules` (incl.
  `sharp` + `@img/sharp-wasm32`) but excludes platform-specific sharp/libvips prebuilds. CI builds set
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so browser binaries are not bundled (the extension downloads them at runtime).
- **Release:** `.github/workflows/publish-vscode-extension.yml` runs `release-it` (version bump + tag +
  GitHub release) then publishes to Open VSX. Lockfile-driven (`npm ci --omit=optional`) — regenerate
  `package-lock.json` (via `npm install`) when bumping the `@ironbee-ai/devtools` dependency.
