// 性能基线入口：用 esbuild 把 TS 源码（含 src/render）即时打包后交给 Node 执行。
// 构建流水线与本地开发都调用这个脚本，读取同一份 perf/baseline.json 门槛。
//   node perf/run.mjs            对照门槛（超门槛退出码 1）
//   node perf/run.mjs --update   实测并重新生成门槛
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, 'run-bench.ts')
const outfile = resolve(here, '.cache/run-bench.bundle.mjs')

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
})

await import(outfile + `?t=${Date.now()}`)
