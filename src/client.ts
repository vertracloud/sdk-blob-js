import type {
	APIBlobBatchResult,
	APIBlobCustomDomain,
	APIBlobDeleteResult,
	APIBlobDownload,
	APIBlobObject,
	APIBlobObjectList,
	APIBlobRules,
	APIBlobS3Credentials,
	APIBlobShare,
	APIBlobStats,
	APIBlobUpload,
	APIBlobUploadPart,
	APIBlobUploadToken,
	BlobContentDisposition,
	BlobVisibility,
	RESTDeleteAPIBlobObjectsBody,
	RESTGetAPIBlobObjectDownloadQuery,
	RESTGetAPIBlobObjectsQuery,
	RESTPatchAPIBlobDomainBody,
	RESTPatchAPIBlobObjectBody,
	RESTPatchAPIBlobObjectsBody,
	RESTPostAPIBlobDomainBody,
	RESTPostAPIBlobObjectCopyBody,
	RESTPostAPIBlobObjectQuery,
	RESTPostAPIBlobShareBody,
	RESTPostAPIBlobUploadBody,
	RESTPostAPIBlobUploadPartsBody,
	RESTPostAPIBlobUploadTokenBody,
	RESTPutAPIBlobRuleBody,
	RESTPutAPIBlobRulesBody,
	SnowFlake,
} from "@vertracloud/api-types/v1";
import { BlobError, clientError } from "./errors.js";
import { type BlobData, type Source, toSource } from "./source.js";
import { type FetchLike, type TransportRequest, type TransportResponse, aborted, fetchTransport, sleep, xhrTransport } from "./transport.js";

/** Largest file sent with one `POST /objects` request; bigger files use a direct upload. */
const SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;
/** The API hands out at most this many part URLs per request. */
const PART_URLS_PER_REQUEST = 100;
const MAX_BACKOFF_MS = 8000;

export interface BlobClientOptions {
	/** API key (`blob:read` / `blob:write`). Sent as `Authorization: Bearer <apiKey>`. */
	apiKey?: string;
	/** Upload token (`vcup_…`) for browsers and other untrusted clients; valid on the upload routes only. */
	uploadToken?: string;
	/**
	 * API base URL **including the version prefix**; every route is appended to it (`${baseUrl}/objects`).
	 * Default `https://blob.vertracloud.app/v1`.
	 */
	baseUrl?: string;
	/** Custom `fetch` (proxies, tests, instrumentation). When set, upload progress is by completed part instead of by byte. */
	fetch?: FetchLike;
	/** Sent with every API call. Use `"include"` with a cookie session; then no Authorization header is needed. Never sent to signed upload URLs. */
	credentials?: RequestCredentials;
	/** Added as `?workspace_id=` to every API call, to act on the blob of a workspace owner. */
	workspaceId?: string;
	/** Extra headers for every API call. */
	headers?: Record<string, string>;
	/** Parts uploaded at the same time in a multipart upload. Default 4. */
	partConcurrency?: number;
	/** Retries for idempotent calls (GET, and the PUT of a part or single upload) on 5xx and network errors. Default 3. Never applied to 429. */
	maxRetries?: number;
	/** First retry delay in ms; doubles each attempt, with jitter. Default 300. */
	retryDelayMs?: number;
	/** Default timeout in ms for each API call. Default 30000; `0` disables. */
	timeout?: number;
	/** Timeout in ms for each request that sends file bytes (a part, a single PUT, or the simple upload). Default 300000; `0` disables. */
	uploadTimeout?: number;
}

export interface RequestOptions {
	signal?: AbortSignal;
	/** Timeout in ms for this call, overriding the client default. */
	timeout?: number;
}

export interface BlobProgress {
	loaded: number;
	total: number;
}

export interface BlobWriteOptions {
	visibility?: BlobVisibility;
	/** Replace an existing object at the same path. */
	overwrite?: boolean;
	/** Insert `-<10 random characters>` before the extension. */
	randomSuffix?: boolean;
	cacheControl?: string;
	contentDisposition?: BlobContentDisposition;
	/** File name suggested on download. */
	filename?: string;
	expiresAt?: Date | string;
	/** Hex SHA-256 of the file. */
	checksumSha256?: string;
	/** Up to 5 keys, plan-dependent. */
	metadata?: Record<string, string>;
}

export interface BlobPutOptions extends BlobWriteOptions, RequestOptions {
	/** Total size in bytes. Required for a `ReadableStream`. */
	size?: number;
	/** Called as bytes are sent. By byte in browsers (XMLHttpRequest); by finished part in Node and edge runtimes. */
	onProgress?: (progress: BlobProgress) => void;
	/** Called once a direct upload exists, before any byte is sent. Keep `upload.id` to `resume` after a crash. */
	onUpload?: (upload: APIBlobUpload) => void;
}

export interface BlobResumeOptions extends RequestOptions {
	size?: number;
	onProgress?: (progress: BlobProgress) => void;
}

export interface BlobListOptions extends RequestOptions {
	prefix?: string;
	/** Group paths into folders at this character (usually `/`); folders only come back from `listPage`. */
	delimiter?: string;
	visibility?: BlobVisibility;
	/** Page size, 1–1000. Default 100. */
	limit?: number;
}

export interface BlobListPageOptions extends BlobListOptions {
	cursor?: string;
}

export interface BlobUpdateChanges {
	visibility?: BlobVisibility;
	/** `null` restores the default. */
	cacheControl?: string | null;
	contentDisposition?: BlobContentDisposition | null;
	filename?: string | null;
	expiresAt?: Date | string | null;
	/** A `null` value removes that key. */
	metadata?: Record<string, string | null>;
}

export interface BlobCopyOptions extends RequestOptions {
	overwrite?: boolean;
	randomSuffix?: boolean;
	visibility?: BlobVisibility;
}

export interface BlobDownloadUrlOptions extends RequestOptions {
	/** Seconds, 60–86400. Default 3600. */
	expiresIn?: number;
	disposition?: BlobContentDisposition;
	filename?: string;
}

export interface BlobUploadTokenOptions extends RequestOptions {
	path?: string;
	prefix?: string;
	visibility?: BlobVisibility;
	/** Let uploads made with the token replace an existing object. Default `false`. */
	overwrite?: boolean;
	maxSize?: number;
	allowedExtensions?: string[];
	cacheControl?: string;
	contentDisposition?: BlobContentDisposition;
	expiresAt?: Date | string;
	metadata?: Record<string, string>;
	/** Seconds the token stays valid, 60–3600. Default 900. */
	expiresIn?: number;
	/** 1–100. Default 1. */
	maxUses?: number;
}

export interface BlobShareOptions extends RequestOptions {
	/** Seconds, 60 to 30 days. Default 24 hours. */
	expiresIn?: number;
	maxDownloads?: number;
	password?: string;
}

/** One folder rule, with camelCase keys (the snake_case wire shape returned by `rules.get()` is accepted too). */
export interface BlobRuleInput {
	visibility?: BlobVisibility;
	expireSeconds?: number;
	maxSize?: number;
	extensions?: string[];
	cacheControl?: string;
	deleteAfterDays?: number;
}

export type BlobRuleWithPrefix = (BlobRuleInput | RESTPutAPIBlobRuleBody) & { prefix: string };

export interface BlobImageOptions {
	width?: number;
	height?: number;
	/** For example `scale-down`, `contain`, `cover`, `crop`, `pad`. */
	fit?: string;
	/** For example `auto`, `webp`, `avif`, `jpeg`, `png`. */
	format?: string;
	/** 1–100. */
	quality?: number;
}

export type BlobDeleteManyInput = { ids: SnowFlake[] } | { prefix: string };

type Query = Record<string, string | number | boolean | null | undefined>;

interface ApiCall extends RequestOptions {
	query?: Query;
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
	onUploadProgress?: (loaded: number) => void;
}

interface Req extends Omit<TransportRequest, "signal"> {
	signal?: AbortSignal;
	timeout?: number;
	retry: boolean;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Top-level camelCase keys -> snake_case wire keys; `Date` becomes an ISO string; `undefined` is dropped. Nested values (metadata) are untouched. */
function toWire<T>(input: object): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) out[snake(key)] = value instanceof Date ? value.toISOString() : value;
	}
	return out as T;
}

export class BlobClient {
	readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly credentials: RequestCredentials | undefined;
	private readonly workspaceId: string | undefined;
	private readonly extraHeaders: Record<string, string>;
	private readonly partConcurrency: number;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly timeout: number;
	private readonly uploadTimeout: number;

	constructor(options: BlobClientOptions = {}) {
		if (options.apiKey && options.uploadToken) throw clientError("INVALID_ARGUMENT", "Pass either `apiKey` or `uploadToken`, not both");
		this.apiKey = options.apiKey ?? options.uploadToken;
		this.baseUrl = (options.baseUrl ?? "https://blob.vertracloud.app/v1").replace(/\/+$/, "");
		this.fetchImpl = options.fetch;
		this.credentials = options.credentials;
		this.workspaceId = options.workspaceId;
		this.extraHeaders = options.headers ?? {};
		this.partConcurrency = Math.max(1, Math.floor(options.partConcurrency ?? 4));
		this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
		this.retryDelayMs = options.retryDelayMs ?? 300;
		this.timeout = options.timeout ?? 30_000;
		this.uploadTimeout = options.uploadTimeout ?? 300_000;
	}

	// ---------------------------------------------------------------------------
	// Upload
	// ---------------------------------------------------------------------------

	/**
	 * Uploads a file. Up to 5 MB it is one `POST /objects`; above that it starts a direct upload and
	 * follows the mode the API picks: one signed PUT, or parts sent in parallel. Returns the object.
	 * Aborting `signal` during a direct upload cancels it on the server (best effort).
	 */
	async put(path: string, data: BlobData, options: BlobPutOptions = {}): Promise<APIBlobObject> {
		const { size, onProgress, onUpload, signal, timeout, ...write } = options;
		const src = toSource(data, size);
		const ctx: TransferContext = { signal, timeout, onProgress };
		if (src.size <= SIMPLE_UPLOAD_MAX) return this.putSimple(path, src, write, ctx);
		const upload = await this.api<APIBlobUpload>("POST", "/uploads", { json: { ...toWire<RESTPostAPIBlobUploadBody>(write), path, size: src.size }, signal, timeout });
		onUpload?.(upload);
		return this.transfer(upload, src, ctx, true, new Set());
	}

	/** Continues an interrupted direct upload, sending only the parts the server does not have yet. `data` must be the same file. */
	async resume(uploadId: SnowFlake, data: BlobData, options: BlobResumeOptions = {}): Promise<APIBlobObject> {
		const { size, onProgress, signal, timeout } = options;
		const src = toSource(data, size);
		const upload = await this.api<APIBlobUpload>("GET", `/uploads/${enc(uploadId)}`, { signal, timeout });
		return this.transfer(upload, src, { signal, timeout, onProgress }, false, new Set(upload.uploaded_parts ?? []));
	}

	/** Direct uploads still in progress. */
	listUploads(options: RequestOptions = {}): Promise<APIBlobUpload[]> {
		return this.api("GET", "/uploads", options);
	}

	/** Aborts a direct upload and frees its reserved storage. Repeating it is not an error. */
	async abortUpload(uploadId: SnowFlake, options: RequestOptions = {}): Promise<void> {
		await this.api("DELETE", `/uploads/${enc(uploadId)}`, options);
	}

	private async putSimple(path: string, src: Source, write: BlobWriteOptions, ctx: TransferContext): Promise<APIBlobObject> {
		const { metadata, ...rest } = write;
		const query = toWire<RESTPostAPIBlobObjectQuery>({ ...rest, path, ...(metadata ? { metadata: JSON.stringify(metadata) } : {}) });
		const form = new FormData();
		form.append("file", new Blob([await src.read(0, src.size)] as BlobPart[]), path.split("/").pop() || "file");
		const object = await this.api<APIBlobObject>("POST", "/objects", {
			query: query as unknown as Query,
			body: form,
			signal: ctx.signal,
			timeout: ctx.timeout ?? this.uploadTimeout,
			onUploadProgress: ctx.onProgress && ((loaded) => ctx.onProgress?.({ loaded: Math.min(loaded, src.size), total: src.size })),
		});
		ctx.onProgress?.({ loaded: src.size, total: src.size });
		return object;
	}

	private async transfer(upload: APIBlobUpload, src: Source, ctx: TransferContext, abortOnUserAbort: boolean, skip: Set<number>): Promise<APIBlobObject> {
		if (src.size !== upload.size) throw clientError("INVALID_ARGUMENT", `The data has ${src.size} bytes but the upload was created for ${upload.size}`);
		try {
			if (upload.mode === "single") await this.putSingle(upload, src, ctx);
			else await this.putParts(upload, src, ctx, skip);
			return await this.api<APIBlobObject>("POST", `/uploads/${enc(upload.id)}/complete`, { signal: ctx.signal, timeout: ctx.timeout });
		} catch (error) {
			// Only an explicit abort cancels the upload; any other failure leaves it open so `resume` can finish it.
			if (abortOnUserAbort && ctx.signal?.aborted) await this.abortUpload(upload.id, { timeout: 5000 }).catch(() => {});
			throw error;
		}
	}

	private async putSingle(upload: APIBlobUpload, src: Source, ctx: TransferContext): Promise<void> {
		if (!upload.url) throw clientError("INVALID_RESPONSE", "The upload has no URL");
		const body = await src.read(0, src.size);
		await this.putBytes(upload.url, upload.headers, body, ctx.signal, ctx.onProgress && ((loaded) => ctx.onProgress?.({ loaded: Math.min(loaded, src.size), total: src.size })));
		ctx.onProgress?.({ loaded: src.size, total: src.size });
	}

	private async putParts(upload: APIBlobUpload, src: Source, ctx: TransferContext, skip: Set<number>): Promise<void> {
		const { part_size: partSize, part_count: partCount } = upload;
		if (!partSize || !partCount) throw clientError("INVALID_RESPONSE", "The multipart upload has no part layout");
		const range = (n: number): [number, number] => [(n - 1) * partSize, Math.min(n * partSize, src.size)];
		const pending: number[] = [];
		let done = 0;
		for (let n = 1; n <= partCount; n++) {
			if (skip.has(n)) done += range(n)[1] - range(n)[0];
			else pending.push(n);
		}
		const total = src.size;
		const inflight = new Map<number, number>();
		const report = () => {
			let loaded = done;
			for (const v of inflight.values()) loaded += v;
			ctx.onProgress?.({ loaded: Math.min(loaded, total), total });
		};
		if (done > 0) report();

		// Part workers share a controller so one failure stops the others.
		const ctl = new AbortController();
		const onUserAbort = () => ctl.abort();
		ctx.signal?.addEventListener("abort", onUserAbort, { once: true });
		if (ctx.signal?.aborted) ctl.abort();

		const urls = new Map<number, APIBlobUploadPart>();
		let cursor = 0;
		let failed = false;
		let lock: Promise<unknown> = Promise.resolve();
		// Serialised: URL batches are requested in order, and stream sources must be read in order.
		const next = () => {
			const run = lock.then(async () => {
				if (failed || cursor >= pending.length) return null;
				const n = pending[cursor];
				if (!urls.has(n)) {
					const batch = pending.slice(cursor, cursor + PART_URLS_PER_REQUEST);
					const parts = await this.api<APIBlobUploadPart[]>("POST", `/uploads/${enc(upload.id)}/parts`, { json: { part_numbers: batch } satisfies RESTPostAPIBlobUploadPartsBody, signal: ctl.signal, timeout: ctx.timeout });
					for (const part of parts) urls.set(part.part_number, part);
				}
				const part = urls.get(n);
				if (!part) throw clientError("INVALID_RESPONSE", `The API did not return a URL for part ${n}`);
				cursor++;
				const [start, end] = range(n);
				return { n, part, bytes: await src.read(start, end), size: end - start };
			});
			lock = run.catch(() => {});
			return run;
		};

		const worker = async () => {
			for (let job = await next(); job; job = await next()) {
				await this.putBytes(
					job.part.url,
					job.part.headers,
					job.bytes,
					ctl.signal,
					ctx.onProgress &&
						((loaded) => {
							inflight.set(job.n, Math.min(loaded, job.size));
							report();
						}),
				);
				inflight.delete(job.n);
				done += job.size;
				report();
			}
		};
		try {
			await Promise.all(
				Array.from({ length: Math.min(this.partConcurrency, pending.length) }, () =>
					worker().catch((error) => {
						failed = true;
						ctl.abort();
						throw error;
					}),
				),
			);
		} finally {
			ctx.signal?.removeEventListener("abort", onUserAbort);
		}
	}

	/** PUT to a signed URL with exactly the headers the API returned. No credentials are attached. Retried on 5xx and network errors. */
	private async putBytes(url: string, headers: Record<string, string> | undefined, body: Blob | Uint8Array, signal: AbortSignal | undefined, onUploadProgress?: (loaded: number) => void): Promise<void> {
		const res = await this.exec({ method: "PUT", url, headers: { ...headers }, body: body as BodyInit, signal, timeout: this.uploadTimeout, retry: true, onUploadProgress });
		if (res.status < 200 || res.status >= 300) throw clientError("UPLOAD_FAILED", `The storage rejected the upload (HTTP ${res.status})`, res.status);
	}

	// ---------------------------------------------------------------------------
	// Objects
	// ---------------------------------------------------------------------------

	/** One page of objects plus the `folders` found under the prefix, and the `cursor` of the next page (`null` on the last). */
	listPage(options: BlobListPageOptions = {}): Promise<APIBlobObjectList> {
		const { signal, timeout, ...query } = options;
		return this.api("GET", "/objects", { query: toWire<RESTGetAPIBlobObjectsQuery>(query) as Query, signal, timeout });
	}

	/** Iterates every object that matches, fetching pages as needed. */
	async *list(options: BlobListOptions = {}): AsyncGenerator<APIBlobObject, void, undefined> {
		let cursor: string | undefined;
		do {
			const page = await this.listPage({ ...options, cursor });
			yield* page.objects;
			cursor = page.cursor ?? undefined;
		} while (cursor);
	}

	get(id: SnowFlake, options: RequestOptions = {}): Promise<APIBlobObject> {
		return this.api("GET", `/objects/${enc(id)}`, options);
	}

	update(id: SnowFlake, changes: BlobUpdateChanges, options: RequestOptions = {}): Promise<APIBlobObject> {
		return this.api("PATCH", `/objects/${enc(id)}`, { json: toWire<RESTPatchAPIBlobObjectBody>(changes), ...options });
	}

	/** Applies the same changes to any number of objects (sent in batches of 100, the API limit); one result per id, in the order of `ids`. */
	async updateMany(ids: SnowFlake[], changes: BlobUpdateChanges, options: RequestOptions = {}): Promise<APIBlobBatchResult[]> {
		const wire = toWire<RESTPatchAPIBlobObjectBody>(changes);
		const results: APIBlobBatchResult[] = [];
		for (let i = 0; i === 0 || i < ids.length; i += 100) {
			const batch = await this.api<APIBlobBatchResult[]>("PATCH", "/objects", { json: { ids: ids.slice(i, i + 100), changes: wire } satisfies RESTPatchAPIBlobObjectsBody, ...options });
			results.push(...batch);
		}
		return results;
	}

	copy(id: SnowFlake, path: string, options: BlobCopyOptions & { move?: boolean } = {}): Promise<APIBlobObject> {
		const { signal, timeout, ...rest } = options;
		return this.api("POST", "/objects/copy", { json: { ...toWire<Partial<RESTPostAPIBlobObjectCopyBody>>(rest), source: id, path }, signal, timeout });
	}

	/** Moves or renames an object; the id stays the same. */
	move(id: SnowFlake, path: string, options: BlobCopyOptions = {}): Promise<APIBlobObject> {
		return this.copy(id, path, { ...options, move: true });
	}

	async delete(id: SnowFlake, options: RequestOptions = {}): Promise<void> {
		await this.api("DELETE", `/objects/${enc(id)}`, options);
	}

	/**
	 * Deletes by `ids` or by folder `prefix`, repeating while the API reports `remaining`
	 * (it deletes up to 1000 per call). The result merges every round.
	 */
	async deleteMany(input: BlobDeleteManyInput, options: RequestOptions = {}): Promise<APIBlobDeleteResult> {
		const total: APIBlobDeleteResult = { deleted: [], not_found: [], remaining: false };
		let ids = "ids" in input ? [...input.ids] : undefined;
		for (;;) {
			const body: RESTDeleteAPIBlobObjectsBody = ids ? { ids: ids.slice(0, 1000) } : { prefix: (input as { prefix: string }).prefix };
			const res = await this.api<APIBlobDeleteResult>("DELETE", "/objects", { json: body, ...options });
			total.deleted.push(...res.deleted);
			total.not_found.push(...res.not_found);
			if (ids) {
				const seen = new Set([...total.deleted, ...total.not_found]);
				ids = ids.filter((id) => !seen.has(id));
			}
			if (ids ? ids.length === 0 : !res.remaining) return total;
			if (res.deleted.length + res.not_found.length === 0) throw clientError("INVALID_RESPONSE", "deleteMany made no progress");
		}
	}

	/** A temporary download link (`{ url, expires_at }`). It cannot be revoked. */
	downloadUrl(id: SnowFlake, options: BlobDownloadUrlOptions = {}): Promise<APIBlobDownload> {
		const { signal, timeout, ...rest } = options;
		const query = { ...toWire<RESTGetAPIBlobObjectDownloadQuery>(rest), redirect: false };
		return this.api("GET", `/objects/${enc(id)}/download`, { query: query as Query, signal, timeout });
	}

	/**
	 * Builds an image-transformation URL from a public object (or its public URL). Pure: no request is made.
	 * Throws for a private object, which has no public URL.
	 */
	imageUrl(source: Pick<APIBlobObject, "url"> | string, options: BlobImageOptions = {}): string {
		const raw = typeof source === "string" ? source : source.url;
		if (!raw) throw clientError("INVALID_ARGUMENT", "Only public objects can be transformed; this object is private");
		const url = new URL(raw);
		const params: [string, number | string | undefined][] = [
			["w", options.width],
			["h", options.height],
			["fit", options.fit],
			["format", options.format],
			["q", options.quality],
		];
		for (const [key, value] of params) if (value !== undefined) url.searchParams.set(key, String(value));
		return url.toString();
	}

	// ---------------------------------------------------------------------------
	// Account, tokens, S3
	// ---------------------------------------------------------------------------

	stats(options: RequestOptions = {}): Promise<APIBlobStats> {
		return this.api("GET", "/stats", options);
	}

	/** Creates a token that fixes every constraint you pass; hand it to a browser as `uploadToken`. */
	createUploadToken(options: BlobUploadTokenOptions = {}): Promise<APIBlobUploadToken> {
		const { signal, timeout, ...rest } = options;
		return this.api("POST", "/upload-tokens", { json: toWire<RESTPostAPIBlobUploadTokenBody>(rest), signal, timeout });
	}

	/** S3-compatible credentials derived from the API key, for aws-cli, rclone or boto3. */
	s3Credentials(options: RequestOptions = {}): Promise<APIBlobS3Credentials> {
		return this.api("GET", "/s3/credentials", options);
	}

	readonly shares = {
		create: (objectId: SnowFlake, options: BlobShareOptions = {}): Promise<APIBlobShare> => {
			const { signal, timeout, ...rest } = options;
			return this.api("POST", "/shares", { json: { ...toWire<Partial<RESTPostAPIBlobShareBody>>(rest), object_id: objectId }, signal, timeout });
		},
		list: (options: RequestOptions & { objectId?: SnowFlake } = {}): Promise<APIBlobShare[]> => this.api("GET", "/shares", { query: { object_id: options.objectId }, signal: options.signal, timeout: options.timeout }),
		revoke: async (shareId: SnowFlake, options: RequestOptions = {}): Promise<void> => {
			await this.api("DELETE", `/shares/${enc(shareId)}`, options);
		},
	};

	readonly rules = {
		get: (options: RequestOptions = {}): Promise<APIBlobRules> => this.api("GET", "/rules", options),
		/** Replaces the whole list. `etag` is the one from the list you read; a stale one fails with `BLOB_RULES_CONFLICT`. */
		set: (rules: BlobRuleWithPrefix[], etag: string, options: RequestOptions = {}): Promise<APIBlobRules> => this.api("PUT", "/rules", { json: { rules: rules.map((rule) => toWire(rule)) } as RESTPutAPIBlobRulesBody, headers: { "If-Match": etag }, ...options }),
		/** Creates or changes the rule of one folder; returns the whole list and its new etag. */
		put: (prefix: string, rule: BlobRuleInput | RESTPutAPIBlobRuleBody, options: RequestOptions = {}): Promise<APIBlobRules> => this.api("PUT", `/rules/${enc(prefix)}`, { json: toWire<RESTPutAPIBlobRuleBody>(rule), ...options }),
		delete: (prefix: string, options: RequestOptions = {}): Promise<APIBlobRules> => this.api("DELETE", `/rules/${enc(prefix)}`, options),
	};

	readonly domains = {
		list: (options: RequestOptions = {}): Promise<APIBlobCustomDomain[]> => this.api("GET", "/domains", options),
		add: (hostname: string, options: RequestOptions & { prefix?: string; web_content?: boolean } = {}): Promise<APIBlobCustomDomain> => {
			const { signal, timeout, prefix, web_content } = options;
			return this.api("POST", "/domains", { json: { hostname, ...(prefix ? { prefix } : {}), ...(web_content === undefined ? {} : { web_content }) } satisfies RESTPostAPIBlobDomainBody, signal, timeout });
		},
		update: (domainId: SnowFlake, body: RESTPatchAPIBlobDomainBody, options: RequestOptions = {}): Promise<APIBlobCustomDomain> => this.api("PATCH", `/domains/${enc(domainId)}`, { json: body, signal: options.signal, timeout: options.timeout }),
		verify: (domainId: SnowFlake, options: RequestOptions = {}): Promise<APIBlobCustomDomain> => this.api("POST", `/domains/${enc(domainId)}/verify`, options),
		remove: async (domainId: SnowFlake, options: RequestOptions = {}): Promise<void> => {
			await this.api("DELETE", `/domains/${enc(domainId)}`, options);
		},
	};

	// ---------------------------------------------------------------------------
	// HTTP
	// ---------------------------------------------------------------------------

	/** One API call: builds the URL, authenticates, unwraps `{ response }` and turns an error envelope into a `BlobError`. */
	private async api<T>(method: string, path: string, call: ApiCall = {}): Promise<T> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries({ ...call.query, workspace_id: this.workspaceId })) {
			if (value !== undefined && value !== null) query.set(key, String(value));
		}
		const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders, ...call.headers };
		if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		let body = call.body;
		if (call.json !== undefined) {
			body = JSON.stringify(call.json);
			headers["content-type"] = "application/json";
		}
		const qs = query.toString();
		const res = await this.exec({
			method,
			url: `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`,
			headers,
			body,
			credentials: this.credentials,
			signal: call.signal,
			timeout: call.timeout ?? this.timeout,
			retry: method === "GET",
			onUploadProgress: call.onUploadProgress,
		});

		let parsed: unknown;
		if (res.text) {
			try {
				parsed = JSON.parse(res.text);
			} catch {
				if (res.status >= 200 && res.status < 300) throw clientError("INVALID_RESPONSE", "The API returned a body that is not JSON", res.status);
			}
		}
		if (res.status >= 200 && res.status < 300) return ((parsed as { response?: T } | undefined)?.response ?? null) as T;
		const err = (parsed ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
		const retryAfter = Number(res.retryAfter);
		throw new BlobError(res.status, { code: typeof err.code === "string" ? err.code : `HTTP_${res.status}`, message: typeof err.message === "string" ? err.message : undefined, details: err.details }, res.retryAfter && Number.isFinite(retryAfter) ? retryAfter : undefined);
	}

	/** Sends a request, retrying 5xx and network errors when `req.retry` (never 429). */
	private async exec(req: Req): Promise<TransportResponse> {
		const retries = req.retry ? this.maxRetries : 0;
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await this.once(req);
				if (res.status < 500 || attempt >= retries) return res;
			} catch (error) {
				if (!(error instanceof BlobError) || (error.code !== "NETWORK_ERROR" && error.code !== "TIMEOUT") || attempt >= retries) throw error;
			}
			await sleep(Math.min(this.retryDelayMs * 2 ** attempt, MAX_BACKOFF_MS) * (0.5 + Math.random() / 2), req.signal);
		}
	}

	private async once(req: Req): Promise<TransportResponse> {
		const user = req.signal;
		if (user?.aborted) throw aborted();
		const ctl = new AbortController();
		const onAbort = () => ctl.abort();
		user?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer = req.timeout
			? setTimeout(() => {
					timedOut = true;
					ctl.abort();
				}, req.timeout)
			: undefined;
		const useXhr = req.onUploadProgress && !this.fetchImpl && typeof XMLHttpRequest !== "undefined";
		try {
			const send = useXhr ? xhrTransport : fetchTransport(this.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)));
			return await send({ ...req, signal: ctl.signal });
		} catch {
			// The original error is not forwarded: it can carry the request URL, which may be a signed upload URL.
			if (user?.aborted) throw aborted();
			if (timedOut) throw clientError("TIMEOUT", "The request timed out");
			throw clientError("NETWORK_ERROR", "The request failed before a response was received");
		} finally {
			clearTimeout(timer);
			user?.removeEventListener("abort", onAbort);
		}
	}
}

interface TransferContext extends RequestOptions {
	onProgress?: (progress: BlobProgress) => void;
}

const enc = encodeURIComponent;
