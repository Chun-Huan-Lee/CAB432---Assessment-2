# tiny-notes-api

A tiny JSON notes API with no dependencies. Notes are stored in a local JSON file.

## Getting started

```bash
npm install
npm run serve
```

The server starts on **http://localhost:3000**.

## Configuration

| Variable     | Default      | Description                      |
|--------------|--------------|----------------------------------|
| `PORT`       | `3000`       | Port the server listens on       |
| `NOTES_FILE` | `notes.json` | Where notes are stored           |

## API

See [docs/API.md](docs/API.md).

## Tests

```bash
npm test
```
