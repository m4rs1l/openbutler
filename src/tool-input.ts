/**
 * Faithful, complete, single-source rendering of a tool input: every top-level
 * key the model passed, values inline and untruncated. One renderer for every
 * surface, so an expanded tool row always shows exactly what will run — built-in
 * tools through their curated title plus a `· rest` tail, everything else
 * (MCP, server-provided, future tools) through this directly.
 *
 * Strings are JSON-stringified, which keeps newlines visible as \n and doubles
 * backslashes; the wrapping <pre> still breaks the line anywhere, so a 2 KB
 * PowerShell command stays readable, just longer.
 */
export function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${renderValue(value)}`).join(', ')} }`;
}

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(renderValue).join(', ')}]`;
  if (typeof value === 'object') return formatToolInput(value as Record<string, unknown>);
  return JSON.stringify(String(value)) ?? String(value);
}

/** Pick only the given top-level keys from a tool input, preserving order. */
export function pickToolInputKeys(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  if (keys.length === 0) return input;
  const wanted = new Set(keys);
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (wanted.has(key)) picked[key] = value;
  }
  return picked;
}
