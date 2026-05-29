import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Renders the Cursor rule (ironbee-devtools-use.mdc) from a template that carries one HTML-comment
 * marker block per platform:
 *
 *     <!--IRONBEE:PLATFORM:browser-->
 *     ...placeholder comment (disabled state) OR platform fragment (enabled state)...
 *     <!--/IRONBEE:PLATFORM:browser-->
 *
 * When a platform is enabled, its marker block's inner content is replaced with the matching fragment
 * from rules/platforms/rule.<platform>.md. When disabled, the template's placeholder comment is left
 * in place — it is an HTML comment, so it has no effect on the agent. The markers are preserved so the
 * output mirrors the template, and the render is always recomputed from the pristine template.
 */

/** Platforms that have a marker block in the rule template (order is cosmetic). */
const RULE_PLATFORMS: readonly string[] = ['browser', 'node', 'backend'];

const RULE_TEMPLATE_NAME: string = 'ironbee-devtools-use.mdc';

function startMarker(platform: string): string {
    return `<!--IRONBEE:PLATFORM:${platform}-->`;
}

function endMarker(platform: string): string {
    return `<!--/IRONBEE:PLATFORM:${platform}-->`;
}

/**
 * Read the rule template from `<extensionPath>/rules/` and fill the marker block of every enabled
 * platform with its fragment. Disabled platforms keep the template's placeholder comment.
 */
export function renderCursorRule(extensionPath: string, enabledPlatforms: readonly string[]): string {
    const rulesDir: string = path.join(extensionPath, 'rules');
    let content: string = fs.readFileSync(path.join(rulesDir, RULE_TEMPLATE_NAME), 'utf8');

    for (const platform of RULE_PLATFORMS) {
        if (!enabledPlatforms.includes(platform)) {
            continue; // leave the template's placeholder comment (disabled state)
        }
        const fragmentPath: string = path.join(rulesDir, 'platforms', `rule.${platform}.md`);
        if (!fs.existsSync(fragmentPath)) {
            console.warn(`[IronBee DevTools] Missing rule fragment for platform '${platform}': ${fragmentPath}`);
            continue;
        }

        const start: string = startMarker(platform);
        const end: string = endMarker(platform);
        const startIdx: number = content.indexOf(start);
        if (startIdx === -1) {
            continue;
        }
        const innerStart: number = startIdx + start.length;
        const endIdx: number = content.indexOf(end, innerStart);
        if (endIdx === -1) {
            continue;
        }

        const fragment: string = fs.readFileSync(fragmentPath, 'utf8').trimEnd();
        content = `${content.slice(0, innerStart)}\n${fragment}\n${content.slice(endIdx)}`;
    }

    return content;
}
