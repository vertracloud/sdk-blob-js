# @vertracloud/blob

Official JavaScript/TypeScript SDK for Vertra Cloud Blob Storage. Works in Node.js 18+, browsers and edge runtimes, using the native `fetch`.

> **Status: under development, not published yet.** The API surface below may still change before the first release.

Full documentation: <https://docs.vertracloud.app>

## Installation

```bash
npm install @vertracloud/blob
```

## Quick start

```ts
import { BlobClient } from "@vertracloud/blob";

const blob = new BlobClient({ apiKey: process.env.VERTRA_API_KEY });

const object = await blob.put("images/logo.png", fileBytes, { visibility: "public" });
console.log(object.id, object.url);
```

### Client options

| Option | Default | Notes |
|---|---|---|
| `apiKey` | | API key with `blob:read` / `blob:write`. Sent as `Authorization: Bearer <key>`. |
| `uploadToken` | | An upload token (`vcup_…`) instead of an API key. Only valid on the upload routes. |
| `baseUrl` | `https://blob.vertracloud.app/v1` | Includes the version prefix; every route is appended to it (`${baseUrl}/objects`). |
| `fetch` | global `fetch` | Custom implementation. When set, upload progress is reported per finished part instead of per byte. |
| `credentials` | | Passed to every API call (for example `"include"` with a cookie session; no `Authorization` header is needed then). Never sent to signed upload URLs. |
| `workspaceId` | | Added as `?workspace_id=` to every call, to act on the blob of a workspace owner. |
| `headers` | | Extra headers for every API call. |
| `partConcurrency` | `4` | Parts uploaded at the same time. |
| `maxRetries` | `3` | Retries for `GET` and for the PUT of a part or single upload, on 5xx and network errors. Never on writes to the API or on `429`. |
| `retryDelayMs` | `300` | First retry delay; doubles each attempt, with jitter. |
| `timeout` | `30000` | Per API call, in ms. Every method also accepts `{ timeout, signal }`. |
| `uploadTimeout` | `300000` | Per request that sends file bytes. |

### Naming: camelCase in, snake_case out

Options you pass use camelCase (`expiresIn`, `maxDownloads`, `randomSuffix`) and are converted to the API's snake_case internally.
The objects the SDK returns are the API payloads **as they are on the wire**, in snake_case (`object.content_type`, `upload.part_size`, `stats.used_bytes`). They are typed by `@vertracloud/api-types`, which this package re-exports.

## Uploading

```ts
const object = await blob.put("videos/intro.mp4", file, {
  visibility: "public",
  metadata: { owner: "alice" },
  signal: controller.signal,                          // AbortSignal
  onProgress: ({ loaded, total }) => bar.set(loaded / total),
});
```

`data` can be a `Blob`, `File`, `ArrayBuffer`, `Uint8Array`, `string` or `ReadableStream` (a stream also needs `size`).

- Up to 5 MB the file goes in one `POST /objects` request.
- Above that the SDK starts a direct upload and follows the mode the API returns: a single signed PUT, or a multipart upload whose parts are sent in parallel (`partConcurrency`), each retried on its own.
- Progress is by byte in browsers (the SDK uses `XMLHttpRequest` when `onProgress` is set and you did not pass a custom `fetch`) and by finished part in Node.js and edge runtimes.
- Aborting `signal` during a direct upload cancels it on the server (best effort) and throws a `BlobError` with code `ABORTED`.
- Any other failure leaves the upload open on the server so you can resume it.

### Resume

```ts
let uploadId: string;
try {
  await blob.put("backup.tar", file, { onUpload: (upload) => (uploadId = upload.id) });
} catch {
  // later, with the same file
  await blob.resume(uploadId, file, { onProgress });  // sends only the missing parts
}

const open = await blob.listUploads();                // direct uploads still in progress
await blob.abortUpload(uploadId);
```

### Browser with an upload token

Create a short-lived token on your server and hand it to the browser:

```ts
// server
const { token } = await new BlobClient({ apiKey }).createUploadToken({ prefix: "avatars/", maxSize: 5_000_000, allowedExtensions: ["png", "jpg"], expiresIn: 900 });

// browser
const blob = new BlobClient({ uploadToken: token });
await blob.put("avatars/me.png", file, { onProgress });
```

### Edge runtimes

Nothing special is needed: the SDK only uses `fetch`, `Blob`, `FormData` and `AbortController`.

## Objects

```ts
for await (const obj of blob.list({ prefix: "images/" })) {}          // follows the cursor for you
const page = await blob.listPage({ prefix: "images/", delimiter: "/", limit: 100 });
page.objects; page.folders; page.cursor;

await blob.get(id);
await blob.update(id, { metadata: { owner: "alice" }, visibility: "private" });   // null restores a default
await blob.updateMany(ids, { visibility: "private" });                           // any number of ids (sent in batches of 100)
await blob.copy(id, "backup/logo.png");
await blob.move(id, "img/logo.png");                                             // keeps the id
await blob.delete(id);
await blob.deleteMany({ prefix: "tmp/" });                                       // repeats while the API reports `remaining`
await blob.deleteMany({ ids });

const { url, expires_at } = await blob.downloadUrl(id, { expiresIn: 600, disposition: "attachment", filename: "logo.png" });
blob.imageUrl(obj, { width: 400, format: "webp" });                              // pure: builds ?w=400&format=webp on the public URL
```

`imageUrl` throws for a private object. `fit`, `height`, `quality` are also accepted.

## Shares, folder rules, domains, account

```ts
await blob.shares.create(id, { expiresIn: 3600, maxDownloads: 10, password });
await blob.shares.list({ objectId: id });
await blob.shares.revoke(shareId);

const { rules, etag } = await blob.rules.get();
await blob.rules.set([{ prefix: "tmp/", deleteAfterDays: 30 }], etag);           // sends If-Match; a stale etag fails with BLOB_RULES_CONFLICT
await blob.rules.put("tmp/", { deleteAfterDays: 7 });
await blob.rules.delete("tmp/");

await blob.domains.add("cdn.example.com");
await blob.domains.verify(domainId);
await blob.domains.list();
await blob.domains.remove(domainId);

await blob.stats();                                                              // usage, quota and plan limits
const s3 = await blob.s3Credentials();                                           // for aws-cli, rclone, boto3
```

## Errors

Every failure is a `BlobError`:

```ts
import { BlobError } from "@vertracloud/blob";

try {
  await blob.put("a.png", data);
} catch (error) {
  if (error instanceof BlobError) {
    error.status;       // HTTP status, 0 when no response was received
    error.code;         // for example "BLOB_OBJECT_ALREADY_EXISTS", "STORAGE_QUOTA_EXCEEDED"
    error.message;
    error.details;      // for example { path: "..." } on VALIDATION_ERROR
    error.retryAfter;   // seconds, on 429
  }
}
```

The SDK itself raises `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`, `INVALID_ARGUMENT`, `UPLOAD_FAILED` and `INVALID_RESPONSE`. Errors never include request headers, credentials or signed upload URLs. A `429` is never retried: wait `retryAfter` seconds yourself.

## Types

Payload types and enums (`BlobVisibility`, `BlobUploadMode`, `APIBlobObject`, `BlobObject`, the `REST…` request types, ...) are re-exported from [`@vertracloud/api-types`](https://www.npmjs.com/package/@vertracloud/api-types), installed with this package, so you can import everything from `@vertracloud/blob`.

## License

MIT
