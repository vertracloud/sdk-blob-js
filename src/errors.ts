/** Error envelope sent by the API on any non-2xx response: `{ code, message?, details? }`. */
export interface BlobErrorBody {
	code: string;
	message?: string;
	details?: unknown;
}

/**
 * Codes the SDK raises itself (they never come from the API): `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`,
 * `INVALID_ARGUMENT`, `UPLOAD_FAILED` (the storage rejected a direct upload) and `INVALID_RESPONSE`.
 * `status` is `0` for the ones that happened before an HTTP response existed.
 */
export type BlobClientErrorCode = "NETWORK_ERROR" | "TIMEOUT" | "ABORTED" | "INVALID_ARGUMENT" | "UPLOAD_FAILED" | "INVALID_RESPONSE";

/**
 * Error thrown for every failed call: an API error response (`code` is an `APIErrorCode`, for example
 * `BLOB_OBJECT_NOT_FOUND`) or a client-side failure (see {@link BlobClientErrorCode}).
 *
 * `toString()` and `toJSON()` never include the request that produced the error (URL, headers,
 * credentials, signed upload URLs) — only `status`, `code`, `message`, `details` and `retryAfter`.
 */
export class BlobError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: unknown;
	/** Seconds to wait before retrying, from the `Retry-After` header (429 responses). */
	readonly retryAfter: number | undefined;

	constructor(status: number, body: BlobErrorBody, retryAfter?: number) {
		super(body.message || body.code);
		this.name = "BlobError";
		this.status = status;
		this.code = body.code;
		this.details = body.details;
		this.retryAfter = retryAfter;
		Object.setPrototypeOf(this, new.target.prototype);
	}

	toJSON(): { name: string; status: number; code: string; message: string; details: unknown; retryAfter: number | undefined } {
		return { name: this.name, status: this.status, code: this.code, message: this.message, details: this.details, retryAfter: this.retryAfter };
	}

	override toString(): string {
		return `${this.name} [${this.status}] ${this.code}: ${this.message}`;
	}
}

export const clientError = (code: BlobClientErrorCode, message: string, status = 0): BlobError => new BlobError(status, { code, message });
