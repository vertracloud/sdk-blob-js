import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BlobClient, BlobError } from "../src/index";
import { fail, makeClient, obj, ok } from "./helpers";

describe("envelope, auth and errors", () => {
	it("unwraps { response } and sends the API key as a bearer token", async () => {
		const { client, calls } = makeClient(() => ok(obj({ id: "42" })));
		const res = await client.get("42");
		assert.equal(res.id, "42");
		assert.equal(calls[0].method, "GET");
		assert.equal(calls[0].url.href, "https://blob.test/v1/objects/42");
		assert.equal(calls[0].headers.authorization, "Bearer secret-key");
	});

	it("sends an upload token the same way, and refuses both credentials", async () => {
		const { client, calls } = makeClient(() => ok(obj()), { apiKey: undefined, uploadToken: "vcup_abc" });
		await client.get("1");
		assert.equal(calls[0].headers.authorization, "Bearer vcup_abc");
		assert.throws(
			() => new BlobClient({ apiKey: "a", uploadToken: "vcup_b" }),
			(e: BlobError) => e.code === "INVALID_ARGUMENT",
		);
	});

	it("uses credentials without an Authorization header for cookie sessions", async () => {
		const { client, calls } = makeClient(() => ok(obj()), { apiKey: undefined, credentials: "include", baseUrl: "https://api.test/v1/blob/" });
		await client.get("1");
		assert.equal(calls[0].url.href, "https://api.test/v1/blob/objects/1");
		assert.equal(calls[0].credentials, "include");
		assert.equal(calls[0].headers.authorization, undefined);
	});

	it("turns an error envelope into a BlobError without leaking credentials", async () => {
		const { client } = makeClient(() => fail(404, "BLOB_OBJECT_NOT_FOUND", { message: "nope", details: { id: "9" } }));
		const error = await client.get("9").catch((e: unknown) => e);
		assert.ok(error instanceof BlobError);
		assert.equal(error.status, 404);
		assert.equal(error.code, "BLOB_OBJECT_NOT_FOUND");
		assert.equal(error.message, "nope");
		assert.deepEqual(error.details, { id: "9" });
		assert.ok(!JSON.stringify(error).includes("secret-key"));
		assert.ok(!error.toString().includes("secret-key"));
	});

	it("falls back to HTTP_<status> when the error body is not an envelope", async () => {
		const { client } = makeClient(() => new Response("<html>bad gateway</html>", { status: 502 }), { maxRetries: 0 });
		const error = (await client.get("1").catch((e: unknown) => e)) as BlobError;
		assert.equal(error.code, "HTTP_502");
	});

	it("does not retry a 429 and exposes Retry-After", async () => {
		const { client, calls } = makeClient(() => fail(429, "RATE_LIMIT_EXCEEDED", {}, { "retry-after": "7" }));
		const error = (await client.get("1").catch((e: unknown) => e)) as BlobError;
		assert.equal(error.code, "RATE_LIMIT_EXCEEDED");
		assert.equal(error.retryAfter, 7);
		assert.equal(calls.length, 1);
	});

	it("retries a GET on 5xx but never a write", async () => {
		const flaky = makeClient((_, i) => (i < 2 ? fail(503, "INTERNAL_SERVER_ERROR") : ok(obj())));
		await flaky.client.get("1");
		assert.equal(flaky.calls.length, 3);

		const write = makeClient(() => fail(503, "INTERNAL_SERVER_ERROR"));
		await assert.rejects(write.client.update("1", { filename: "x" }));
		await assert.rejects(write.client.delete("1"));
		await assert.rejects(write.client.copy("1", "b.txt"));
		assert.equal(write.calls.length, 3);
	});

	it("reports network failures and timeouts without echoing the URL", async () => {
		const down = new BlobClient({ apiKey: "k", baseUrl: "https://blob.test/v1", fetch: async () => Promise.reject(new TypeError("fetch failed https://secret.example/sig=abc")), maxRetries: 0 });
		const netError = (await down.get("1").catch((e: unknown) => e)) as BlobError;
		assert.equal(netError.code, "NETWORK_ERROR");
		assert.ok(!netError.message.includes("secret.example"));

		const { client } = makeClient(() => new Promise<Response>(() => {}), { maxRetries: 0 });
		const timeout = (await client.get("1", { timeout: 20 }).catch((e: unknown) => e)) as BlobError;
		assert.equal(timeout.code, "TIMEOUT");
	});

	it("adds workspace_id to every API call", async () => {
		const { client, calls } = makeClient(
			(c) =>
				ok(
					c.url.pathname.endsWith("/objects") && c.method === "GET"
						? { objects: [], folders: [], cursor: null }
						: c.url.pathname.endsWith("/objects") && c.method === "DELETE"
							? { deleted: ["1"], not_found: [], remaining: false }
							: c.url.pathname.endsWith("/objects") && c.method === "PATCH"
								? []
								: c.url.pathname.endsWith("/rules")
									? { rules: [], etag: "e" }
									: obj(),
				),
			{ workspaceId: "ws_1" },
		);
		await client.get("1");
		await client.listPage({ prefix: "a/" });
		await client.update("1", { filename: "a" });
		await client.updateMany(["1"], { visibility: "public" });
		await client.copy("1", "b.txt");
		await client.delete("1");
		await client.deleteMany({ ids: ["1"] });
		await client.downloadUrl("1");
		await client.stats();
		await client.createUploadToken({ prefix: "a/" });
		await client.s3Credentials();
		await client.shares.create("1");
		await client.shares.list();
		await client.shares.revoke("1");
		await client.rules.get();
		await client.rules.set([], "e");
		await client.rules.put("a/", {});
		await client.rules.delete("a/");
		await client.domains.list();
		await client.domains.add("cdn.example.com");
		await client.domains.update("1", { web_content: true });
		await client.domains.verify("1");
		await client.domains.remove("1");
		await client.listUploads();
		await client.abortUpload("1");
		assert.equal(calls.length, 25);
		for (const call of calls) assert.equal(call.url.searchParams.get("workspace_id"), "ws_1", `${call.method} ${call.url.pathname}`);
	});
});

describe("objects", () => {
	it("pages through list() with the cursor and exposes folders in listPage()", async () => {
		const pages = [
			{ objects: [obj({ id: "1" }), obj({ id: "2" })], folders: ["a/"], cursor: "c1" },
			{ objects: [obj({ id: "3" })], folders: [], cursor: null },
		];
		const { client, calls } = makeClient((_, i) => ok(pages[i]));
		const ids: string[] = [];
		for await (const o of client.list({ prefix: "a/", limit: 2 })) ids.push(o.id);
		assert.deepEqual(ids, ["1", "2", "3"]);
		assert.equal(calls[0].url.pathname, "/v1/objects");
		assert.equal(calls[0].url.searchParams.get("prefix"), "a/");
		assert.equal(calls[0].url.searchParams.get("limit"), "2");
		assert.equal(calls[0].url.searchParams.has("cursor"), false);
		assert.equal(calls[1].url.searchParams.get("cursor"), "c1");

		const page = makeClient(() => ok(pages[0]));
		const res = await page.client.listPage({ delimiter: "/", visibility: "public", cursor: "x" });
		assert.deepEqual(res.folders, ["a/"]);
		assert.equal(page.calls[0].url.searchParams.get("delimiter"), "/");
		assert.equal(page.calls[0].url.searchParams.get("visibility"), "public");
		assert.equal(page.calls[0].url.searchParams.get("cursor"), "x");
	});

	it("converts camelCase options to the snake_case wire shape", async () => {
		const { client, calls } = makeClient((c) => ok(c.url.pathname.endsWith("/objects") ? [] : obj()));
		const when = new Date("2026-12-01T00:00:00.000Z");
		await client.update("7", { contentDisposition: "attachment", cacheControl: null, expiresAt: when, metadata: { owner: "a", old: null } });
		assert.equal(calls[0].method, "PATCH");
		assert.equal(calls[0].url.pathname, "/v1/objects/7");
		assert.deepEqual(calls[0].json, { content_disposition: "attachment", cache_control: null, expires_at: when.toISOString(), metadata: { owner: "a", old: null } });

		await client.updateMany(["1", "2"], { visibility: "private" });
		assert.equal(calls[1].method, "PATCH");
		assert.equal(calls[1].url.pathname, "/v1/objects");
		assert.deepEqual(calls[1].json, { ids: ["1", "2"], changes: { visibility: "private" } });
	});

	it("updateMany sends batches of 100 and joins the results in order", async () => {
		const { client, calls } = makeClient((call) => ok((call.json as { ids: string[] }).ids.map((id) => ({ id, ok: true }))));
		const ids = Array.from({ length: 250 }, (_, i) => String(i));
		const res = await client.updateMany(ids, { visibility: "public" });
		assert.deepEqual(
			calls.map((c) => (c.json as { ids: string[] }).ids.length),
			[100, 100, 50],
		);
		assert.deepEqual(
			res.map((r) => r.id),
			ids,
		);
	});

	it("createUploadToken sends overwrite", async () => {
		const { client, calls } = makeClient(() => ok({ token: "vcup_x" }));
		await client.createUploadToken({ prefix: "a/", overwrite: true });
		assert.deepEqual(calls[0].json, { prefix: "a/", overwrite: true });
	});

	it("copy and move post to /objects/copy", async () => {
		const { client, calls } = makeClient(() => ok(obj()));
		await client.copy("1", "backup/a.txt", { overwrite: true, randomSuffix: true });
		await client.move("1", "img/a.txt", { visibility: "public" });
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].url.pathname, "/v1/objects/copy");
		assert.deepEqual(calls[0].json, { source: "1", path: "backup/a.txt", overwrite: true, random_suffix: true });
		assert.deepEqual(calls[1].json, { source: "1", path: "img/a.txt", visibility: "public", move: true });
	});

	it("copy sends renameOnConflict as rename_on_conflict", async () => {
		const { client, calls } = makeClient(() => ok(obj()));
		await client.copy("1", "a.txt", { renameOnConflict: true });
		assert.deepEqual(calls[0].json, { source: "1", path: "a.txt", rename_on_conflict: true });
	});

	it("delete accepts an empty success body", async () => {
		const { client, calls } = makeClient(() => new Response(null, { status: 204 }));
		await client.delete("5");
		assert.equal(calls[0].method, "DELETE");
		assert.equal(calls[0].url.pathname, "/v1/objects/5");
	});

	it("deleteMany by prefix repeats while remaining and merges the rounds", async () => {
		const rounds = [
			{ deleted: ["1", "2"], not_found: [], remaining: true },
			{ deleted: ["3"], not_found: ["9"], remaining: true },
			{ deleted: ["4"], not_found: [], remaining: false },
		];
		const { client, calls } = makeClient((_, i) => ok(rounds[i]));
		const res = await client.deleteMany({ prefix: "tmp/" });
		assert.equal(calls.length, 3);
		for (const call of calls) {
			assert.equal(call.method, "DELETE");
			assert.deepEqual(call.json, { prefix: "tmp/" });
		}
		assert.deepEqual(res, { deleted: ["1", "2", "3", "4"], not_found: ["9"], remaining: false });
	});

	it("deleteMany by ids sends the ids and stops when none are left", async () => {
		const { client, calls } = makeClient(() => ok({ deleted: ["1"], not_found: ["2"], remaining: false }));
		const res = await client.deleteMany({ ids: ["1", "2"] });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].json, { ids: ["1", "2"] });
		assert.deepEqual(res.deleted, ["1"]);
	});

	it("deleteMany throws instead of looping when nothing progresses", async () => {
		const { client } = makeClient(() => ok({ deleted: [], not_found: [], remaining: true }));
		await assert.rejects(client.deleteMany({ prefix: "x/" }), (e: BlobError) => e.code === "INVALID_RESPONSE");
	});

	it("downloadUrl asks for the JSON form with redirect=false", async () => {
		const { client, calls } = makeClient(() => ok({ url: "https://f.test/d/t", expires_at: "2026-10-14T00:00:00Z" }));
		const res = await client.downloadUrl("3", { expiresIn: 600, disposition: "attachment", filename: "a b.txt" });
		assert.equal(res.url, "https://f.test/d/t");
		assert.equal(calls[0].url.pathname, "/v1/objects/3/download");
		assert.equal(calls[0].url.searchParams.get("expires_in"), "600");
		assert.equal(calls[0].url.searchParams.get("disposition"), "attachment");
		assert.equal(calls[0].url.searchParams.get("filename"), "a b.txt");
		assert.equal(calls[0].url.searchParams.get("redirect"), "false");
	});

	it("imageUrl builds the transformation URL and refuses private objects", () => {
		const { client } = makeClient(() => ok(null));
		const url = client.imageUrl({ url: "https://files.test/ns/img/a%20b.png" }, { width: 400, height: 300, fit: "cover", format: "webp", quality: 80 });
		const u = new URL(url);
		assert.equal(u.pathname, "/ns/img/a%20b.png");
		assert.equal(u.search, "?w=400&h=300&fit=cover&format=webp&q=80");
		assert.equal(client.imageUrl("https://files.test/ns/a.png?v=1", { width: 100 }), "https://files.test/ns/a.png?v=1&w=100");
		assert.throws(
			() => client.imageUrl({ url: null }, { width: 10 }),
			(e: BlobError) => e.code === "INVALID_ARGUMENT",
		);
	});
});

describe("account, shares, rules and domains", () => {
	it("calls stats, upload tokens and S3 credentials", async () => {
		const { client, calls } = makeClient(() => ok({}));
		await client.stats();
		await client.createUploadToken({ prefix: "avatars/", maxSize: 5000, allowedExtensions: ["png"], expiresIn: 600, maxUses: 3 });
		await client.s3Credentials();
		assert.equal(calls[0].url.pathname, "/v1/stats");
		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].url.pathname, "/v1/upload-tokens");
		assert.deepEqual(calls[1].json, { prefix: "avatars/", max_size: 5000, allowed_extensions: ["png"], expires_in: 600, max_uses: 3 });
		assert.equal(calls[2].url.pathname, "/v1/s3/credentials");
	});

	it("manages shares", async () => {
		const { client, calls } = makeClient(() => ok({}));
		await client.shares.create("5", { maxDownloads: 10, password: "correct horse", expiresIn: 3600 });
		await client.shares.list({ objectId: "5" });
		await client.shares.revoke("8");
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].url.pathname, "/v1/shares");
		assert.deepEqual(calls[0].json, { object_id: "5", max_downloads: 10, password: "correct horse", expires_in: 3600 });
		assert.equal(calls[1].url.searchParams.get("object_id"), "5");
		assert.equal(calls[2].method, "DELETE");
		assert.equal(calls[2].url.pathname, "/v1/shares/8");
	});

	it("manages folder rules, with If-Match on set and URL-encoded prefixes", async () => {
		const { client, calls } = makeClient(() => ok({ rules: [], etag: "e2" }));
		await client.rules.get();
		await client.rules.set([{ prefix: "tmp/", deleteAfterDays: 30, maxSize: 1000 }], "e1");
		await client.rules.put("img/thumbs/", { expireSeconds: 60, cacheControl: "immutable" });
		await client.rules.delete("img/thumbs/");
		assert.equal(calls[0].url.pathname, "/v1/rules");
		assert.equal(calls[1].method, "PUT");
		assert.equal(calls[1].headers["if-match"], "e1");
		assert.deepEqual(calls[1].json, { rules: [{ prefix: "tmp/", delete_after_days: 30, max_size: 1000 }] });
		assert.equal(calls[2].method, "PUT");
		assert.equal(calls[2].url.pathname, "/v1/rules/img%2Fthumbs%2F");
		assert.deepEqual(calls[2].json, { expire_seconds: 60, cache_control: "immutable" });
		assert.equal(calls[3].method, "DELETE");
		assert.equal(calls[3].url.pathname, "/v1/rules/img%2Fthumbs%2F");
	});

	it("manages custom domains", async () => {
		const { client, calls } = makeClient(() => ok({}));
		await client.domains.list();
		await client.domains.add("cdn.example.com", { prefix: "img/", web_content: true });
		await client.domains.update("4", { web_content: false });
		await client.domains.verify("4");
		await client.domains.remove("4");
		assert.deepEqual(
			calls.map((c) => `${c.method} ${c.url.pathname}`),
			["GET /v1/domains", "POST /v1/domains", "PATCH /v1/domains/4", "POST /v1/domains/4/verify", "DELETE /v1/domains/4"],
		);
		assert.deepEqual(calls[1].json, { hostname: "cdn.example.com", prefix: "img/", web_content: true });
		assert.deepEqual(calls[2].json, { web_content: false });
	});
});
