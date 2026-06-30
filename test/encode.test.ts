import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encodeProjectDir, exceedsLimit } from "../src/encode.js";

test("encodes verified on-disk examples", () => {
  assert.equal(encodeProjectDir("/Users/danielke/.claude"), "-Users-danielke--claude");
  assert.equal(encodeProjectDir("/Users/danielke/.oh-my-zsh/custom"), "-Users-danielke--oh-my-zsh-custom");
  assert.equal(
    encodeProjectDir("/Users/danielke/Work/DMXL/claude-sesh-reroot"),
    "-Users-danielke-Work-DMXL-claude-sesh-reroot",
  );
});

test("every non-alphanumeric character collapses to a dash", () => {
  assert.equal(encodeProjectDir("/a/b_c.d e"), "-a-b-c-d-e");
  assert.equal(encodeProjectDir("/x.y_z"), "-x-y-z");
});

test("exceedsLimit flags names longer than 200 chars", () => {
  assert.equal(exceedsLimit("/Users/danielke/short"), false);
  assert.equal(exceedsLimit("/" + "a".repeat(250)), true);
});
