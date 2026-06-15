import assert from "node:assert/strict";
import test from "node:test";
import { isThumbnailImagePath } from "../src/utils/image";

test("thumbnail middleware only accepts image formats supported by Sharp", () => {
  assert.equal(isThumbnailImagePath("asset/example.jpg"), true);
  assert.equal(isThumbnailImagePath("asset/example.WEBP"), true);
  assert.equal(isThumbnailImagePath("asset/example.wav"), false);
  assert.equal(isThumbnailImagePath("asset/example.mp4"), false);
});
