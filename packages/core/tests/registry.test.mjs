import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRegistry, Registry } from "../dist/index.js";

test("Registry explicitly registers and lists metadata in registration order", () => {
  const registry = new Registry();
  assert.deepEqual(registry.list(), []);
  registry.register({ id: "dsh", label: "DSH" });
  registry.register({ id: "opencode-v2", label: "OpenCode" });
  assert.deepEqual(registry.get("dsh"), { id: "dsh", label: "DSH" });
  assert.deepEqual(registry.list().map(({ id }) => id), ["dsh", "opencode-v2"]);
});

test("Registry rejects invalid IDs during registration and lookup", () => {
  const registry = new Registry();
  for (const id of ["", " ", "Dsh", " dsh", "dsh ", "dsh\n", "-dsh", "dsh-", "a--b", "a/b", "a_b", "a.b", "1dsh", undefined, null, 42, 1n]) {
    assert.throws(() => registry.register({ id }), /Registry id must be lowercase kebab-case/);
    assert.throws(() => registry.get(id), /Registry id must be lowercase kebab-case/);
  }
  assert.deepEqual(registry.list(), []);
});

test("AdapterRegistry reports duplicate and unknown IDs without replacing entries", () => {
  const registry = new AdapterRegistry();
  registry.register({ id: "dsh", label: "Original" });
  assert.throws(
    () => registry.register({ id: "dsh", label: "Replacement" }),
    /Adapter registry already contains id "dsh"/,
  );
  assert.equal(registry.get("dsh").label, "Original");
  assert.throws(() => registry.get("missing"), /Adapter registry has no entry with id "missing"/);
});

test("Registry snapshots and freezes metadata while returning independent lists", () => {
  const registry = new Registry();
  const nested = { enabled: true };
  const original = { id: "dsh", label: "Original", nested };
  registry.register(original);
  original.id = "renamed";
  original.label = "Changed";

  const stored = registry.get("dsh");
  assert.notEqual(stored, original);
  assert.deepEqual(stored, { id: "dsh", label: "Original", nested });
  assert.equal(stored.nested, nested);
  assert.ok(Object.isFrozen(stored));
  assert.throws(() => { stored.id = "renamed"; }, TypeError);
  assert.throws(() => registry.get("renamed"), /no entry with id "renamed"/);
  assert.throws(() => registry.register({ id: "dsh" }), /already contains id "dsh"/);

  const listed = registry.list();
  assert.equal(listed[0], stored);
  listed.splice(0, 1, { id: "other" });
  assert.deepEqual(registry.list(), [stored]);
  assert.equal(registry.get("dsh").id, "dsh");
});
