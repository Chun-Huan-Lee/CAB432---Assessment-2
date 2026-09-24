/** Structured JSON logs so CloudWatch Logs Insights can query them. */
export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields, at: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
