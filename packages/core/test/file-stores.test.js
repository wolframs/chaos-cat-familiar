import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSettingsStore, FileJsonStateStore, writeJsonAtomic } from "../src/index.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-file-stores-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, "data.json") };
}

for (const Store of [FileSettingsStore, FileJsonStateStore]) {
  test(`${Store.name} loads defaults and merges saved values`, (t) => {
    const { filePath } = fixture(t);
    const store = new Store(filePath, { active: false, nested: { value: 1 } });
    assert.equal(store.load().active, false);
    store.save({ active: true });
    assert.deepEqual(store.load(), { active: true, nested: { value: 1 } });
  });

  test(`${Store.name} quarantines malformed JSON, warns and recovers`, (t) => {
    const { directory, filePath } = fixture(t);
    const broken = '{"interrupted":';
    fs.writeFileSync(filePath, broken);
    const warnings = [];
    const store = new Store(filePath, { nested: { value: 1 } }, {
      logger: { warn: (...args) => warnings.push(args) }
    });
    const loaded = store.load();
    assert.deepEqual(loaded, { nested: { value: 1 } });
    loaded.nested.value = 2;
    assert.deepEqual(store.load(), { nested: { value: 1 } });
    const quarantined = fs.readdirSync(directory).filter((name) => /\.corrupt-[^.]+$/.test(name));
    assert.equal(quarantined.length, 1);
    const quarantinePath = path.join(directory, quarantined[0]);
    assert.equal(fs.readFileSync(quarantinePath, "utf8"), broken);
    assert.match(fs.readFileSync(`${quarantinePath}.recovery.txt`, "utf8"), /delete.*recover/i);
    assert.equal(warnings.length, 1);
    assert.match(JSON.stringify(warnings), /corrupt.*defaults/i);
    assert.ok(JSON.stringify(warnings).includes(quarantinePath.replaceAll("\\", "\\\\")));
    store.save({ repaired: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { repaired: true });
    assert.equal(fs.readFileSync(quarantinePath, "utf8"), broken);
  });

  test(`${Store.name} does not quarantine an unreadable file`, (t) => {
    const { directory, filePath } = fixture(t);
    fs.writeFileSync(filePath, "{}");
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    const store = new Store(filePath, {}, { fsImpl: {
      ...fs, readFileSync() { throw error; }
    } });
    assert.throws(() => store.load(), error);
    assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  });

  test(`${Store.name} preserves corrupt data if quarantine rename fails`, (t) => {
    const { directory, filePath } = fixture(t);
    fs.writeFileSync(filePath, "{broken");
    const error = Object.assign(new Error("locked"), { code: "EPERM" });
    const store = new Store(filePath, {}, { fsImpl: {
      ...fs, renameSync() { throw error; }
    } });
    assert.throws(() => store.load(), error);
    assert.equal(fs.readFileSync(filePath, "utf8"), "{broken");
    assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  });
}

test("atomic JSON write replaces only after complete same-directory temporary write", (t) => {
  const { directory, filePath } = fixture(t);
  fs.writeFileSync(filePath, '{"previous":true}');
  let renamed = false;
  writeJsonAtomic(filePath, { next: true }, { fsImpl: {
    ...fs,
    renameSync(source, destination) {
      assert.equal(path.dirname(source), directory);
      assert.equal(destination, filePath);
      assert.deepEqual(JSON.parse(fs.readFileSync(source, "utf8")), { next: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { previous: true });
      fs.renameSync(source, destination);
      renamed = true;
    }
  } });
  assert.equal(renamed, true);
  assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { next: true });
});

for (const operation of ["writeFileSync", "fsyncSync", "renameSync"]) {
  test(`atomic JSON write preserves old file and cleans temporary file on ${operation} failure`, (t) => {
    const { directory, filePath } = fixture(t);
    const previous = '{"previous":true}';
    fs.writeFileSync(filePath, previous);
    const error = Object.assign(new Error("locked"), { code: "EPERM" });
    assert.throws(() => writeJsonAtomic(filePath, { next: true }, { fsImpl: {
      ...fs, [operation]() { throw error; }
    } }), error);
    assert.equal(fs.readFileSync(filePath, "utf8"), previous);
    assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  });
}
