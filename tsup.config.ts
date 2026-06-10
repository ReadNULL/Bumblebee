import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  external: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    '@larksuiteoapi/node-sdk',
    'xstate',
    'zod',
    'yaml',
    'typebox'
  ]
})
