import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // pdfkit reads its font files from disk at runtime; keep it unbundled and ship its data folder.
  serverExternalPackages: ['pdfkit'],
  outputFileTracingIncludes: { '/api/export': ['./node_modules/pdfkit/js/data/**'] },
};
export default config;
