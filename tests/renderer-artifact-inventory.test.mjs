import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  reconcileRendererArtifactInventory,
  rendererRouterExtensionMode,
} from "../scripts/lib/router-renderer-patch.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value) {
  const bytes = Buffer.from(value);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function chunk(path, originalValue, patchedValue, role = "panel") {
  return { role, path: `dist/renderer/${path}`, original: record(originalValue), patched: record(patchedValue) };
}

function extension(chunks) {
  return { schemaVersion: 1, mode: rendererRouterExtensionMode, chunks };
}

function readFrom(packaged) {
  return relative => {
    if (!(relative in packaged)) throw new Error(`unexpected packaged read: ${relative}`);
    return Buffer.from(packaged[relative]);
  };
}

test("the pinned renderer plus its declared patch reconciles to the patched chunk", () => {
  const files = [
    { path: "index.html", ...record("<html>") },
    { path: "assets/index-a.js", ...record("before") },
  ];
  const patched = reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-a.js", "before", "after")]),
    readPackaged: readFrom({ "index.html": "<html>", "assets/index-a.js": "after" }),
  });
  assert.deepEqual(patched, ["assets/index-a.js"]);
});

test("an undeclared packaged change is rejected", () => {
  const files = [{ path: "assets/index-a.js", ...record("before") }];
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-other.js", "x", "y")]),
    readPackaged: readFrom({ "assets/index-a.js": "tampered" }),
  }), /differs from its checksum inventory: assets\/index-a\.js/);
});

test("a declared patch that did not apply is rejected", () => {
  const files = [{ path: "assets/index-a.js", ...record("before") }];
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-a.js", "before", "after")]),
    readPackaged: readFrom({ "assets/index-a.js": "before" }),
  }), /declares a patch that is not present: assets\/index-a\.js/);
});

test("an extension whose original is not the pinned artifact is rejected", () => {
  const files = [{ path: "assets/index-a.js", ...record("before") }];
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-a.js", "something-else", "after")]),
    readPackaged: readFrom({ "assets/index-a.js": "after" }),
  }), /does not start from the pinned renderer artifact: assets\/index-a\.js/);
});

test("a packaged chunk that is not the recorded patched result is rejected", () => {
  const files = [{ path: "assets/index-a.js", ...record("before") }];
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-a.js", "before", "after")]),
    readPackaged: readFrom({ "assets/index-a.js": "after-but-different" }),
  }), /differs from its router extension record: assets\/index-a\.js/);
});

test("an extension that patches outside the pinned inventory is rejected", () => {
  const files = [{ path: "index.html", ...record("<html>") }];
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/invented.js", "before", "after")]),
    readPackaged: readFrom({ "index.html": "<html>" }),
  }), /patches a file outside the pinned renderer inventory: assets\/invented\.js/);
});

test("a malformed router extension record is rejected", () => {
  const files = [{ path: "index.html", ...record("<html>") }];
  const readPackaged = readFrom({ "index.html": "<html>" });
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: { schemaVersion: 1, mode: "something-else", chunks: [] },
    readPackaged,
  }), /router renderer extension record has the wrong identity/i);
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([]),
    readPackaged,
  }), /declares no chunks/i);
  assert.throws(() => reconcileRendererArtifactInventory({
    files,
    extension: extension([chunk("assets/index-a.js", "same", "same")]),
    readPackaged,
  }), /declares no change/);
});
