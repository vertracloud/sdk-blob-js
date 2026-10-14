import { clientError } from "./errors.js";

/** Everything `put` and `resume` accept as file content. A `ReadableStream` also needs `size`. */
export type BlobData = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string;

export interface Source {
	size: number;
	/** Bytes `[start, end)`. Stream sources must be read in ascending, non-overlapping ranges (skipped bytes are discarded). */
	read(start: number, end: number): Promise<Blob | Uint8Array>;
}

export function toSource(data: BlobData, size?: number): Source {
	if (typeof data === "string") return bytes(new TextEncoder().encode(data));
	if (data instanceof Uint8Array) return bytes(data);
	if (data instanceof ArrayBuffer) return bytes(new Uint8Array(data));
	if (typeof Blob !== "undefined" && data instanceof Blob) return { size: data.size, read: async (s, e) => data.slice(s, e) };
	if (typeof (data as ReadableStream).getReader === "function") {
		if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw clientError("INVALID_ARGUMENT", "`size` is required when the data is a ReadableStream");
		return stream(data as ReadableStream<Uint8Array>, size);
	}
	throw clientError("INVALID_ARGUMENT", "Unsupported data type: use Blob, File, ArrayBuffer, Uint8Array, ReadableStream or string");
}

const bytes = (u8: Uint8Array): Source => ({ size: u8.byteLength, read: async (s, e) => u8.subarray(s, e) });

function stream(readable: ReadableStream<Uint8Array>, size: number): Source {
	const reader = readable.getReader();
	let rest: Uint8Array = new Uint8Array(0);
	let pos = 0;
	const take = async (n: number, keep: boolean): Promise<Uint8Array> => {
		const out = new Uint8Array(keep ? n : 0);
		let got = 0;
		while (got < n) {
			if (rest.length === 0) {
				const { done, value } = await reader.read();
				if (done) throw clientError("INVALID_ARGUMENT", "The stream ended before `size` bytes were read");
				rest = value;
				continue;
			}
			const m = Math.min(n - got, rest.length);
			if (keep) out.set(rest.subarray(0, m), got);
			rest = rest.subarray(m);
			got += m;
		}
		pos += n;
		return out;
	};
	return {
		size,
		async read(start, end) {
			if (start < pos) throw clientError("INVALID_ARGUMENT", "A stream can only be read forward");
			if (start > pos) await take(start - pos, false);
			return take(end - start, true);
		},
	};
}
