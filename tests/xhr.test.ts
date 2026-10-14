import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { BlobClient, type BlobProgress } from "../src/index";

class FakeXHR {
	static instances: FakeXHR[] = [];
	upload: { onprogress?: (e: { loaded: number }) => void } = {};
	headers: Record<string, string> = {};
	withCredentials = false;
	status = 0;
	responseText = "";
	onload?: () => void;
	onerror?: () => void;
	onabort?: () => void;
	ontimeout?: () => void;
	method = "";
	url = "";
	constructor() {
		FakeXHR.instances.push(this);
	}
	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}
	setRequestHeader(k: string, v: string) {
		this.headers[k.toLowerCase()] = v;
	}
	headerReads = 0;
	getResponseHeader() {
		this.headerReads++;
		return null;
	}
	abort() {
		this.onabort?.();
	}
	send() {
		queueMicrotask(() => {
			this.upload.onprogress?.({ loaded: 2 });
			this.upload.onprogress?.({ loaded: 5 });
			this.status = 201;
			this.responseText = JSON.stringify({ response: { id: "1", path: "a.txt" } });
			this.onload?.();
		});
	}
}

describe("browser progress", () => {
	const g = globalThis as { XMLHttpRequest?: unknown };
	const original = g.XMLHttpRequest;
	afterEach(() => {
		g.XMLHttpRequest = original;
		FakeXHR.instances = [];
	});

	it("uses XMLHttpRequest for byte progress when onProgress is given and no custom fetch is set", async () => {
		g.XMLHttpRequest = FakeXHR;
		const client = new BlobClient({ uploadToken: "vcup_x", baseUrl: "https://blob.test/v1", credentials: "include" });
		const progress: BlobProgress[] = [];
		await client.put("a.txt", "hello", { onProgress: (p) => progress.push(p) });
		const [xhr] = FakeXHR.instances;
		assert.equal(xhr.method, "POST");
		assert.equal(xhr.headerReads, 0, "Retry-After is only read on 429 (browsers log reads of unexposed headers)");
		assert.ok(xhr.url.startsWith("https://blob.test/v1/objects?path=a.txt"));
		assert.equal(xhr.headers.authorization, "Bearer vcup_x");
		assert.equal(xhr.withCredentials, true);
		assert.deepEqual(
			progress.map((p) => p.loaded),
			[2, 5, 5],
		);
	});
});
