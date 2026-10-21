import test from "node:test";
import assert from "node:assert/strict";
import { findCcfProtocolArg, parseCcfProtocolUrl } from "../services/ccf-protocol.js";

test("parseCcfProtocolUrl parses install urls with path slug", () => {
  const parsed = parseCcfProtocolUrl("ccf://install/rusty");
  assert.deepEqual(parsed, { action: "install", slug: "rusty" });
});

test("parseCcfProtocolUrl parses install urls with query slug", () => {
  const parsed = parseCcfProtocolUrl("ccf://install?slug=masko");
  assert.deepEqual(parsed, { action: "install", slug: "masko" });
});

test("parseCcfProtocolUrl rejects unrelated urls", () => {
  assert.equal(parseCcfProtocolUrl("https://masko.ai/install/rusty"), null);
  assert.equal(parseCcfProtocolUrl("ccf://unknown/rusty"), null);
});

test("findCcfProtocolArg returns the ccf protocol argument from argv", () => {
  const value = findCcfProtocolArg(["electron.exe", ".", "ccf://install/rusty"]);
  assert.equal(value, "ccf://install/rusty");
});

