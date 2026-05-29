<!-- Browser platform is ENABLED for this project (ironbee-dt-browser MCP server). -->

## Browser platform: only IronBee DevTools

**For any browser-related work you MUST use only the IronBee DevTools browser tools.** It is
**FORBIDDEN** to use:

- Cursor's built-in browser agent, MCP, or skill
- Any other external browser agent, MCP, or skill

Navigation, screenshots, form filling, testing, debugging, or any web interaction must go through
IronBee DevTools browser tools only.

### Browser tools

- **Navigation** – go to URL, reload, back/forward (`navigation_*`)
- **Content** – full-page or element screenshots, HTML/text, PDF, video (`content_*`)
- **Interaction** – click, fill, hover, scroll, keyboard, drag, select (`interaction_*`)
- **Accessibility** – ARIA / AX tree snapshots; refs from `a11y_take-aria-snapshot` drive interaction (`a11y_*`)
- **Observability** – Web Vitals, console messages, HTTP requests, trace IDs (`o11y_*`)
- **Stubbing** – mock HTTP responses, intercept requests (`stub_*`)
- **Sync** – wait for network idle (`sync_*`)
- **React** – component / element inspection (`react_*`); **Figma** – compare page to design (`figma_*`); **Debug** – tracepoints, logpoints, exceptionpoints, probe snapshots (`debug_*`)

### Verify a UI change

Open the affected page (`navigation_go-to`) → functionally exercise the change (click / fill / submit —
not just look at it) → confirm with a screenshot (`content_take-screenshot`) and/or an ARIA snapshot
(`a11y_take-aria-snapshot`) → check `o11y_get-console-messages` for errors. Prefer one `execute` script
when the flow is more than 2–3 calls.
