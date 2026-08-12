/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the ffmpeg binary out of the webpack bundle and include it in the
  // serverless function's traced files so it exists at runtime on Vercel.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/merge": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
