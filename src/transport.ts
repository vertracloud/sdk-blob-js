import { type BlobError, clientError } from "./errors.js";

export interface TransportRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: BodyInit | null;
	credentials?: RequestCredentials;
	signal: AbortSignal;
	/** Bytes of the request body sent so far. Only reported by the XMLHttpRequest transport. */
	onUploadProgress?: (loaded: number) => void;
}

export interface TransportResponse {
	status: number;
	retryAfter: string | null;
	text: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const fetchTransport =
	(fetchImpl: FetchLike) =>
	async (req: TransportRequest): Promise<TransportResponse> => {
		const init: RequestInit = { method: req.method, headers: req.headers, body: req.body ?? null, signal: req.signal };
		if (req.credentials) init.credentials = req.credentials;
		const res = await fetchImpl(req.url, init);
		return { status: res.status, retryAfter: res.headers.get("retry-after"), text: await res.text() };
	};

/** Browser-only transport: `fetch` cannot report upload progress, XMLHttpRequest can. */
export const xhrTransport = (req: TransportRequest): Promise<TransportResponse> =>
	new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(req.method, req.url);
		for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
		if (req.credentials === "include") xhr.withCredentials = true;
		if (req.onUploadProgress) {
			const report = req.onUploadProgress;
			xhr.upload.onprogress = (e) => report(e.loaded);
		}
		const onAbort = () => xhr.abort();
		req.signal.addEventListener("abort", onAbort, { once: true });
		const done = () => req.signal.removeEventListener("abort", onAbort);
		xhr.onload = () => {
			done();
			// Only 429 carries Retry-After; reading it on other responses (e.g. presigned PUTs) logs "unsafe header" in browsers.
			resolve({ status: xhr.status, retryAfter: xhr.status === 429 ? xhr.getResponseHeader("Retry-After") : null, text: xhr.responseText });
		};
		xhr.onerror =
			xhr.onabort =
			xhr.ontimeout =
				() => {
					done();
					reject(new Error("request failed"));
				};
		xhr.send((req.body ?? null) as XMLHttpRequestBodyInit | null);
	});

export const aborted = (): BlobError => clientError("ABORTED", "The operation was aborted");

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(aborted());
		const onAbort = () => {
			clearTimeout(timer);
			reject(aborted());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
