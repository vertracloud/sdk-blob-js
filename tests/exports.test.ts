import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BlobUploadMode, BlobVisibility, VERSION } from "../src/index";

describe("exports", () => {
	it("re-exports blob enums with their wire values", () => {
		assert.equal(BlobVisibility.PUBLIC, "public");
		assert.equal(BlobUploadMode.MULTIPART, "multipart");
	});

	it("exposes a version string", () => {
		assert.equal(typeof VERSION, "string");
	});
});
