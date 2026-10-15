import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { BlobError, BlobProgress } from "../src/index";
import { type Call, fail, makeClient, obj, ok } from "./helpers";

const MB = 1024 * 1024;
const SIGNED = { "x-amz-meta-a": "1", "content-type": "image/png" };

const pattern = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251);

interface Fixture {
	size: number;
	partSize: number;
	mode?: "single" | "multipart";
	uploaded?: number[];
	/** Hook for part PUTs: return a Response to override the default 200. */
	onPut?: (call: Call, part: number, attempt: number) => Response | Promise<Response> | undefined;
}

/** A tiny fake of the upload routes + the signed storage URLs. */
function uploadApi(f: Fixture) {
	const attempts = new Map<number, number>();
	const received = new Map<number, Uint8Array>();
	let active = 0;
	let maxActive = 0;
	const partCount = Math.ceil(f.size / f.partSize);
	const upload = (extra: Record<string, unknown> = {}) =>
		f.mode === "single"
			? { id: "u1", path: "big.bin", mode: "single", status: "pending", size: f.size, url: "https://storage.test/single?sig=1", headers: SIGNED, ...extra }
			: { id: "u1", path: "big.bin", mode: "multipart", status: "pending", size: f.size, part_size: f.partSize, part_count: partCount, headers: {}, uploaded_parts: f.uploaded ?? [], ...extra };
	const handler = async (call: Call): Promise<Response> => {
		const { pathname, host } = call.url;
		if (host === "storage.test") {
			const part = Number(call.url.searchParams.get("part") ?? 0);
			const attempt = (attempts.get(part) ?? 0) + 1;
			attempts.set(part, attempt);
			const override = f.onPut?.(call, part, attempt);
			if (override) return override;
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			received.set(part, call.bytes as Uint8Array);
			return new Response(null, { status: 200 });
		}
		if (call.method === "POST" && pathname === "/v1/uploads") return ok(upload(), 201);
		if (call.method === "GET" && pathname === "/v1/uploads/u1") return ok(upload());
		if (call.method === "POST" && pathname === "/v1/uploads/u1/parts") return ok((call.json.part_numbers as number[]).map((n) => ({ part_number: n, url: `https://storage.test/part?part=${n}&sig=x`, size: 0, headers: { "x-part": String(n) } })));
		if (call.method === "POST" && pathname === "/v1/uploads/u1/complete") return ok(obj({ id: "obj1", path: "big.bin", size: f.size }));
		if (call.method === "DELETE" && pathname === "/v1/uploads/u1") return ok(null);
		return fail(500, "INTERNAL_SERVER_ERROR");
	};
	return { handler, received, attempts, maxActive: () => maxActive, partCount };
}

const joined = (received: Map<number, Uint8Array>, count: number) => {
	const parts = Array.from({ length: count }, (_, i) => received.get(i + 1) as Uint8Array);
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

describe("put: simple upload", () => {
	it("sends small files as one multipart/form-data POST /objects with options in the query", async () => {
		const progress: BlobProgress[] = [];
		const { client, calls } = makeClient(() => ok(obj({ path: "docs/a.txt" }), 201));
		const res = await client.put("docs/a.txt", "hello", {
			visibility: "public",
			overwrite: true,
			randomSuffix: true,
			cacheControl: "immutable",
			contentDisposition: "inline",
			filename: "A.txt",
			metadata: { owner: "joao" },
			checksumSha256: "abc",
			expiresAt: new Date("2026-12-01T00:00:00Z"),
			onProgress: (p) => progress.push(p),
		});
		assert.equal(res.path, "docs/a.txt");
		assert.equal(calls.length, 1);
		const [call] = calls;
		assert.equal(call.method, "POST");
		assert.equal(call.url.pathname, "/v1/objects");
		const q = call.url.searchParams;
		assert.equal(q.get("path"), "docs/a.txt");
		assert.equal(q.get("visibility"), "public");
		assert.equal(q.get("overwrite"), "true");
		assert.equal(q.get("random_suffix"), "true");
		assert.equal(q.get("cache_control"), "immutable");
		assert.equal(q.get("content_disposition"), "inline");
		assert.equal(q.get("filename"), "A.txt");
		assert.equal(q.get("checksum_sha256"), "abc");
		assert.equal(q.get("expires_at"), "2026-12-01T00:00:00.000Z");
		assert.deepEqual(JSON.parse(q.get("metadata") as string), { owner: "joao" });
		const file = call.form?.get("file") as File;
		assert.equal(await file.text(), "hello");
		assert.equal(call.headers["content-type"], undefined, "the boundary header must come from fetch");
		assert.deepEqual(progress.at(-1), { loaded: 5, total: 5 });
	});

	it("sends renameOnConflict as rename_on_conflict and returns the final path", async () => {
		const { client, calls } = makeClient(() => ok(obj({ path: "docs/a-1.txt" }), 201));
		const res = await client.put("docs/a.txt", "hello", { renameOnConflict: true });
		assert.equal(res.path, "docs/a-1.txt");
		assert.equal(calls[0].url.searchParams.get("rename_on_conflict"), "true");
	});

	it("accepts Blob, ArrayBuffer and Uint8Array, and a stream with size", async () => {
		const { client, calls } = makeClient(() => ok(obj()));
		await client.put("a.bin", new Blob(["abc"]));
		await client.put("b.bin", new Uint8Array([1, 2, 3, 4]).buffer);
		await client.put("c.bin", new Uint8Array([1, 2]));
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array([9, 8]));
				c.enqueue(new Uint8Array([7]));
				c.close();
			},
		});
		await client.put("d.bin", stream, { size: 3 });
		const sizes = await Promise.all(calls.map(async (c) => (c.form?.get("file") as File).size));
		assert.deepEqual(sizes, [3, 4, 2, 3]);
		assert.deepEqual(new Uint8Array(await (calls[3].form?.get("file") as File).arrayBuffer()), new Uint8Array([9, 8, 7]));
	});

	it("requires size for a stream", async () => {
		const { client } = makeClient(() => ok(obj()));
		await assert.rejects(client.put("a.bin", new ReadableStream<Uint8Array>()), (e: BlobError) => e.code === "INVALID_ARGUMENT");
	});

	it("never retries the creation", async () => {
		const { client, calls } = makeClient(() => fail(503, "INTERNAL_SERVER_ERROR"));
		await assert.rejects(client.put("a.txt", "x"));
		assert.equal(calls.length, 1);
	});
});

describe("put: direct upload", () => {
	it("PUTs a single-mode upload with exactly the signed headers, no credentials, then completes", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: 6 * MB, mode: "single" });
		const { client, calls } = makeClient(api.handler);
		const uploads: string[] = [];
		const res = await client.put("big.bin", new Uint8Array(6 * MB), { visibility: "public", randomSuffix: true, onUpload: (u) => uploads.push(u.id) });
		assert.equal(res.id, "obj1");
		assert.deepEqual(uploads, ["u1"]);
		assert.deepEqual(
			calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`),
			["POST blob.test/v1/uploads", "PUT storage.test/single", "POST blob.test/v1/uploads/u1/complete"],
		);
		assert.deepEqual(calls[0].json, { visibility: "public", random_suffix: true, path: "big.bin", size: 6 * MB });
		assert.deepEqual(calls[1].headers, SIGNED);
		assert.equal(calls[1].credentials, undefined);
		assert.equal(calls[1].bytes?.length, 6 * MB);
	});

	it("uploads multipart parts in order of the layout, requesting URLs in batches of at most 100", async () => {
		const size = 6 * MB;
		const api = uploadApi({ size, partSize: 51200 });
		const { client, calls } = makeClient(api.handler);
		const data = pattern(size);
		const progress: BlobProgress[] = [];
		await client.put("big.bin", data, { onProgress: (p) => progress.push(p) });
		assert.equal(api.partCount, 123);
		const batches = calls.filter((c) => c.url.pathname.endsWith("/parts")).map((c) => c.json.part_numbers.length);
		assert.deepEqual(batches, [100, 23]);
		assert.deepEqual(joined(api.received, api.partCount), data);
		assert.equal(api.received.get(123)?.length, size - 122 * 51200);
		// part PUTs carry the signed headers of their part and no API credentials
		const put = calls.find((c) => c.method === "PUT" && c.url.searchParams.get("part") === "5") as Call;
		assert.deepEqual(put.headers, { "x-part": "5" });
		assert.equal(calls.at(-1)?.url.pathname, "/v1/uploads/u1/complete");
		assert.deepEqual(progress.at(-1), { loaded: size, total: size });
		for (let i = 1; i < progress.length; i++) assert.ok(progress[i].loaded >= progress[i - 1].loaded, "progress never goes backwards");
	});

	it("respects partConcurrency", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: MB });
		const { client } = makeClient(api.handler, { partConcurrency: 2 });
		await client.put("big.bin", new Uint8Array(6 * MB));
		assert.equal(api.maxActive(), 2);

		const wide = uploadApi({ size: 6 * MB, partSize: MB });
		const w = makeClient(wide.handler, { partConcurrency: 4 });
		await w.client.put("big.bin", new Uint8Array(6 * MB));
		assert.equal(wide.maxActive(), 4);
	});

	it("uploads a stream in order", async () => {
		const size = 6 * MB + 123;
		const api = uploadApi({ size, partSize: MB });
		const { client } = makeClient(api.handler);
		const data = pattern(size);
		let at = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (at >= size) return c.close();
				c.enqueue(data.slice(at, at + 777_777));
				at += 777_777;
			},
		});
		await client.put("big.bin", stream, { size });
		assert.deepEqual(joined(api.received, api.partCount), data);
	});

	it("retries a part that fails once, with the same bytes", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: MB, onPut: (_, part, attempt) => (part === 3 && attempt === 1 ? fail(500, "INTERNAL_SERVER_ERROR") : undefined) });
		const { client, calls } = makeClient(api.handler);
		const data = pattern(6 * MB);
		await client.put("big.bin", data);
		assert.equal(api.attempts.get(3), 2);
		assert.equal(calls.filter((c) => c.method === "PUT").length, 7);
		assert.deepEqual(joined(api.received, 6), data);
	});

	it("does not retry a 4xx part, fails with UPLOAD_FAILED and leaves the upload open for resume", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: MB, onPut: (_, part) => (part === 2 ? new Response("<Error/>", { status: 403 }) : undefined) });
		const { client, calls } = makeClient(api.handler, { partConcurrency: 1 });
		const error = (await client.put("big.bin", new Uint8Array(6 * MB)).catch((e: unknown) => e)) as BlobError;
		assert.equal(error.code, "UPLOAD_FAILED");
		assert.equal(error.status, 403);
		assert.ok(!error.message.includes("sig="));
		assert.equal(api.attempts.get(2), 1);
		assert.ok(!calls.some((c) => c.method === "DELETE" || c.url.pathname.endsWith("/complete")));
	});

	it("aborting mid-upload cancels the upload on the server and throws ABORTED", async () => {
		const controller = new AbortController();
		const api = uploadApi({
			size: 6 * MB,
			partSize: MB,
			onPut: (_, part) => {
				if (part === 2) controller.abort();
				return undefined;
			},
		});
		const { client, calls } = makeClient(api.handler, { partConcurrency: 1 });
		const error = (await client.put("big.bin", new Uint8Array(6 * MB), { signal: controller.signal }).catch((e: unknown) => e)) as BlobError;
		assert.equal(error.code, "ABORTED");
		assert.ok(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/v1/uploads/u1"));
		assert.ok(!calls.some((c) => c.url.pathname.endsWith("/complete")));
		assert.ok(calls.filter((c) => c.method === "PUT").length < 6);
	});

	it("an already-aborted signal sends nothing", async () => {
		const { client, calls } = makeClient(() => ok(obj()));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(client.put("a.txt", "x", { signal: controller.signal }), (e: BlobError) => e.code === "ABORTED");
		assert.equal(calls.length, 0);
	});
});

describe("resume", () => {
	it("sends only the parts the server does not have", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: MB, uploaded: [1, 2, 3] });
		const { client, calls } = makeClient(api.handler);
		const data = pattern(6 * MB);
		const progress: BlobProgress[] = [];
		const res = await client.resume("u1", data, { onProgress: (p) => progress.push(p) });
		assert.equal(res.id, "obj1");
		assert.deepEqual(
			calls.map((c) => `${c.method} ${c.url.pathname}`),
			["GET /v1/uploads/u1", "POST /v1/uploads/u1/parts", "PUT /part", "PUT /part", "PUT /part", "POST /v1/uploads/u1/complete"],
		);
		assert.deepEqual(calls[1].json, { part_numbers: [4, 5, 6] });
		assert.deepEqual([...api.received.keys()].sort(), [4, 5, 6]);
		assert.deepEqual(api.received.get(4), data.subarray(3 * MB, 4 * MB));
		assert.deepEqual(progress[0], { loaded: 3 * MB, total: 6 * MB });
		assert.deepEqual(progress.at(-1), { loaded: 6 * MB, total: 6 * MB });
	});

	it("resumes a stream by discarding the bytes of finished parts", async () => {
		const size = 4 * MB;
		const api = uploadApi({ size, partSize: MB, uploaded: [1, 3] });
		const { client } = makeClient(api.handler);
		const data = pattern(size);
		let at = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (at >= size) return c.close();
				c.enqueue(data.slice(at, at + 300_000));
				at += 300_000;
			},
		});
		await client.resume("u1", stream, { size });
		assert.deepEqual([...api.received.keys()].sort(), [2, 4]);
		assert.deepEqual(api.received.get(2), data.subarray(MB, 2 * MB));
		assert.deepEqual(api.received.get(4), data.subarray(3 * MB, 4 * MB));
	});

	it("refuses data whose size differs from the upload", async () => {
		const api = uploadApi({ size: 6 * MB, partSize: MB });
		const { client } = makeClient(api.handler);
		await assert.rejects(client.resume("u1", new Uint8Array(5 * MB)), (e: BlobError) => e.code === "INVALID_ARGUMENT");
	});

	it("aborting a resume does not delete the upload", async () => {
		const controller = new AbortController();
		const api = uploadApi({
			size: 6 * MB,
			partSize: MB,
			onPut: (_, part) => {
				if (part === 2) controller.abort();
				return undefined;
			},
		});
		const { client, calls } = makeClient(api.handler, { partConcurrency: 1 });
		await assert.rejects(client.resume("u1", new Uint8Array(6 * MB), { signal: controller.signal }), (e: BlobError) => e.code === "ABORTED");
		assert.ok(!calls.some((c) => c.method === "DELETE"));
	});
});
