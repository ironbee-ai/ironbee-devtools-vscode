/**
 * Telemetry for IronBee DevTools VS Code extension.
 * - cursor_ext_installed: after activate when first install/upgrade ran AND bundled MCP server path resolved
 * - cursor_ext_install_failed: first-run failures (e.g. rule copy) or bundled MCP missing at activate
 * - cursor_ext_browser_installed / cursor_ext_browser_install_failed: Playwright browser download success/failure
 * - cursor_ext_activated / cursor_ext_deactivated: extension process lifecycle events
 * - cursor_ext_uninstalled: from extension deactivate when .obsolete indicates uninstall
 * Uses ~/.ironbee-devtools/config.json for anonymousId (same file the bundled @ironbee-ai/devtools server reads/writes).
 * Opt-out: TELEMETRY_ENABLE=false or config.telemetryEnabled.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where Playwright browser install was triggered (install/upgrade, settings change, or Install Browsers command). */
export type BrowserInstallTelemetryTrigger = 'install' | 'settings_change' | 'command';

export interface BrowserInstallTelemetryContext {
    extensionVersion: string;
    trigger: BrowserInstallTelemetryTrigger;
}

const POSTHOG_API_KEY: string = process.env.POSTHOG_API_KEY || 'phc_ekFEnQ9ipk0F1BbO0KCkaD8OaYPa4bIqqUoxsCfeFsy';
const POSTHOG_HOST: string = 'us.i.posthog.com';
const POSTHOG_PATH: string = '/i/v0/e/';

const CONFIG_DIR: string = path.join(os.homedir(), '.ironbee-devtools');
const CONFIG_FILE: string = path.join(CONFIG_DIR, 'config.json');

interface Config {
    anonymousId?: string;
    telemetryEnabled?: boolean;
    telemetryNoticeShown?: boolean;
}

function readOrCreateConfig(): Config {
    try {
        let existing: Config = {};
        if (fs.existsSync(CONFIG_FILE)) {
            try {
                existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
            } catch {
                /* corrupt */
            }
        }
        let dirty: boolean = false;
        if (!existing.anonymousId) {
            existing.anonymousId = crypto.randomUUID();
            dirty = true;
        }
        if (existing.telemetryEnabled === undefined) {
            existing.telemetryEnabled = true;
            dirty = true;
        }
        if (existing.telemetryNoticeShown === undefined) {
            existing.telemetryNoticeShown = false;
            dirty = true;
        }
        if (dirty) {
            try {
                if (!fs.existsSync(CONFIG_DIR)) {
                    fs.mkdirSync(CONFIG_DIR, { recursive: true });
                }
                fs.writeFileSync(
                    CONFIG_FILE,
                    JSON.stringify(
                        {
                            anonymousId: existing.anonymousId,
                            telemetryEnabled: existing.telemetryEnabled,
                            telemetryNoticeShown: existing.telemetryNoticeShown,
                        },
                        null,
                        2
                    ),
                    'utf8'
                );
            } catch {
                /* non-fatal */
            }
        }
        return existing;
    } catch {
        return { anonymousId: '', telemetryEnabled: false, telemetryNoticeShown: false };
    }
}

export function isTelemetryEnabled(): boolean {
    try {
        if (process.env.TELEMETRY_ENABLE === 'false') {
            return false;
        }
        return readOrCreateConfig().telemetryEnabled === true;
    } catch {
        return false;
    }
}

/**
 * Write telemetryEnabled to ~/.ironbee-devtools/config.json. Used by the extension to sync the telemetry.enable setting.
 */
export function writeTelemetryEnabledToConfig(enabled: boolean): void {
    try {
        const config: Config = readOrCreateConfig();
        config.telemetryEnabled = enabled;
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(
            CONFIG_FILE,
            JSON.stringify(
                {
                    anonymousId: config.anonymousId,
                    telemetryEnabled: config.telemetryEnabled,
                    telemetryNoticeShown: config.telemetryNoticeShown,
                },
                null,
                2
            ),
            'utf8'
        );
    } catch (err) {
        console.error('[IronBee DevTools] Failed to write telemetry enabled to config:', err);
    }
}

function captureEvent(event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
    return new Promise((resolve: () => void): void => {
        try {
            const body: string = JSON.stringify({
                api_key: POSTHOG_API_KEY,
                event,
                distinct_id: distinctId,
                properties,
            });
            const req: http.ClientRequest = https.request(
                {
                    hostname: POSTHOG_HOST,
                    path: POSTHOG_PATH,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                },
                (res: http.IncomingMessage): void => {
                    res.on('data', (): void => {});
                    res.on('end', (): void => resolve());
                    res.on('close', (): void => resolve());
                }
            );
            req.on('error', (): void => resolve());
            req.write(body);
            req.end();
        } catch {
            resolve();
        }
    });
}

function buildBaseProperties(extensionVersion: string): Record<string, unknown> {
    return {
        source: 'cursor-ext',
        extension_version: extensionVersion,
        node_version: process.version,
        os_platform: process.platform,
        os_arch: process.arch,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: new Date().toISOString(),
    };
}

export async function trackCursorExtInstalled(extensionVersion: string, mcpServerRegistered: boolean): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_installed', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        mcp_server_registered: mcpServerRegistered,
    });
}

export async function trackCursorExtActivated(extensionVersion: string, mcpServerRegistered: boolean): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_activated', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        mcp_server_registered: mcpServerRegistered,
    });
}

export async function trackCursorExtInstallFailed(extensionVersion: string, errorMessage: string): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_install_failed', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        error_message: errorMessage,
    });
}

export async function trackCursorExtBrowserInstalled(
    extensionVersion: string,
    trigger: BrowserInstallTelemetryTrigger,
    browserComponents: string
): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_browser_installed', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        browser_install_trigger: trigger,
        browser_components: browserComponents,
    });
}

export async function trackCursorExtBrowserInstallFailed(
    extensionVersion: string,
    trigger: BrowserInstallTelemetryTrigger,
    errorMessage: string
): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_browser_install_failed', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        browser_install_trigger: trigger,
        error_message: errorMessage,
    });
}

/**
 * Send cursor_ext_uninstalled. Await in deactivate when .obsolete indicates uninstall so request completes before process exits.
 */
export async function trackCursorExtUninstalled(
    extensionVersion: string,
    mcpServerUnregistered: boolean
): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    let config: Config;
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            return;
        }
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
    } catch {
        return;
    }
    if (!config.anonymousId || config.telemetryEnabled === false) {
        return;
    }
    await captureEvent('cursor_ext_uninstalled', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        mcp_server_unregistered: mcpServerUnregistered,
    });
}

export async function trackCursorExtDeactivated(
    extensionVersion: string,
    mcpServerUnregistered: boolean
): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_deactivated', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        mcp_server_unregistered: mcpServerUnregistered,
    });
}

/**
 * Send cursor_ext_uninstall_failed when extension uninstall path fails (e.g. rule remove or trackCursorExtUninstalled).
 */
export async function trackCursorExtUninstallFailed(extensionVersion: string, errorMessage: string): Promise<void> {
    if (!isTelemetryEnabled()) {
        return;
    }
    const config: Config = readOrCreateConfig();
    if (!config.anonymousId) {
        return;
    }
    await captureEvent('cursor_ext_uninstall_failed', config.anonymousId, {
        ...buildBaseProperties(extensionVersion),
        error_message: errorMessage,
    });
}
