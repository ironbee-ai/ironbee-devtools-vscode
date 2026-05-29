import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    trackCursorExtBrowserInstallFailed,
    trackCursorExtBrowserInstalled,
    type BrowserInstallTelemetryContext,
} from './telemetry';
const nodeRequire: NodeRequire = createRequire(__filename);

/** playwright-core's programmatic browser installer (same shape across versions). */
type InstallFn = (browsers: string[]) => Promise<boolean | void>;

/**
 * Resolve playwright-core's `installBrowsersForNpmInstall`. Its location moved across versions:
 *  - playwright-core >= ~1.60 bundles it into `lib/coreBundle.js` under `registry`;
 *  - older versions exported it directly from `lib/server/index.js`.
 * Returns null when playwright-core is not bundled or the function can't be resolved.
 */
function resolveInstallBrowsersForNpmInstall(extensionPath: string): InstallFn | null {
    const playwrightCoreDir: string = path.join(extensionPath, 'node_modules', 'playwright-core');
    if (!fs.existsSync(playwrightCoreDir)) {
        return null;
    }
    const candidates: Array<{ file: string; pick: (mod: unknown) => unknown }> = [
        {
            file: path.join(playwrightCoreDir, 'lib', 'coreBundle.js'),
            pick: (mod: unknown): unknown =>
                (mod as { registry?: { installBrowsersForNpmInstall?: unknown } })?.registry
                    ?.installBrowsersForNpmInstall,
        },
        {
            file: path.join(playwrightCoreDir, 'lib', 'server', 'index.js'),
            pick: (mod: unknown): unknown => (mod as { installBrowsersForNpmInstall?: unknown })?.installBrowsersForNpmInstall,
        },
    ];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate.file)) {
            continue;
        }
        try {
            const fn: unknown = candidate.pick(nodeRequire(candidate.file));
            if (typeof fn === 'function') {
                return fn as InstallFn;
            }
        } catch {
            /* try next candidate */
        }
    }
    return null;
}

/** Same groups as @ironbee-ai/devtools postinstall.cjs */
const CHROMIUM_BROWSERS: readonly string[] = ['chromium', 'chromium-headless-shell', 'ffmpeg'];
const FIREFOX_BROWSERS: readonly string[] = ['firefox'];
const WEBKIT_BROWSERS: readonly string[] = ['webkit'];

const CHROMIUM_BROWSER_NAME_SET: ReadonlySet<string> = new Set(CHROMIUM_BROWSERS);

export type PlaywrightBrowserInstallGroup = 'chromium' | 'firefox' | 'webkit';

/** Telemetry + optional config scope so install failures can offer “use system Chrome”. */
export type PlaywrightBrowserInstallCallOptions = BrowserInstallTelemetryContext & {
    configPrefix?: string;
};

/**
 * Map high-level groups to Playwright registry names passed to installBrowsersForNpmInstall.
 */
export function browserNamesForGroups(groups: PlaywrightBrowserInstallGroup[]): string[] {
    const names: string[] = [];
    const set: Set<PlaywrightBrowserInstallGroup> = new Set(groups);
    if (set.has('chromium')) {
        names.push(...CHROMIUM_BROWSERS);
    }
    if (set.has('firefox')) {
        names.push(...FIREFOX_BROWSERS);
    }
    if (set.has('webkit')) {
        names.push(...WEBKIT_BROWSERS);
    }
    return names;
}

function collectBrowserNames(config: vscode.WorkspaceConfiguration): string[] {
    const groups: PlaywrightBrowserInstallGroup[] = [];
    if (config.get<boolean>('install.chromium', true)) {
        groups.push('chromium');
    }
    if (config.get<boolean>('install.firefox', false)) {
        groups.push('firefox');
    }
    if (config.get<boolean>('install.webkit', false)) {
        groups.push('webkit');
    }
    return browserNamesForGroups(groups);
}

function namesIncludeChromiumStack(names: string[]): boolean {
    return names.some((n: string): boolean => CHROMIUM_BROWSER_NAME_SET.has(n));
}

async function promptUseSystemChromeAfterDownloadFailure(configPrefix: string, errorDetail: string): Promise<void> {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(configPrefix);
    if (config.get<boolean>('browser.useSystemBrowser', false)) {
        return;
    }
    if (!config.get<boolean>('platform.browser.enable', true)) {
        return;
    }
    const detail: string = errorDetail.length > 800 ? `${errorDetail.slice(0, 797)}...` : errorDetail;
    const choice: 'Use Google Chrome' | 'Not now' | undefined = await vscode.window.showWarningMessage(
        'IronBee DevTools: Playwright browser download failed. Switch to installed Google Chrome for automation? (Google Chrome must be installed on this machine.)',
        { modal: false, detail },
        'Use Google Chrome',
        'Not now'
    );
    if (choice !== 'Use Google Chrome') {
        return;
    }
    await config.update('browser.useSystemBrowser', true, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
        'IronBee DevTools: Using installed Google Chrome. Restart the MCP session or run "IronBee DevTools: Restart Server" to apply.'
    );
}

export type RunPlaywrightBrowserInstallOptions = {
    telemetry?: BrowserInstallTelemetryContext;
    /** When set, a failed Chromium download may prompt to enable `browser.useSystemBrowser`. */
    configPrefix?: string;
};

/**
 * Download the given Playwright browser binaries into the default cache.
 * Does not read settings (no platform / system-browser skip).
 * @returns whether the install completed without error
 */
export async function runPlaywrightBrowserInstall(
    extensionPath: string,
    names: string[],
    opts?: RunPlaywrightBrowserInstallOptions
): Promise<boolean> {
    if (names.length === 0) {
        return true;
    }

    const installBrowsersForNpmInstall: InstallFn | null = resolveInstallBrowsersForNpmInstall(extensionPath);
    if (installBrowsersForNpmInstall === null) {
        console.warn('[IronBee DevTools] playwright-core installer not resolvable under extension; skip browser install');
        void vscode.window.showErrorMessage(
            'IronBee DevTools: Playwright installer (playwright-core) not found in the extension. Reinstall the extension.'
        );
        if (opts?.telemetry) {
            void trackCursorExtBrowserInstallFailed(
                opts.telemetry.extensionVersion,
                opts.telemetry.trigger,
                'playwright-core installBrowsersForNpmInstall not resolvable'
            );
        }
        return false;
    }

    let ok: boolean = false;
    let downloadExecutionFailed: boolean = false;
    let installErrorMessage: string = '';
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'IronBee DevTools',
            cancellable: false,
        },
        async (progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> => {
            progress.report({ message: `Installing Playwright browsers (${names.join(', ')})…` });
            const hadSkip: string | undefined = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
            if (hadSkip !== undefined) {
                delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
            }
            try {
                await installBrowsersForNpmInstall(names);
                ok = true;
            } catch (err) {
                const msg: string = err instanceof Error ? err.message : String(err);
                installErrorMessage = msg;
                downloadExecutionFailed = true;
                console.error('[IronBee DevTools] Playwright browser install failed:', msg);
                if (opts?.telemetry) {
                    void trackCursorExtBrowserInstallFailed(
                        opts.telemetry.extensionVersion,
                        opts.telemetry.trigger,
                        msg
                    );
                }
            } finally {
                if (hadSkip !== undefined) {
                    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = hadSkip;
                }
            }
            progress.report({ message: 'Playwright browser step finished.' });
        }
    );
    if (!ok && downloadExecutionFailed && installErrorMessage) {
        if (opts?.configPrefix && namesIncludeChromiumStack(names)) {
            await promptUseSystemChromeAfterDownloadFailure(opts.configPrefix, installErrorMessage);
        } else {
            void vscode.window.showWarningMessage(
                `IronBee DevTools: Playwright browser install failed. ${installErrorMessage} Try again or check your network / disk space / proxy.`
            );
        }
    }
    if (ok && opts?.telemetry) {
        void trackCursorExtBrowserInstalled(opts.telemetry.extensionVersion, opts.telemetry.trigger, names.join(','));
    }
    return ok;
}

/**
 * Install browsers for the selected groups (used by the "Install Playwright Browsers" command).
 */
export async function installPlaywrightBrowsersByGroups(
    extensionPath: string,
    groups: PlaywrightBrowserInstallGroup[],
    options?: PlaywrightBrowserInstallCallOptions
): Promise<boolean> {
    const names: string[] = browserNamesForGroups(groups);
    return runPlaywrightBrowserInstall(extensionPath, names, {
        telemetry:
            options !== undefined
                ? { extensionVersion: options.extensionVersion, trigger: options.trigger }
                : undefined,
        configPrefix: options?.configPrefix,
    });
}

/**
 * Download Playwright browser binaries into the default cache (e.g. ~/Library/Caches/ms-playwright).
 * Uses playwright-core's registry (same as `npx playwright install` / npm postinstall).
 * Skipped when using system browser or when platform is not `browser`.
 */
export async function ensurePlaywrightBrowsersInstalled(
    extensionPath: string,
    configPrefix: string,
    telemetry?: BrowserInstallTelemetryContext
): Promise<void> {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(configPrefix);

    if (config.get<boolean>('browser.useSystemBrowser', false)) {
        return;
    }
    if (!config.get<boolean>('platform.browser.enable', true)) {
        return;
    }

    const names: string[] = collectBrowserNames(config);
    await runPlaywrightBrowserInstall(extensionPath, names, {
        telemetry,
        configPrefix,
    });
}
