# API reference

All endpoints accept and return JSON.

## GET /health
Returns `{ "ok": true }`.

## GET /notes
Lists all notes. Optional query parameter `tag` filters by tag.

## POST /notes
Creates a note.

```json
{ "title": "Shopping", "body": "milk, eggs", "tags": ["home"] }
```

`title` is required (max 200 characters).

## GET /notes/:id
Returns one note or 404.

## PATCH /notes/:id
Partially updates a note. Only the fields you send are changed.

## DELETE /notes/:id
Deletes a note. Returns 204.
