import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderFrame, type FrameParams } from '../src/render/frame'
import { createMockContext } from './mock-ctx'
import { buildCases, configSignature, loadBaseline, loadConfig, ConfigError } from './config'
import type { BaselineEntry, BaselineFile, CaseMeasurement, CaseSpec, PerfConfig } from './types'

const here = dirname(fileURLToPath(import.meta.url))
const perfDir = resolve(here, '..')
const configPath = resolve(perfDir, 'perf.config.json')
const baselinePath = resolve(perfDir, 'baseline.json')

const UPDATE = process.argv.includes('--update')

function layersLabel(c: Pick<CaseSpec, 'showLabels' | 'showConstLines' | 'showGrid'>): string {
  return `labels ${c.showLabels ? 'on' : 'off'} | lines ${c.showConstLines ? 'on' : 'off'} | grid ${c.showGrid ? 'on' : 'off'}`
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * 截尾统计：丢弃最高的 trimTailFraction 比例的帧（操作系统调度/GC 抢占
 * 造成的零星离群帧），返回截尾后的均值与最差帧耗时。
 */
function trimmedStats(times: number[], trimTailFraction: number): { meanMs: number; worstMs: number; rawMaxMs: number } {
  const sorted = [...times].sort((a, b) => a - b)
  const drop = Math.floor(sorted.length * trimTailFraction)
  const kept = drop > 0 ? sorted.slice(0, sorted.length - drop) : sorted
  const mean = kept.reduce((s, t) => s + t, 0) / kept.length
  return {
    meanMs: round3(mean),
    worstMs: round3(kept[kept.length - 1]),
    rawMaxMs: round3(sorted[sorted.length - 1]),
  }
}

function warmupEngine(config: PerfConfig): void {
  // 进程级预热：先对最重的参数组合（最高缩放 + 全图层）渲染若干帧，
  // 让 V8 完成 JIT 编译后再进入正式测量，避免首个 case 承担冷启动尖峰。
  const ctx = createMockContext()
  const maxZoom = Math.max(...config.zoomTiers.map(t => t.zoom))
  for (let f = 0; f < config.globalWarmupFrames; f++) {
    renderFrame(ctx, {
      width: config.canvas.width,
      height: config.canvas.height,
      timeMs: config.startTimeMs + f * config.timeStepMs,
      zoom: maxZoom,
      latitude: config.latitude,
      panX: 0,
      panY: 0,
      showLabels: true,
      showConstLines: true,
      showGrid: true,
    })
  }
}

function frameParams(config: PerfConfig, spec: CaseSpec, frame: number): FrameParams {
  return {
    width: config.canvas.width,
    height: config.canvas.height,
    timeMs: config.startTimeMs + frame * config.timeStepMs, // 时间逐帧推进
    zoom: spec.zoom,
    latitude: config.latitude,
    panX: 0,
    panY: 0,
    showLabels: spec.showLabels,
    showConstLines: spec.showConstLines,
    showGrid: spec.showGrid,
  }
}

function measureCase(config: PerfConfig, spec: CaseSpec): CaseMeasurement {
  const ctx = createMockContext()
  const total = config.warmupFrames + config.measureFrames
  const times: number[] = []

  for (let f = 0; f < total; f++) {
    const t0 = performance.now()
    renderFrame(ctx, frameParams(config, spec, f))
    const t1 = performance.now()
    if (f >= config.warmupFrames) times.push(t1 - t0)
  }

  const stats = trimmedStats(times, config.trimTailFraction)
  return {
    caseId: spec.caseId,
    zoomTierId: spec.zoomTierId,
    comboId: spec.comboId,
    zoom: spec.zoom,
    layers: layersLabel(spec),
    frames: config.measureFrames,
    meanMs: stats.meanMs,
    worstMs: stats.worstMs,
    rawMaxMs: stats.rawMaxMs,
  }
}

function fmtDelta(measured: number, threshold: number): string {
  const diff = measured - threshold
  const pct = (diff / threshold) * 100
  const sign = diff > 0 ? '+' : ''
  return `${sign}${round3(diff)}ms (${sign}${pct.toFixed(1)}%)`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length + 1)
}

/** 门槛 = max(实测×headroom, 实测+抖动地板)，四舍五入到微秒且保持正数 */
function threshold(measuredMs: number, headroom: number, floorMs: number): number {
  return round3(Math.max(measuredMs * headroom, measuredMs + floorMs, 0.001))
}

function writeBaseline(config: PerfConfig, measurements: CaseMeasurement[]): BaselineFile {
  const baseline: BaselineFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    headroom: config.headroom,
    jitterFloorMs: config.jitterFloorMs,
    worstJitterFloorMs: config.worstJitterFloorMs,
    trimTailFraction: config.trimTailFraction,
    configSignature: configSignature(config),
    entries: measurements.map<BaselineEntry>(m => ({
      caseId: m.caseId,
      zoomTierId: m.zoomTierId,
      comboId: m.comboId,
      layers: m.layers,
      zoom: m.zoom,
      frames: m.frames,
      meanMs: threshold(m.meanMs, config.headroom, config.jitterFloorMs),
      worstMs: threshold(m.worstMs, config.headroom, config.worstJitterFloorMs),
    })),
  }
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8')
  return baseline
}

function main(): void {
  let config: PerfConfig
  try {
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[perf] 参数配置不合法，基线流程中止：\n  ${err.message}\n`)
      process.exit(2)
    }
    throw err
  }

  const cases = buildCases(config)
  console.log(`\n[perf] 渲染性能基线（${UPDATE ? '更新门槛' : '对照门槛'}模式）`)
  console.log(`[perf] canvas=${config.canvas.width}x${config.canvas.height} 纬度=${config.latitude}  ` +
    `全局预热=${config.globalWarmupFrames}帧 组内预热=${config.warmupFrames}帧 测量=${config.measureFrames}帧/组  ` +
    `截尾=${config.trimTailFraction * 100}% 时间步长=${config.timeStepMs}ms`)
  console.log(`[perf] 参数组：${config.zoomTiers.length} 个缩放档位 × ${config.layerCombos.length} 个图层组合 = ${cases.length} 组`)

  // 门槛在测量之前先校验：门槛不合法时立即说明原因并退出，不浪费一轮渲染，也不静默放过
  let baseline: BaselineFile | null = null
  if (!UPDATE) {
    if (!existsSync(baselinePath)) {
      console.error(`\n[perf] 门槛文件不存在：${baselinePath}`)
      console.error('[perf] 首次使用请先运行：npm run perf:update（会实测并生成本地门槛，随后提交到仓库供构建复用）\n')
      process.exit(2)
    }
    try {
      baseline = loadBaseline(baselinePath, cases)
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`\n[perf] 门槛不合法，基线流程中止：\n  ${err.message}\n`)
        process.exit(2)
      }
      throw err
    }
    if (baseline.configSignature !== configSignature(config)) {
      console.warn('[perf] 警告：perf.config.json 与生成门槛时的配置不一致，对照结果可能失真；确认变更后请运行 npm run perf:update')
    }
    console.log(`[perf] 门槛文件：${baselinePath}（生成于 ${baseline.generatedAt}，headroom=${baseline.headroom}，` +
      `抖动地板 mean=${baseline.jitterFloorMs}ms/worst=${baseline.worstJitterFloorMs}ms，截尾=${baseline.trimTailFraction * 100}%）`)
  }

  warmupEngine(config)

  const measurements: CaseMeasurement[] = []
  for (const spec of cases) {
    const m = measureCase(config, spec)
    measurements.push(m)
    process.stdout.write(`[perf]   已测量 ${m.caseId} ... mean=${m.meanMs}ms worst=${m.worstMs}ms (rawMax=${m.rawMaxMs}ms)\n`)
  }

  if (UPDATE) {
    const written = writeBaseline(config, measurements)
    console.log(`\n[perf] 已写入新门槛：${baselinePath}`)
    console.log('[perf] 合格线 = max(实测 × headroom(' + config.headroom + '), 实测 + 抖动地板(mean ' +
      config.jitterFloorMs + 'ms / worst ' + config.worstJitterFloorMs + 'ms))，已按截尾 ' +
      config.trimTailFraction * 100 + '% 统计，请检查后提交：')
    for (const e of written.entries) {
      console.log(`  ${pad(e.caseId, 24)} mean<=${e.meanMs}ms  worst<=${e.worstMs}ms`)
    }
    console.log('')
    return
  }

  const byId = new Map(baseline!.entries.map(e => [e.caseId, e]))
  const failures: string[] = []

  console.log('\n[perf] 结果对照（实测 / 门槛 / 差异；均为截尾后统计）')
  console.log('  ' + pad('参数组 caseId', 26) + pad('mean ms', 30) + pad('worst ms', 30) + '判定')
  for (const m of measurements) {
    const e = byId.get(m.caseId)!
    const meanOver = m.meanMs > e.meanMs
    const worstOver = m.worstMs > e.worstMs
    const meanCell = `${m.meanMs} / ${e.meanMs} / ${fmtDelta(m.meanMs, e.meanMs)}`
    const worstCell = `${m.worstMs} / ${e.worstMs} / ${fmtDelta(m.worstMs, e.worstMs)}`
    const ok = !meanOver && !worstOver
    console.log('  ' + pad(m.caseId, 26) + pad(meanCell, 30) + pad(worstCell, 30) + (ok ? 'PASS' : 'FAIL'))
    if (!ok) {
      const reasons: string[] = []
      if (meanOver) reasons.push(`mean ${m.meanMs}ms > 门槛 ${e.meanMs}ms（${fmtDelta(m.meanMs, e.meanMs)}）`)
      if (worstOver) reasons.push(`worst ${m.worstMs}ms > 门槛 ${e.worstMs}ms（${fmtDelta(m.worstMs, e.worstMs)}）`)
      failures.push(`  ✗ ${m.caseId} [zoom档位=${m.zoomTierId}(zoom=${m.zoom}), ${m.layers}]：${reasons.join('；')}`)
    }
  }

  if (failures.length > 0) {
    console.error('\n[perf] 渲染性能回归，以下参数组超过门槛：')
    for (const f of failures) console.error(f)
    console.error(`\n[perf] ${measurements.length - failures.length}/${measurements.length} 组通过。` +
      '如属预期变化（有意修改渲染逻辑），请运行 npm run perf:update 更新门槛并随代码一起提交。\n')
    process.exit(1)
  }

  console.log(`\n[perf] 全部 ${measurements.length} 组参数在门槛之内（${measurements.length}/${measurements.length} PASS）。\n`)
}

main()
