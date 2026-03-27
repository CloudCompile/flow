import assert from "assert";

process.env.FLOWAI_SKIP_MAIN = "1";
const {
  shouldRequestActionableResponse,
  likelyNeedsFileChanges,
} = require("./index") as typeof import("./index");

// likelyNeedsFileChanges should match whole-word verbs, case-insensitive.
assert.strictEqual(likelyNeedsFileChanges("please Add a new test file"), true);
assert.strictEqual(likelyNeedsFileChanges("We need to IMPLEMENT a small fix"), true);
assert.strictEqual(likelyNeedsFileChanges("Discuss branching strategy"), false);
assert.strictEqual(likelyNeedsFileChanges("profile data review"), false);

// shouldRequestActionableResponse should request retries only when changes are implied and files are missing.
assert.strictEqual(
  shouldRequestActionableResponse({ comment: "ok", files: [] }, "create a helper"),
  true,
);
assert.strictEqual(
  shouldRequestActionableResponse(
    { comment: "ok", files: [{ path: "a.txt", action: "create", content: "x" }] },
    "create a helper",
  ),
  false,
);
assert.strictEqual(
  shouldRequestActionableResponse({ comment: "ok" }, "modify the config"),
  true,
);
assert.strictEqual(
  shouldRequestActionableResponse({ comment: "ok", files: "invalid" } as any, "modify the config"),
  false,
);
assert.strictEqual(
  shouldRequestActionableResponse(undefined as any, "update docs"),
  false,
);
assert.strictEqual(
  shouldRequestActionableResponse(null as any, "update docs"),
  false,
);

console.log("All helper tests passed.");
