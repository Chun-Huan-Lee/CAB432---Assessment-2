import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export class NoteStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  async save(notes) {
    await writeFile(this.file, JSON.stringify(notes, null, 2));
  }

  async list(tag) {
    const notes = await this.load();
    return tag ? notes.filter((note) => note.tags.includes(tag)) : notes;
  }

  async get(id) {
    return (await this.load()).find((note) => note.id === id);
  }

  async create({ title, body = "", tags = [] }) {
    const notes = await this.load();
    const note = { id: randomUUID(), title, body, tags, createdAt: new Date().toISOString() };
    notes.push(note);
    await this.save(notes);
    return note;
  }

  async update(id, { title, body = "", tags = [] }) {
    const notes = await this.load();
    const note = notes.find((item) => item.id === id);
    if (!note) return undefined;
    Object.assign(note, { title, body, tags, updatedAt: new Date().toISOString() });
    await this.save(notes);
    return note;
  }
}
