/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Cross-origin isolation on every response: it gives the page SharedArrayBuffer (multi-threaded
        // WebAssembly inference), and Chrome only starts a dedicated worker from an isolated document
        // when the worker script itself (the webpack chunk, onnxruntime-web's thread pool script,
        // pdf.js's worker) is served with COEP too. Every subresource is same-origin or CORS.
        source: '/:path*',
        headers: [
          {key: 'Cross-Origin-Opener-Policy', value: 'same-origin'},
          {key: 'Cross-Origin-Embedder-Policy', value: 'require-corp'},
        ],
      },
      {
        // The onnxruntime-web and pdf.js runtimes live in version-named directories (synced from
        // node_modules by scripts/sync-ocr-runtime.mjs), as do the patched GLM-OCR graphs
        // (scripts/patch-glm-graphs.py), so they can be cached forever.
        source: '/(ocr-runtime|models)/:lib/:version/:path*',
        headers: [{key: 'Cache-Control', value: 'public, max-age=31536000, immutable'}],
      },
      {
        // The service worker must never be served stale, or shell updates would lag a full cache lifetime.
        source: '/sw.js',
        headers: [
          {key: 'Cache-Control', value: 'no-cache'},
          {key: 'Service-Worker-Allowed', value: '/'},
        ],
      },
    ];
  },
  webpack: config => {
    // onnxruntime-web's bundle locates itself with `new URL("ort.webgpu.bundle.min.mjs", import.meta.url)`
    // (through a renamed `URL`, which webpack still tracks); webpack would then emit a raw copy of
    // the ESM bundle as an asset, which the production minifier rejects. The app sets the runtime
    // paths explicitly, so nothing in these files needs `new URL()` resolution at build time.
    config.module.rules.push({
      test: /[\\/]node_modules[\\/]onnxruntime-web[\\/]dist[\\/].*\.mjs$/,
      parser: {url: false},
    });
    return config;
  },
};

module.exports = nextConfig;
