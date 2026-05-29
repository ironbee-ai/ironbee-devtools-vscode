import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startVisualizerWs, closeVisualizer } from './visualizer/ws';
import { getVisualizerAppHtml } from './visualizer/mcp-app-inline';
import {
    ensurePlaywrightBrowsersInstalled,
    installPlaywrightBrowsersByGroups,
    type PlaywrightBrowserInstallGroup,
} from './playwrightBrowsersInstall';
import { SettingsWebviewProvider } from './settingsWebview';
import { renderCursorRule } from './cursorRule';
import {
    trackCursorExtActivated,
    trackCursorExtDeactivated,
    trackCursorExtInstallFailed,
    trackCursorExtInstalled,
    trackCursorExtUninstallFailed,
    trackCursorExtUninstalled,
    writeTelemetryEnabledToConfig,
} from './telemetry';

// Configuration key prefix
const CONFIG_PREFIX: string = 'ironbeeDevTools';

// GitHub repo for issue reporting when install fails
const GITHUB_ISSUES_BASE: string = 'https://github.com/ironbee-ai/ironbee-devtools-vscode/issues/new';

/** File under globalStorage to track extension version for first-run / upgrade; only one activate runs onInstall. */
const EXTENSION_VERSION_FILE: string = '.extension-version';

/** Cursor rule file written into each workspace's .cursor/rules/ on activate, removed on uninstall. */
const CURSOR_RULE_FILE_NAME: string = 'ironbee-devtools-use.mdc';
/** How long to show "Cursor rule installed" in the status bar after onInstall. */
const CURSOR_RULE_STATUS_DURATION_MS: number = 5000;

/** Platforms supported by the bundled @ironbee-ai/devtools server (selected via the PLATFORM env var). */
type Platform = 'browser' | 'node' | 'backend';
const PLATFORMS: readonly Platform[] = ['browser', 'node', 'backend'];
/** Default enabled state per platform when the user has not set a toggle. */
const DEFAULT_PLATFORM_ENABLED: Record<Platform, boolean> = {
    browser: true,
    node: false,
    backend: false,
};
/** MCP server name registered per enabled platform (Cursor register/unregister + VS Code provider).
 *  Kept short ('dt' not 'devtools') so the server-name + tool-name combo stays under client limits. */
function mcpServerName(platform: Platform): string {
    return `ironbee-dt-${platform}`;
}
const EXTENSION_ID: string = 'ironbee-ai.ironbee-devtools-vscode';
/** CLI arg added when we start the MCP server so we can identify our processes for kill (avoids killing extension host). */
const CURSOR_MCP_SERVER_ARG: string = '--cursor-mcp-server';
const OPEN_VSX_EXTENSION_API_URL: string = 'https://open-vsx.org/api/ironbee-ai/ironbee-devtools-vscode';
const LAST_UPDATE_PROMPTED_AT_KEY: string = 'last-update-prompted-at';
const UPDATE_PROMPT_COOLDOWN_MS: number = 24 * 60 * 60 * 1000; // 24 hours

const STAR_PROMPT_KEY: string = 'star-prompt-state'; // 'dismissed' | timestamp (number)
const STAR_PROMPT_DISMISS_MS: number = 24 * 60 * 60 * 1000; // 1 day (dialog closed without choice)
const GITHUB_REPO_URL: string = 'https://github.com/ironbee-ai/ironbee-devtools-vscode';

let cachedMcpServerPath: string | null = null;

/** Set in activate; deactivate receives no context so we keep these for .obsolete check and runUninstallIfNeeded. */
let extensionPathForDeactivate: string | null = null;
let globalStoragePathForDeactivate: string | null = null;
let extensionVersionForDeactivate: string = '';
let uninstallInProgress: boolean = false;

/**
 * While true, install.* configuration changes from "Install Playwright Browsers" skip the
 * onDidChangeConfiguration auto-install (that command updates settings and runs install once).
 */
let suppressConfigDrivenBrowserReinstall: boolean = false;

// Map VS Code settings to environment variables
const SETTINGS_TO_ENV: Record<string, string> = {
    'browser.headless': 'BROWSER_HEADLESS_ENABLE',
    'browser.persistent': 'BROWSER_PERSISTENT_ENABLE',
    'browser.userDataDir': 'BROWSER_PERSISTENT_USER_DATA_DIR',
    'browser.useSystemBrowser': 'BROWSER_USE_INSTALLED_ON_SYSTEM',
    'browser.executablePath': 'BROWSER_EXECUTABLE_PATH',
    'browser.locale': 'BROWSER_LOCALE',
    'browser.cdp.enable': 'BROWSER_CDP_ENABLE',
    'browser.cdp.endpointUrl': 'BROWSER_CDP_ENDPOINT_URL',
    'browser.cdp.openInspect': 'BROWSER_CDP_OPEN_INSPECT',
    'browser.consoleMessagesBufferSize': 'BROWSER_CONSOLE_MESSAGES_BUFFER_SIZE',
    'browser.httpRequestsBufferSize': 'BROWSER_HTTP_REQUESTS_BUFFER_SIZE',
    'node.inspectorHost': 'NODE_INSPECTOR_HOST',
    'node.consoleMessagesBufferSize': 'NODE_CONSOLE_MESSAGES_BUFFER_SIZE',
    'opentelemetry.enable': 'OTEL_ENABLE',
    'opentelemetry.serviceName': 'OTEL_SERVICE_NAME',
    'opentelemetry.serviceVersion': 'OTEL_SERVICE_VERSION',
    'opentelemetry.assetsDir': 'OTEL_ASSETS_DIR',
    'opentelemetry.instrumentationUserInteractionEvents': 'OTEL_INSTRUMENTATION_USER_INTERACTION_EVENTS',
    'opentelemetry.exporterType': 'OTEL_EXPORTER_TYPE',
    'opentelemetry.exporterUrl': 'OTEL_EXPORTER_HTTP_URL',
    'opentelemetry.exporterHeaders': 'OTEL_EXPORTER_HTTP_HEADERS',
    'aws.region': 'AWS_REGION',
    'aws.profile': 'AWS_PROFILE',
    'bedrock.enable': 'AMAZON_BEDROCK_ENABLE',
    'bedrock.imageModelId': 'AMAZON_BEDROCK_IMAGE_EMBED_MODEL_ID',
    'bedrock.textModelId': 'AMAZON_BEDROCK_TEXT_EMBED_MODEL_ID',
    'bedrock.visionModelId': 'AMAZON_BEDROCK_VISION_MODEL_ID',
    'figma.accessToken': 'FIGMA_ACCESS_TOKEN',
    'figma.apiBaseUrl': 'FIGMA_API_BASE_URL',
    toolOutputSchemaDisable: 'TOOL_OUTPUT_SCHEMA_DISABLE',
    showVisualizer: 'VISUALIZER_ENABLE',
    'visualizer.wsPort': 'VIS_WS_PORT',
};

// Status bar item
let statusBarItem: vscode.StatusBarItem;

// Visualizer panel (singleton)
let visualizerPanel: vscode.WebviewPanel | undefined;
let activeVisualizerPort: number | null = null;

const SELECTED_CHAR_KEY: string = 'visualizer.selectedChar';
const TOTAL_TOOLS_USED_KEY: string = 'visualizer.totalToolsUsed';

function getTotalToolsUsed(context: vscode.ExtensionContext): number {
    return context.globalState.get<number>(TOTAL_TOOLS_USED_KEY, 0);
}

function incrementTotalToolsUsed(context: vscode.ExtensionContext): void {
    const current: number = getTotalToolsUsed(context);
    void context.globalState.update(TOTAL_TOOLS_USED_KEY, current + 1);
}

function showVisualizerPanel(context: vscode.ExtensionContext, wsPort: number): void {
    activeVisualizerPort = wsPort;
    if (visualizerPanel) {
        const savedChar: string | undefined = context.globalState.get<string>(SELECTED_CHAR_KEY);
        visualizerPanel.webview.html = getVisualizerAppHtml(wsPort, context.extensionPath, savedChar);
        visualizerPanel.reveal(vscode.ViewColumn.Two);
        return;
    }
    visualizerPanel = vscode.window.createWebviewPanel('mcpVisualizer', 'MCP Visualizer', vscode.ViewColumn.Two, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });
    const savedChar: string | undefined = context.globalState.get<string>(SELECTED_CHAR_KEY);
    visualizerPanel.webview.html = getVisualizerAppHtml(wsPort, context.extensionPath, savedChar);

    // Persist character selection when the webview sends a save_char message
    visualizerPanel.webview.onDidReceiveMessage(
        (msg: unknown): void => {
            if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'save_char') {
                const char: unknown = (msg as Record<string, unknown>).char;
                if (typeof char === 'string') {
                    void context.globalState.update(SELECTED_CHAR_KEY, char);
                }
            }
        },
        undefined,
        context.subscriptions
    );

    visualizerPanel.onDidDispose(
        (): void => {
            visualizerPanel = undefined;
        },
        null,
        context.subscriptions
    );
}

async function startVisualizerWithPortFallback(
    context: vscode.ExtensionContext,
    basePort: number,
    openPanelImmediately: boolean
): Promise<void> {
    const started: Awaited<ReturnType<typeof startVisualizerWs>> = await startVisualizerWs({
        port: basePort,
        maxPortAttempts: 100,
        onFirstMcpTool: (): void => {
            const port: number = activeVisualizerPort ?? basePort;
            showVisualizerPanel(context, port);
        },
        getSelectedChar: (): string | undefined => context.globalState.get<string>(SELECTED_CHAR_KEY),
        getTotalToolsUsed: (): number => getTotalToolsUsed(context),
        onToolFinished: (): void => incrementTotalToolsUsed(context),
        onListening: (actualPort: number): void => {
            activeVisualizerPort = actualPort;
            if (openPanelImmediately) {
                showVisualizerPanel(context, actualPort);
            }
            syncCursorHooks(context.extensionPath, true, actualPort);
        },
    });
    if (started === null) {
        void vscode.window.showErrorMessage(
            `IronBee DevTools: Visualizer could not start. No available port found in range ${basePort}-${basePort + 99}.`
        );
    }
}

function isExtensionEnabled(): boolean {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    return config.get<boolean>('enable', true);
}

function isVisualizerEnabled(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('showVisualizer', false);
}

function updateStatusBar(): void {
    const enabled: boolean = isExtensionEnabled();
    if (enabled) {
        statusBarItem.text = '$(globe) IronBee DevTools';
        statusBarItem.tooltip = 'IronBee DevTools is enabled. Click to disable.';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(circle-slash) IronBee DevTools';
        statusBarItem.tooltip = 'IronBee DevTools is disabled. Click to enable.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

/** Read telemetry.enable from settings and write to ~/.ironbee-devtools/config.json. Call on activate and when the setting changes. */
function syncTelemetryConfigFromVscodeSetting(): void {
    const enabled: boolean = vscode.workspace.getConfiguration(CONFIG_PREFIX).get<boolean>('telemetry.enable', true);
    writeTelemetryEnabledToConfig(enabled);
}

async function toggleExtension(): Promise<void> {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    const currentState: boolean = config.get<boolean>('enable', true);
    await config.update('enable', !currentState, vscode.ConfigurationTarget.Global);
}

/** Cursor-specific MCP API (not in VS Code typings). Resolved at call time so Cursor can inject it after extension load. */
function getCursorMcp():
    | { registerServer: (config: unknown) => void; unregisterServer: (name: string) => void }
    | undefined {
    const v: {
        cursor?: { mcp?: { registerServer: (config: unknown) => void; unregisterServer: (name: string) => void } };
    } = vscode as unknown as {
        cursor?: { mcp?: { registerServer: (config: unknown) => void; unregisterServer: (name: string) => void } };
    };
    return v?.cursor?.mcp;
}

/** True when running in Cursor. In Cursor we must not call vscode.lm.registerMcpServerDefinitionProvider. */
function isCursor(): boolean {
    const v: { cursor?: unknown } = vscode as unknown as { cursor?: unknown };
    if (v.cursor !== undefined) {
        return true;
    }
    const appName: string = (vscode.env as { appName?: string }).appName ?? '';
    return appName.toLowerCase().includes('cursor');
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
    const v: unknown = context.extension?.packageJSON?.version;
    return typeof v === 'string' ? v : '';
}

function compareSemver(a: string, b: string): number {
    const pa: number[] = a.split('.').map((x: string): number => Number.parseInt(x, 10) || 0);
    const pb: number[] = b.split('.').map((x: string): number => Number.parseInt(x, 10) || 0);
    const len: number = Math.max(pa.length, pb.length);
    for (let i: number = 0; i < len; i += 1) {
        const av: number = pa[i] ?? 0;
        const bv: number = pb[i] ?? 0;
        if (av > bv) {
            return 1;
        }
        if (av < bv) {
            return -1;
        }
    }
    return 0;
}

async function fetchLatestPublishedVersion(): Promise<string | null> {
    return await new Promise((resolve: (value: string | null) => void): void => {
        const req: http.ClientRequest = https.get(OPEN_VSX_EXTENSION_API_URL, (res: http.IncomingMessage): void => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                resolve(null);
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer): number => chunks.push(Buffer.from(chunk)));
            res.on('end', (): void => {
                try {
                    const json: { version?: string } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                        version?: string;
                    };
                    resolve(typeof json.version === 'string' ? json.version : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', (): void => resolve(null));
        req.setTimeout(3000, (): void => {
            req.destroy();
            resolve(null);
        });
    });
}

async function maybePromptExtensionUpdate(context: vscode.ExtensionContext): Promise<void> {
    if (!isCursor()) {
        return;
    }
    const currentVersion: string = getExtensionVersion(context);
    if (!currentVersion) {
        return;
    }

    const latestVersion: string | null = await fetchLatestPublishedVersion();
    if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
        return;
    }

    const now: number = Date.now();
    const lastPromptedAt: number = context.globalState.get<number>(LAST_UPDATE_PROMPTED_AT_KEY, 0);
    if (now - lastPromptedAt < UPDATE_PROMPT_COOLDOWN_MS) {
        return;
    }

    await context.globalState.update(LAST_UPDATE_PROMPTED_AT_KEY, now);
    const choice: 'Install Update' | 'Later' | undefined = await vscode.window.showInformationMessage(
        `IronBee DevTools update available (${currentVersion} -> ${latestVersion}).`,
        'Install Update',
        'Later'
    );
    if (choice !== 'Install Update') {
        return;
    }
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
        void vscode.window.showInformationMessage('IronBee DevTools update installed. Reload the window if needed.');
    } catch (err) {
        const msg: string = err instanceof Error ? err.message : String(err);
        console.warn('[IronBee DevTools] Failed to install extension update:', msg);
        void vscode.window.showWarningMessage(
            `IronBee DevTools: Failed to install update automatically. Please update from Extensions. ${msg}`
        );
    }
}

async function maybePromptGitHubStar(context: vscode.ExtensionContext): Promise<void> {
    const state: string | number | undefined = context.globalState.get<string | number>(STAR_PROMPT_KEY);

    // Permanently dismissed
    if (state === 'dismissed') {
        return;
    }

    // Cooldown: dialog closed without choice → 1 day
    if (typeof state === 'number' && Date.now() - state < STAR_PROMPT_DISMISS_MS) {
        return;
    }

    const choice: string | undefined = await vscode.window.showInformationMessage(
        'Enjoying IronBee DevTools? Give us a ⭐ on GitHub!',
        '⭐ Star on GitHub',
        "Don't Ask Again"
    );

    if (choice === '⭐ Star on GitHub') {
        void vscode.env.openExternal(vscode.Uri.parse(GITHUB_REPO_URL));
        await context.globalState.update(STAR_PROMPT_KEY, 'dismissed');
    } else if (choice === "Don't Ask Again") {
        await context.globalState.update(STAR_PROMPT_KEY, 'dismissed');
    } else {
        // Dialog closed without clicking any button → 1 day cooldown
        await context.globalState.update(STAR_PROMPT_KEY, Date.now());
    }
}

// ── Cursor Hooks bridge ──────────────────────────────────────────────────────

/** Hook events the visualizer listens for. */
const HOOK_EVENTS: readonly string[] = [
    'sessionStart',
    'beforeMCPExecution',
    'afterMCPExecution',
    'preToolUse',
    'postToolUse',
    'afterAgentResponse',
    'stop',
];

/** Marker used to identify hook entries installed by this extension. */
const HOOK_SCRIPT_NAME: string = 'ironbee-devtools-hook.mjs';

interface HookEntry {
    type: string;
    command: string;
    timeout: number;
    failClosed: boolean;
}

interface HooksConfig {
    version: number;
    hooks: Record<string, HookEntry[]>;
}

/**
 * Copy cursor-hook.mjs to <workspace>/.cursor/scripts/ and merge hook entries
 * into <workspace>/.cursor/hooks.json. Existing third-party entries are preserved.
 */
function installCursorHooks(workspaceFolder: string, hookScriptSrc: string, wsPort?: number): void {
    try {
        const cursorDir: string = path.join(workspaceFolder, '.cursor');
        const scriptsDir: string = path.join(cursorDir, 'scripts');
        const hookDest: string = path.join(scriptsDir, HOOK_SCRIPT_NAME);
        const hooksFile: string = path.join(cursorDir, 'hooks.json');

        fs.mkdirSync(scriptsDir, { recursive: true });
        fs.copyFileSync(hookScriptSrc, hookDest);

        let config: HooksConfig = { version: 1, hooks: {} };
        if (fs.existsSync(hooksFile)) {
            try {
                config = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as HooksConfig;
            } catch {
                /* use default */
            }
        }
        if (!config.hooks) {
            config.hooks = {};
        }

        // NODE_PATH ensures the hook script can import 'ws' even when the
        // workspace doesn't have it installed — we point to the extension's own node_modules.
        const extNodeModules: string = path.join(path.dirname(path.dirname(hookScriptSrc)), 'node_modules');
        const command: string =
            wsPort !== undefined
                ? process.platform === 'win32'
                    ? `set VIS_WS_PORT=${wsPort}&& set NODE_PATH=${extNodeModules}&& node ./.cursor/scripts/${HOOK_SCRIPT_NAME}`
                    : `VIS_WS_PORT=${wsPort} NODE_PATH=${extNodeModules} node ./.cursor/scripts/${HOOK_SCRIPT_NAME}`
                : process.platform === 'win32'
                    ? `set NODE_PATH=${extNodeModules}&& node ./.cursor/scripts/${HOOK_SCRIPT_NAME}`
                    : `NODE_PATH=${extNodeModules} node ./.cursor/scripts/${HOOK_SCRIPT_NAME}`;
        const entry: HookEntry = { type: 'command', command, timeout: 5, failClosed: false };

        for (const event of HOOK_EVENTS) {
            if (!config.hooks[event]) {
                config.hooks[event] = [];
            }
            // Remove stale entries from a previous install, then append fresh one
            config.hooks[event] = config.hooks[event].filter((h: HookEntry): boolean => !h.command.includes(HOOK_SCRIPT_NAME));
            config.hooks[event].push(entry);
        }

        fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
        console.log('[IronBee DevTools] Cursor hooks installed in', workspaceFolder);
    } catch (err) {
        console.warn('[IronBee DevTools] Failed to install Cursor hooks:', err);
    }
}

/**
 * Remove hook entries and the copied script from <workspace>/.cursor/.
 * hooks.json is deleted only if it becomes empty after removal.
 */
function removeCursorHooks(workspaceFolder: string): void {
    try {
        const cursorDir: string = path.join(workspaceFolder, '.cursor');
        const hookDest: string = path.join(cursorDir, 'scripts', HOOK_SCRIPT_NAME);
        const hooksFile: string = path.join(cursorDir, 'hooks.json');

        if (fs.existsSync(hookDest)) {
            fs.unlinkSync(hookDest);
        }

        if (fs.existsSync(hooksFile)) {
            let config: HooksConfig;
            try {
                config = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as HooksConfig;
            } catch {
                return;
            }
            for (const event of Object.keys(config.hooks ?? {})) {
                config.hooks[event] = (config.hooks[event] ?? []).filter(
                    (h: HookEntry): boolean => !h.command.includes(HOOK_SCRIPT_NAME)
                );
                if (config.hooks[event].length === 0) {
                    delete config.hooks[event];
                }
            }
            if (Object.keys(config.hooks ?? {}).length === 0) {
                fs.unlinkSync(hooksFile);
            } else {
                fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
            }
        }
        console.log('[IronBee DevTools] Cursor hooks removed from', workspaceFolder);
    } catch (err) {
        console.warn('[IronBee DevTools] Failed to remove Cursor hooks:', err);
    }
}

/**
 * Install or remove Cursor hooks in every open workspace folder.
 */
function syncCursorHooks(extensionPath: string, enable: boolean, wsPort?: number): void {
    const hookSrc: string = path.join(extensionPath, 'scripts', 'cursor-hook.mjs');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (enable) {
            installCursorHooks(folder.uri.fsPath, hookSrc, wsPort);
        } else {
            removeCursorHooks(folder.uri.fsPath);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Called once on first install or when extension version changes.
 * Installs Playwright browsers into the default cache. (The project Cursor rule is synced separately
 * on every activate via syncCursorRuleToWorkspaces, so it lands in each open workspace.)
 */
async function onInstall(context: vscode.ExtensionContext): Promise<void> {
    try {
        await ensurePlaywrightBrowsersInstalled(context.extensionPath, CONFIG_PREFIX, {
            extensionVersion: getExtensionVersion(context),
            trigger: 'install',
        });
    } catch (err) {
        console.error('[IronBee DevTools] onInstall failed:', err);
        const msg: string = err instanceof Error ? err.message : String(err);
        void trackCursorExtInstallFailed(
            (context.extension.packageJSON as { version?: string }).version ?? '0.0.0',
            msg
        );
    }
}

/**
 * If globalStorage .extension-version is missing or differs from current version, write it and call onInstall().
 * Returns true when first install or upgrade path ran (onInstall executed). cursor_ext_installed is sent only after bundled MCP path resolves.
 * TODO: If multiple windows (separate extension host processes) can activate at once and only one must run onInstall(),
 * use a file lock: create a .extension-version.lock file with fs.writeFileSync(..., { flag: 'wx' }); only one process succeeds;
 * others poll until the lock is removed, then re-read .extension-version and skip if already current.
 */
async function runInstallIfNeeded(context: vscode.ExtensionContext): Promise<boolean> {
    const versionFilePath: string = path.join(context.globalStoragePath, EXTENSION_VERSION_FILE);
    const currentVersion: string = getExtensionVersion(context);
    const stored: string = fs.existsSync(versionFilePath) ? fs.readFileSync(versionFilePath, 'utf8').trim() : '';
    if (stored === currentVersion) {
        return false;
    }
    try {
        fs.mkdirSync(context.globalStoragePath, { recursive: true });
        fs.writeFileSync(versionFilePath, currentVersion, 'utf8');
        await onInstall(context);
        return true;
    } catch (err) {
        const msg: string = err instanceof Error ? err.message : String(err);
        void trackCursorExtInstallFailed(currentVersion, msg);
        throw err;
    }
}

/**
 * Resolve path to @ironbee-ai/devtools dist/index.js from the VSIX-bundled copy.
 * Published builds ship platform-specific native deps (sharp) via per-target VSIX packaging in CI.
 */
async function ensureMcpServerInstalled(context: vscode.ExtensionContext): Promise<string> {
    if (cachedMcpServerPath !== null) {
        return cachedMcpServerPath;
    }
    const bundledPath: string = path.join(
        context.extensionPath,
        'node_modules',
        '@ironbee-ai',
        'devtools',
        'dist',
        'index.js'
    );

    if (fs.existsSync(bundledPath)) {
        cachedMcpServerPath = bundledPath;
        console.log('[IronBee DevTools] Using bundled MCP server:', bundledPath);
        return bundledPath;
    }

    const currentVersion: string = getExtensionVersion(context);
    const msg: string =
        'Bundled MCP server not found (@ironbee-ai/devtools). Reinstall the extension or install a fresh VSIX from the marketplace.';
    void trackCursorExtInstallFailed(currentVersion, `MCP: ${msg}`);
    const err: Error = new Error(msg);
    showErrorWithIssueLink(`IronBee DevTools: ${msg}`, false, err);
    throw err;
}

/**
 * Command palette: pick Playwright browser groups to download (Chromium pre-selected = Chrome automation stack).
 */
async function installBrowsersCommand(context: vscode.ExtensionContext): Promise<void> {
    const items: vscode.QuickPickItem[] = [
        {
            label: 'Chromium',
            description: 'Chromium, headless shell, ffmpeg (default)',
            picked: true,
        },
        { label: 'Firefox', description: 'Mozilla Firefox' },
        { label: 'WebKit', description: 'WebKit (Safari engine)' },
    ];

    const selected: vscode.QuickPickItem[] | undefined = await vscode.window.showQuickPick(items, {
        title: 'IronBee DevTools: Install Playwright browsers',
        placeHolder: 'Space to toggle, Enter to download',
        canPickMany: true,
    });

    if (selected === undefined) {
        return;
    }
    if (selected.length === 0) {
        void vscode.window.showWarningMessage('IronBee DevTools: Select at least one browser.');
        return;
    }

    const groups: PlaywrightBrowserInstallGroup[] = [];
    for (const item of selected) {
        if (item.label === 'Chromium') {
            groups.push('chromium');
        } else if (item.label === 'Firefox') {
            groups.push('firefox');
        } else if (item.label === 'WebKit') {
            groups.push('webkit');
        }
    }

    const wantChromium: boolean = groups.includes('chromium');
    const wantFirefox: boolean = groups.includes('firefox');
    const wantWebkit: boolean = groups.includes('webkit');

    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    suppressConfigDrivenBrowserReinstall = true;
    try {
        await config.update('install.chromium', wantChromium, vscode.ConfigurationTarget.Global);
        await config.update('install.firefox', wantFirefox, vscode.ConfigurationTarget.Global);
        await config.update('install.webkit', wantWebkit, vscode.ConfigurationTarget.Global);

        const ok: boolean = await installPlaywrightBrowsersByGroups(context.extensionPath, groups, {
            extensionVersion: getExtensionVersion(context),
            trigger: 'command',
            configPrefix: CONFIG_PREFIX,
        });
        if (ok) {
            void vscode.window.showInformationMessage(
                'IronBee DevTools: Updated install.* settings and finished Playwright browser download. Restart the MCP session if the server was already running.'
            );
        } else {
            void vscode.window.showWarningMessage(
                'IronBee DevTools: install.* settings were updated, but the browser download failed. Check the Output panel or try again.'
            );
        }
    } finally {
        suppressConfigDrivenBrowserReinstall = false;
    }
}

/**
 * Platforms the user has enabled (ironbeeDevTools.platform.<platform>.enable).
 * Pass a folder URI as `scope` to read that folder's effective (workspace-scoped) config.
 */
function getEnabledPlatforms(scope?: vscode.ConfigurationScope): Platform[] {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX, scope);
    return PLATFORMS.filter((platform: Platform): boolean =>
        config.get<boolean>(`platform.${platform}.enable`, DEFAULT_PLATFORM_ENABLED[platform])
    );
}

/**
 * Render the Cursor rule from the bundled template and write it into every open workspace folder's
 * .cursor/rules/ — project-scoped, shaped by that folder's enabled platforms. Re-run on activate, on
 * platform-toggle change, and when workspace folders change. Returns folders written.
 */
function syncCursorRuleToWorkspaces(extensionPath: string): number {
    let written: number = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            const rendered: string = renderCursorRule(extensionPath, getEnabledPlatforms(folder.uri));
            const destDir: string = path.join(folder.uri.fsPath, '.cursor', 'rules');
            fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(path.join(destDir, CURSOR_RULE_FILE_NAME), rendered, 'utf8');
            written += 1;
        } catch (err) {
            console.warn('[IronBee DevTools] Failed to write Cursor rule to workspace:', folder.uri.fsPath, err);
        }
    }
    return written;
}

/** Remove the project Cursor rule from every open workspace folder (on uninstall). */
function removeCursorRuleFromWorkspaces(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            const rulePath: string = path.join(folder.uri.fsPath, '.cursor', 'rules', CURSOR_RULE_FILE_NAME);
            if (fs.existsSync(rulePath)) {
                fs.unlinkSync(rulePath);
            }
        } catch (err) {
            console.warn('[IronBee DevTools] Failed to remove Cursor rule from workspace:', folder.uri.fsPath, err);
        }
    }
}

/** Remove the legacy global rule (~/.cursor/rules/) written by older versions, now that it is project-scoped. */
function removeLegacyGlobalCursorRule(): void {
    try {
        const legacyPath: string = path.join(os.homedir(), '.cursor', 'rules', CURSOR_RULE_FILE_NAME);
        if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
        }
    } catch {
        /* non-fatal */
    }
}

/**
 * Get MCP server config (command, args, env) for a given platform. Uses cached server path from
 * ensureMcpServerInstalled and injects PLATFORM so the bundled server runs that platform.
 * Returns null if extension is disabled or server path not set.
 */
function getMcpServerConfig(platform: Platform): {
    command: string;
    args: string[];
    env: Record<string, string>;
} | null {
    if (!isExtensionEnabled() || cachedMcpServerPath === null) {
        return null;
    }
    const settingsEnv: Record<string, string> = getEnvironmentFromSettings();
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && typeof value === 'string') {
            mergedEnv[key] = value;
        }
    }
    for (const [key, value] of Object.entries(settingsEnv)) {
        if (value !== undefined && typeof value === 'string') {
            mergedEnv[key] = value;
        }
    }
    mergedEnv['PLATFORM'] = platform;

    // Per-platform tool-domain filter. Each platform server is its own process, so it gets its own
    // AVAILABLE_TOOL_DOMAINS. Empty = all domains for that platform (leave the env var unset).
    const domains: string = vscode.workspace
        .getConfiguration(CONFIG_PREFIX)
        .get<string>(`platform.${platform}.availableToolDomains`, '')
        .trim();
    if (domains !== '') {
        mergedEnv['AVAILABLE_TOOL_DOMAINS'] = domains;
    } else {
        delete mergedEnv['AVAILABLE_TOOL_DOMAINS'];
    }

    return { command: 'node', args: [cachedMcpServerPath, CURSOR_MCP_SERVER_ARG], env: mergedEnv };
}

/**
 * Build GitHub issue URL with optional title and body (query params are encoded).
 */
function buildGitHubIssueUrl(title: string, body?: string): string {
    const params: URLSearchParams = new URLSearchParams();
    params.set('title', title);
    if (body) {
        params.set('body', body);
    }
    return `${GITHUB_ISSUES_BASE}?${params.toString()}`;
}

/**
 * Format error for GitHub issue body: extension version, type, message, stack.
 * Uses ** for headings so "##" is not URL-encoded to %23%23 in the issue URL.
 */
function formatErrorForIssueBody(error: unknown, extensionVersion?: string): string {
    const lines: string[] = [];
    if (extensionVersion) {
        lines.push(`**Extension version:** ${extensionVersion}`, '');
    }
    if (error instanceof Error) {
        const type: string = error.constructor?.name ?? 'Error';
        const stack: string = error.stack ?? '(no stack)';
        lines.push(
            '**Error details**',
            '',
            `**Type:** \`${type}\``,
            '',
            `**Message:** ${error.message}`,
            '',
            '**Stack:**',
            '```',
            stack,
            '```'
        );
        return lines.join('\n');
    }
    lines.push(`**Message:** ${String(error)}`);
    return lines.join('\n');
}

/**
 * Show warning/error with GitHub issue link. If `error` is provided, issue body is prefilled with extension version, type, message and stack.
 */
function showErrorWithIssueLink(message: string, isWarning: boolean = false, error?: unknown): void {
    const show: typeof vscode.window.showWarningMessage = isWarning
        ? vscode.window.showWarningMessage
        : vscode.window.showErrorMessage;
    void show(message, 'Open issue on GitHub').then((choice: string | undefined): void => {
        if (choice === 'Open issue on GitHub') {
            const title: string = message.slice(0, 100).replace(/\s+/g, ' ').trim();
            const ext: vscode.Extension<unknown> | undefined =
                vscode.extensions.getExtension('ironbee-ai.ironbee-devtools-vscode');
            const extensionVersion: string = ext?.packageJSON?.version ?? '';
            const body: string | undefined =
                error !== undefined ? formatErrorForIssueBody(error, extensionVersion) : undefined;
            void vscode.env.openExternal(vscode.Uri.parse(buildGitHubIssueUrl(title, body)));
        }
    });
}

/**
 * Register one MCP server per enabled platform with Cursor's API so they appear without the user
 * editing mcp.json. Sleeps once after registering so Cursor can process the changes.
 */
async function registerCursorMcp(): Promise<boolean> {
    const cursorMcp: ReturnType<typeof getCursorMcp> = getCursorMcp();
    if (!cursorMcp) {
        return false;
    }
    let registeredAny: boolean = false;
    for (const platform of getEnabledPlatforms()) {
        const config: ReturnType<typeof getMcpServerConfig> = getMcpServerConfig(platform);
        if (!config) {
            continue;
        }
        try {
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(config.env)) {
                if (typeof v === 'string') {
                    env[k] = v;
                }
            }
            cursorMcp.registerServer({
                name: mcpServerName(platform),
                server: {
                    command: config.command ?? 'node',
                    args: Array.isArray(config.args) ? config.args : [config.args].filter(Boolean),
                    env,
                },
            });
            console.log(`[IronBee DevTools] Registered MCP server (${platform}) with Cursor.`);
            registeredAny = true;
        } catch (err) {
            const msg: string = err instanceof Error ? err.message : String(err);
            console.warn(`[IronBee DevTools] Cursor MCP register failed (${platform}):`, msg);
            showErrorWithIssueLink(
                `IronBee DevTools: Failed to register the ${platform} MCP server with Cursor. ${msg} Please report the issue if it persists.`,
                true,
                err
            );
        }
    }
    if (registeredAny) {
        await sleep(REGISTER_UNREGISTER_SLEEP_MS);
    }
    return registeredAny;
}

/** Sleep after register/unregister so Cursor can process the change. */
const REGISTER_UNREGISTER_SLEEP_MS: number = 3_000;

function sleep(ms: number): Promise<void> {
    return new Promise((r: () => void): NodeJS.Timeout => setTimeout(r, ms));
}

/**
 * Unregister every platform MCP server from Cursor (on deactivate or disable). Unregisters all known
 * platform names (not just currently enabled ones) so toggling a platform off cleans up its server.
 * Sleeps once after unregistering so Cursor can process the changes.
 */
async function unregisterCursorMcp(): Promise<boolean> {
    const cursorMcp: ReturnType<typeof getCursorMcp> = getCursorMcp();
    if (!cursorMcp) {
        return false;
    }
    for (const platform of PLATFORMS) {
        try {
            cursorMcp.unregisterServer(mcpServerName(platform));
        } catch (err) {
            console.warn(`[IronBee DevTools] Cursor MCP unregister failed (${platform}):`, err);
        }
    }
    console.log('[IronBee DevTools] Unregistered MCP servers from Cursor.');
    await sleep(REGISTER_UNREGISTER_SLEEP_MS);
    return true;
}

/**
 * Get environment variables from VS Code settings
 */
function getEnvironmentFromSettings(): Record<string, string> {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    const env: Record<string, string> = {};

    for (const [settingKey, envVar] of Object.entries(SETTINGS_TO_ENV)) {
        const value: unknown = config.get(settingKey);

        const skip: boolean = value === undefined || value === null || (typeof value === 'string' && value === '');
        if (!skip) {
            env[envVar] = typeof value === 'boolean' ? value.toString() : String(value);
        }
    }

    return env;
}

/**
 * MCP Server Definition Provider for IronBee DevTools
 */
class IronBeeDevToolsMcpProvider implements vscode.McpServerDefinitionProvider {
    private readonly extensionPath: string;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
        if (uninstallInProgress) {
            return [];
        }
        const definitions: vscode.McpServerDefinition[] = [];
        for (const platform of getEnabledPlatforms()) {
            const config: ReturnType<typeof getMcpServerConfig> = getMcpServerConfig(platform);
            if (!config) {
                continue;
            }
            definitions.push(
                new vscode.McpStdioServerDefinition(mcpServerName(platform), config.command, config.args, config.env)
            );
        }
        return definitions;
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionPathForDeactivate = context.extensionPath;
    globalStoragePathForDeactivate = context.globalStoragePath;
    extensionVersionForDeactivate = getExtensionVersion(context);

    syncTelemetryConfigFromVscodeSetting();

    // First run or new version: update globalStorage .extension-version and run onInstall() if needed
    const didRunExtensionInstall: boolean = await runInstallIfNeeded(context);

    // before status bar uses it
    context.subscriptions.push(vscode.commands.registerCommand('ironbeeDevTools.toggleExtension', toggleExtension));

    // after command is registered
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ironbeeDevTools.toggleExtension';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Resolve bundled (VSIX) @ironbee-ai/devtools entrypoint
    await ensureMcpServerInstalled(context);

    // Register MCP: Cursor uses cursor.mcp.registerServer; VS Code uses lm.registerMcpServerDefinitionProvider (VS Code 1.101+).
    let mcpServerRegistered: boolean = false;
    if (isCursor()) {
        mcpServerRegistered = await registerCursorMcp();
    } else if (vscode.lm?.registerMcpServerDefinitionProvider) {
        const mcpProvider: IronBeeDevToolsMcpProvider = new IronBeeDevToolsMcpProvider(context.extensionPath);
        const mcpDisposable: vscode.Disposable = vscode.lm.registerMcpServerDefinitionProvider(
            'ironbee-devtools',
            mcpProvider
        );
        context.subscriptions.push(mcpDisposable);
        console.log('[IronBee DevTools] Registered MCP server with VS Code.');
        mcpServerRegistered = true;
    } else {
        const msg: string = 'No MCP API available. Use VS Code 1.101+ or a recent Cursor version.';
        console.warn('[IronBee DevTools]', msg);
        void vscode.window.showWarningMessage(`IronBee DevTools: ${msg}`);
    }

    // Full extension install success = MCP path ready (bundled per platform in published VSIX).
    // Include MCP registration result as a telemetry property.
    if (didRunExtensionInstall) {
        void trackCursorExtInstalled(getExtensionVersion(context), mcpServerRegistered);
    }
    void trackCursorExtActivated(getExtensionVersion(context), mcpServerRegistered);

    // Register Settings Webview Provider
    const settingsProvider: SettingsWebviewProvider = new SettingsWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SettingsWebviewProvider.viewType, settingsProvider)
    );

    // Register Open Settings Command
    context.subscriptions.push(
        vscode.commands.registerCommand('ironbeeDevTools.openSettings', (): void => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ironbee-ai.ironbee-devtools-vscode');
        })
    );

    // Register Install Playwright Browsers (user picks Chromium / Firefox / WebKit; Chromium pre-selected)
    context.subscriptions.push(
        vscode.commands.registerCommand('ironbeeDevTools.installBrowsers', (): Promise<void> => installBrowsersCommand(context))
    );

    // Register Restart Server Command
    context.subscriptions.push(
        vscode.commands.registerCommand('ironbeeDevTools.restartServer', async (): Promise<void> => {
            if (isExtensionEnabled()) {
                if (getCursorMcp()) {
                    await unregisterCursorMcp();
                    await registerCursorMcp();
                    void vscode.window.showInformationMessage('IronBee DevTools: Server restarted.');
                } else {
                    void vscode.window.showInformationMessage(
                        'IronBee DevTools: Restart applied. Reload the window if the server does not update.'
                    );
                }
            } else {
                void vscode.window.showInformationMessage('IronBee DevTools: Extension is disabled. Enable it first.');
            }
        })
    );

    void maybePromptExtensionUpdate(context);
    void maybePromptGitHubStar(context);

    // Register Show Visualizer command — only works when showVisualizer is true
    context.subscriptions.push(
        vscode.commands.registerCommand('ironbeeDevTools.showVisualizer', async (): Promise<void> => {
            const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
            if (!isVisualizerEnabled(cfg)) {
                void vscode.window.showInformationMessage(
                    'MCP Visualizer is disabled. Enable it in settings (ironbeeDevTools.showVisualizer) first.'
                );
                return;
            }
            const wsPort: number = cfg.get<number>('visualizer.wsPort', 3020);
            await startVisualizerWithPortFallback(context, wsPort, true);
        })
    );

    // Start visualizer WebSocket server + install Cursor hooks if enabled
    // Panel auto-opens on first run_started event from the hooks bridge
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_PREFIX);
    if (isVisualizerEnabled(config)) {
        const wsPort: number = config.get<number>('visualizer.wsPort', 3020);
        void startVisualizerWithPortFallback(context, wsPort, false);
    }

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent): void => {
            if (e.affectsConfiguration(CONFIG_PREFIX)) {
                if (e.affectsConfiguration(`${CONFIG_PREFIX}.enable`)) {
                    updateStatusBar();
                    const enabled: boolean = isExtensionEnabled();
                    if (getCursorMcp()) {
                        if (enabled) {
                            void (async (): Promise<void> => {
                                await registerCursorMcp();
                            })();
                        } else {
                            void (async (): Promise<void> => {
                                await unregisterCursorMcp();
                            })();
                        }
                    }
                    vscode.window.showInformationMessage(
                        `IronBee DevTools: Extension ${enabled ? 'enabled' : 'disabled'}. Restart the MCP session to apply changes.`
                    );
                } else if (
                    e.affectsConfiguration(`${CONFIG_PREFIX}.install.chromium`) ||
                    e.affectsConfiguration(`${CONFIG_PREFIX}.install.firefox`) ||
                    e.affectsConfiguration(`${CONFIG_PREFIX}.install.webkit`)
                ) {
                    if (suppressConfigDrivenBrowserReinstall) {
                        return;
                    }
                    void ensurePlaywrightBrowsersInstalled(extensionPathForDeactivate ?? '', CONFIG_PREFIX, {
                        extensionVersion: extensionVersionForDeactivate || '0.0.0',
                        trigger: 'settings_change',
                    });
                    vscode.window.showInformationMessage(
                        'IronBee DevTools: Browser install settings changed. Browsers are being updated; restart the MCP session if it was already running.'
                    );
                } else if (e.affectsConfiguration(`${CONFIG_PREFIX}.showVisualizer`)) {
                    const vizEnabled: boolean = vscode.workspace
                        .getConfiguration(CONFIG_PREFIX)
                        .get<boolean>('showVisualizer', false);
                    if (vizEnabled) {
                        const wsPort: number = vscode.workspace
                            .getConfiguration(CONFIG_PREFIX)
                            .get<number>('visualizer.wsPort', 3020);
                        void startVisualizerWithPortFallback(context, wsPort, false);
                    } else {
                        void closeVisualizer();
                        activeVisualizerPort = null;
                        syncCursorHooks(context.extensionPath, false);
                    }
                } else if (e.affectsConfiguration(`${CONFIG_PREFIX}.telemetry.enable`)) {
                    syncTelemetryConfigFromVscodeSetting();
                } else if (
                    e.affectsConfiguration(`${CONFIG_PREFIX}.platform.browser.enable`) ||
                    e.affectsConfiguration(`${CONFIG_PREFIX}.platform.node.enable`) ||
                    e.affectsConfiguration(`${CONFIG_PREFIX}.platform.backend.enable`)
                ) {
                    // Re-render the project Cursor rule so the enabled platforms' sections match, then
                    // re-register the per-platform MCP servers (Cursor) for the new selection.
                    syncCursorRuleToWorkspaces(context.extensionPath);
                    if (getCursorMcp() && isExtensionEnabled()) {
                        void (async (): Promise<void> => {
                            await unregisterCursorMcp();
                            await registerCursorMcp();
                        })();
                    }
                    vscode.window.showInformationMessage(
                        'IronBee DevTools: Enabled platforms changed. Updated the Cursor rule; restart the MCP session to apply.'
                    );
                } else {
                    if (getCursorMcp() && isExtensionEnabled()) {
                        void (async (): Promise<void> => {
                            await unregisterCursorMcp();
                            await registerCursorMcp();
                        })();
                    }
                    vscode.window.showInformationMessage(
                        'IronBee DevTools: Settings changed. Restart the MCP session to apply changes.'
                    );
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async (): Promise<void> => {
            // Ensure newly-added workspace folders get the project Cursor rule (rendered for their config).
            syncCursorRuleToWorkspaces(context.extensionPath);
            if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
                await closeVisualizer();
                activeVisualizerPort = null;
            }
        })
    );

    // Write the project Cursor rule into each open workspace's .cursor/rules/, and clean up the
    // legacy global rule older versions wrote to ~/.cursor/rules/.
    removeLegacyGlobalCursorRule();
    const ruleFoldersWritten: number = syncCursorRuleToWorkspaces(context.extensionPath);
    if (didRunExtensionInstall && ruleFoldersWritten > 0 && statusBarItem) {
        statusBarItem.text = '$(globe) IronBee DevTools · Cursor rule installed';
        statusBarItem.tooltip = 'IronBee DevTools: Cursor rule added to this workspace’s .cursor/rules';
        setTimeout((): void => updateStatusBar(), CURSOR_RULE_STATUS_DURATION_MS);
    }

    console.log('IronBee DevTools extension activated successfully');
}

/**
 * Called when this process successfully deleted .extension-version in runUninstallIfNeeded (so only one process calls it when many deactivate concurrently).
 */
async function onUninstall(mcpServerUnregistered: boolean): Promise<void> {
    // Remove Cursor hooks from all open workspace folders
    if (extensionPathForDeactivate) {
        syncCursorHooks(extensionPathForDeactivate, false);
    }

    try {
        removeCursorRuleFromWorkspaces();
        removeLegacyGlobalCursorRule();
        if (statusBarItem) {
            statusBarItem.text = '$(globe) IronBee DevTools · Cursor rule removed';
            statusBarItem.tooltip = 'IronBee DevTools: Cursor rule removed from the workspace .cursor/rules';
        }
    } catch (err) {
        console.error('[IronBee DevTools] Failed to remove Cursor rule from workspace .cursor/rules:', err);
        const msg: string = err instanceof Error ? err.message : String(err);
        void trackCursorExtUninstallFailed(extensionVersionForDeactivate, msg);
    }

    try {
        await trackCursorExtUninstalled(extensionVersionForDeactivate || '0.0.0', mcpServerUnregistered);
    } catch (err) {
        console.error('[IronBee DevTools] Failed to track cursor extension uninstalled:', err);
        const msg: string = err instanceof Error ? err.message : String(err);
        void trackCursorExtUninstallFailed(extensionVersionForDeactivate, msg);
    }
}

/**
 * Try to delete globalStorage .extension-version; only the process that succeeds calls onUninstall(), so concurrent deactivates (e.g. multiple windows) result in a single onUninstall().
 */
async function runUninstallIfNeeded(mcpServerUnregistered: boolean): Promise<void> {
    if (!globalStoragePathForDeactivate) {
        return;
    }
    const versionFilePath: string = path.join(globalStoragePathForDeactivate, EXTENSION_VERSION_FILE);
    if (!fs.existsSync(versionFilePath)) {
        return;
    }
    try {
        fs.unlinkSync(versionFilePath);
    } catch (err) {
        const code: string | undefined =
            err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
        if (code === 'ENOENT') {
            return;
        }
        throw err;
    }
    await onUninstall(mcpServerUnregistered);
}

export async function deactivate(): Promise<void> {
    await closeVisualizer();
    activeVisualizerPort = null;
    let mcpServerUnregistered: boolean = false;
    if (isCursor()) {
        mcpServerUnregistered = await unregisterCursorMcp();
    }
    await trackCursorExtDeactivated(extensionVersionForDeactivate || '0.0.0', mcpServerUnregistered);
    console.log('IronBee DevTools extension deactivated');

    // If we're in .obsolete, host is uninstalling us; runUninstallIfNeeded (only one process calls onUninstall when many deactivate).
    if (extensionPathForDeactivate) {
        try {
            const extensionsDir: string = path.dirname(extensionPathForDeactivate);
            const obsoletePath: string = path.join(extensionsDir, '.obsolete');
            const folderName: string = path.basename(extensionPathForDeactivate);
            if (fs.existsSync(obsoletePath)) {
                const content: string = fs.readFileSync(obsoletePath, 'utf8').trim();
                const obsolete: Record<string, boolean> = content
                    ? (JSON.parse(content) as Record<string, boolean>)
                    : {};
                if (obsolete[folderName] === true) {
                    if (!isCursor()) {
                        // VS Code unregisters MCP provider via deactivate; while uninstalling,
                        // provider returns [] so host does not assume server is still available.
                        uninstallInProgress = true;
                        mcpServerUnregistered = true;
                    }
                    await runUninstallIfNeeded(mcpServerUnregistered);
                }
            }
        } catch {
            /* non-fatal */
        }
    }
}
