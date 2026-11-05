import { join } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  turbopack: { root: join(import.meta.dirname, '../..') },
  transpilePackages: ['@rem/shared'],
  serverExternalPackages: ['sharp', 'postgres'],
  poweredByHeader: false,
};

export default config;
