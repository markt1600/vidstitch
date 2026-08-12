/**
 * The Blob store is connected with the custom env var prefix "vidstitch2blob",
 * so the read-write token is not at the SDK's default BLOB_READ_WRITE_TOKEN
 * location and must be passed explicitly to every @vercel/blob call.
 */
export function blobToken(): string | undefined {
  return (
    process.env.vidstitch2blob_READ_WRITE_TOKEN ??
    process.env.BLOB_READ_WRITE_TOKEN
  );
}
