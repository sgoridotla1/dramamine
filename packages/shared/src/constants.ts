/** ID of the unpacked extension, derived from the fixed `key` in its manifest. */
export const EXTENSION_ID = 'ildcchlpijabnelkljejjenokbiklaek';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** MCP servers listen on the first free port of this range, so the extension can find running agent sessions. */
export const DISCOVERY_PORT_FIRST = 47600;
export const DISCOVERY_PORT_COUNT = 20;
