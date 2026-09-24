import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNote } from "../src/validate.js";

test("requires a title", () => {
  assert.equal(validateNote({}), "title is required");
});

test("accepts a normal note", () => {
  assert.equal(validateNote({ title: "Shopping", tags: ["home"] }), null);
});
