// Result shaping + safe serialization for MCP tool outputs.
//
// Every tool returns a human-readable `summary` plus the structured payload.
// Where a chain write happened the payload carries `txid` (raw hex, as the SDK
// and node return it). Amounts are BASE UNITS everywhere and serialized as
// strings so no precision is lost crossing the JSON boundary.

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** JSON.stringify that renders bigint as a decimal string. */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

function normalize(value: unknown): unknown {
  return JSON.parse(jsonSafe(value ?? {}));
}

/** Build a success result. `summary` is a one-liner for the agent/human;
 *  `data` is merged into structuredContent (with bigints → strings). */
export function ok(summary: string, data: Record<string, unknown> = {}): ToolResult {
  const payload: Record<string, unknown> = { summary, ...(normalize(data) as object) };
  return {
    content: [{ type: "text", text: `${summary}\n\n${jsonSafe(payload)}` }],
    structuredContent: payload,
  };
}

/** Build an error result (reported to the model, not thrown). */
export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    structuredContent: { summary: `error: ${message}`, error: message },
    isError: true,
  };
}

/** Parse a base-units amount supplied as a string (or number) into bigint. */
export function toBaseUnits(v: string | number, field: string): bigint {
  try {
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error("not an integer");
      return BigInt(v);
    }
    return BigInt(v.trim());
  } catch {
    throw new Error(`${field} must be an integer amount in base units (as a string), got: ${String(v)}`);
  }
}
