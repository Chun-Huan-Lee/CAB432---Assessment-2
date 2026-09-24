const MAX_TITLE = 120;

export function validateNote(note) {
  if (!note || typeof note !== "object") return "body must be a JSON object";
  if (typeof note.title !== "string" || note.title.length === 0) return "title is required";
  if (note.title.length > MAX_TITLE) return `title must be at most ${MAX_TITLE} characters`;
  if (note.tags !== undefined && !Array.isArray(note.tags)) return "tags must be an array";
  return null;
}
