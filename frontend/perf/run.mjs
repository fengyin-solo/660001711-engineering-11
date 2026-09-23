#!/usr/bin/env node
/**
 * 性能基线入口：用 sucrase（纯 JS，无平台相关二进制）把
 * perf/benchmark.ts 与应用真实渲染源码转译为 ESM 后在 Node 中执行。
 * 本地开发与构建流程都通过这个入口跑，行为完全一致；不依赖浏览器。
 */
import { transform } from 'sucrase'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(here, '..')
const outDir = path.join(frontendDir, '.perf', 'build')
const srcRoot = path.join(frontendDir, 'src')

// 收集 benchmark 闭包可达的全部 .ts 源文件（render 内核 + 数据）
async function collectTsFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectTsFiles(full, acc)
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

async function transpileFile(file) {
  const code = await readFile(file, 'utf8')
  const { code: out } = transform(code, { transforms: ['typescript'] })
  const rel = path.relative(frontendDir, file).replace(/\.ts$/, '.mjs')
  const dest = path.join(outDir, rel)
  await mkdir(path.dirname(dest), { recursive: true })
  // 相对导入补上 .mjs 扩展名以满足 Node ESM 解析
  await writeFile(dest, out.replace(/(from\s+['"]\.[^'"]*?)(['"])/g, '$1.mjs$2'), 'utf8')
  return dest
}

const files = [
  path.join(here, 'benchmark.ts'),
  path.join(here, 'mockCanvas.ts'),
  ...(await collectTsFiles(srcRoot)),
]
await mkdir(outDir, { recursive: true })
for (const f of files) await transpileFile(f)

const entry = path.join(outDir, 'perf', 'benchmark.mjs')
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PERF_ROOT: frontendDir },
})
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code)
  process.kill(process.pid, signal)
})
