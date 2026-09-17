import assert from "node:assert/strict";
import test from "node:test";
import { Registry } from "@dev-harness-runtime/core";
import { BuildRegistry } from "../dist/targets/index.js";

test("BuildRegistry reuses core registration and lists explicit target metadata", () => {
  const registry = new BuildRegistry();
  assert.ok(registry instanceof Registry);
  assert.deepEqual(registry.list(), []);
  registry.register({ id: "npm", label: "npm package" });
  registry.register({ id: "archive", label: "Archive" });
  assert.deepEqual(registry.get("npm"), { id: "npm", label: "npm package" });
  assert.deepEqual(registry.list().map(({ id }) => id), ["npm", "archive"]);
});

test("BuildRegistry diagnoses invalid, duplicate, and unknown IDs", () => {
  const registry = new BuildRegistry();
  assert.throws(() => registry.register({ id: "" }), /Build registry id must be lowercase kebab-case/);
  assert.throws(() => registry.get("Bad ID"), /Build registry id must be lowercase kebab-case/);
  registry.register({ id: "npm", label: "Original" });
  assert.throws(() => registry.register({ id: "npm" }), /Build registry already contains id "npm"/);
  assert.equal(registry.get("npm").label, "Original");
  assert.throws(() => registry.get("missing"), /Build registry has no entry with id "missing"/);
});

test("BuildRegistry protects metadata identity from caller and list mutations", () => {
  const registry = new BuildRegistry();
  const original = { id: "npm", label: "Original" };
  registry.register(original);
  original.id = "renamed";
  original.label = "Changed";

  const stored = registry.get("npm");
  assert.deepEqual(stored, { id: "npm", label: "Original" });
  assert.ok(Object.isFrozen(stored));
  assert.throws(() => { stored.id = "renamed"; }, TypeError);
  assert.throws(() => registry.get("renamed"), /no entry with id "renamed"/);
  assert.throws(() => registry.register({ id: "npm" }), /already contains id "npm"/);

  const listed = registry.list();
  assert.equal(listed[0], stored);
  listed.push({ id: "injected" });
  listed.reverse();
  assert.deepEqual(registry.list(), [stored]);
});
