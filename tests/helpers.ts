import { BlobClient, type BlobClientOptions } from "../src/index";

export interface Call {
	method: string;
	url: URL;
	headers: Record<string, string>;
	credentials: RequestCredentials | undefined;
	/** Parsed JSON body, when the request sent one. */
	// biome-ignore lint/suspicious/noExplicitAny: loosely typed test helper
	json: any;
	/** Raw body bytes for binary uploads, or the FormData for the simple upload. */
	bytes: Uint8Array | undefined;
	form: FormData | undefined;
}

export const ok = (response: unknown, status = 200) => new Response(JSON.stringify({ response }), { status, headers: { "content-type": "application/json" } });
export const fail = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify({ code, ...extra }), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that records every call and answers through `handler`. It honours `AbortSignal` like the real one. */
export function fake(handler: (call: Call, index: number) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = (input: string, init: RequestInit = {}) =>
		new Promise<Response>((resolve, reject) => {
			const signal = init.signal ?? undefined;
			const onAbort = () => reject(new DOMException("aborted", "AbortError"));
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			void (async () => {
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
				const body = init.body;
				const call: Call = { method: init.method ?? "GET", url: new URL(input), headers, credentials: init.credentials, json: undefined, bytes: undefined, form: undefined };
				if (typeof body === "string") call.json = JSON.parse(body);
				else if (body instanceof FormData) call.form = body;
				else if (body instanceof Blob) call.bytes = new Uint8Array(await body.arrayBuffer());
				else if (body) call.bytes = body as Uint8Array;
				calls.push(call);
				return handler(call, calls.length - 1);
			})().then(resolve, reject);
		});
	return { fetch, calls };
}

export function makeClient(handler: Parameters<typeof fake>[0], options: BlobClientOptions = {}) {
	const f = fake(handler);
	const client = new BlobClient({ apiKey: "secret-key", baseUrl: "https://blob.test/v1", fetch: f.fetch, retryDelayMs: 0, ...options });
	return { client, calls: f.calls };
}

export const obj = (over: Record<string, unknown> = {}) => ({ id: "1", path: "a.txt", size: 3, visibility: "private", url: null, ...over });
