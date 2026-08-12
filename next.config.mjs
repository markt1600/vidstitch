/** @type {import('next').NextConfig} */
const nextConfig = {
  // Inlined into the client bundle: cuts @vercel/blob's silent upload retries
  // from 10 (~17 min of exponential backoff that looks like a hang) to 3, so
  // real errors surface in the UI within seconds.
  env: {
    VERCEL_BLOB_RETRIES: "3",
  },
  // Keep the ffmpeg binary out of the webpack bundle and include it in the
  // serverless function's traced files so it exists at runtime on Vercel.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/merge": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
