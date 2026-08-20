import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@artificialnotimbecile/dsh-remote-runtime',
  entry: ['lib/types/index.js', 'lib/types/types.js', 'lib/types/cli.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//u, 'react', 'react-dom', 'undici', 'zod'] },
})
