import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist stays in Node's native module graph: Turbopack bundling breaks
  // its dynamic worker import and statically rewrites require.resolve() calls
  // (returning module ids instead of filesystem paths).
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
