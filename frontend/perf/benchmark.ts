/**
 * 星图渲染性能基线 runner（构建与本地开发共用）。
 *
 * 用法：
 *   node perf/run.mjs              本地跑一遍：测量、保存结果、打印报告（超门槛只警告）
 *   node perf/run.mjs --check      构建模式：同上，但任一用例超过门槛则以非零码退出
 *
 * 退出码：
 *   0  全部通过（本地模式下即使超门槛也为 0，仅提示）
 *   1  存在用例耗时超过门槛（仅 --check）
 *   2  基线配置非法（参数组合缺失、门槛不合法等）
 */
import { performance } from 'node:perf_hooks'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { renderFrame } from '../src/render/skyRender'
import { createMockContext } from './mockCanvas'

const FRONTEND_DIR = process.env.PERF_ROOT || process.cwd()
const BASELINE_FILE = path.join(FRONTEND_DIR, 'perf', 'perf-baseline.json')
const LOCAL_DIR = path.join(FRONTEND_DIR, '.perf')
const LAST_RESULTS_FILE = path.join(LOCAL_DIR, 'last-results.json')
const LAST_REPORT_FILE = path.join(LOCAL_DIR, 'last-report.txt')

const CHECK_MODE = process.argv.includes('--check')
const MS = (n: number): string => `${n.toFixed(3)}ms`

/** 字符串在终端里的显示宽度（中文全角字符占 2 列），用于表格对齐 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、全角标点、兼容字形等按 2 列计
    w += (cp >= 0x1100 && (
      cp <= 0x115f || (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)
    )) ? 2 : 1
  }
  return w
}

function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

interface ZoomTier { id: string; zoom: number }
interface LayerCombo {
  id: string
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
}
interface BaselineConfig {
  simulation: {
    canvasWidth: number
    canvasHeight: number
    viewTime: string
    latitude: number
    panX: number
    panY: number
  }
  measurement: { warmupFrames: number; frames: number; globalWarmupFrames: number }
  zoomTiers: ZoomTier[]
  layerCombos: LayerCombo[]
  budgets: Record<string, number>
}

interface CaseSpec {
  caseId: string
  zoomId: string
  comboId: string
  zoom: number
  combo: LayerCombo
  budget: number
}

interface CaseResult {
  caseId: string
  zoomId: string
  comboId: string
  zoom: number
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
  frames: number
  meanMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  budgetMs: number
  overByMs: number
  overByPct: number
  prevMeanMs: number | null
  deltaPrevPct: number | null
  pass: boolean
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 加载并严格校验基线配置；任何问题都返回明确原因，绝不静默跳过 */
async function loadConfig(): Promise<{ config: BaselineConfig; cases: CaseSpec[]; globalWarmupFrames: number } | { errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []

  let raw: string
  try {
    raw = await readFile(BASELINE_FILE, 'utf8')
  } catch {
    return { errors: [`找不到基线门槛文件: ${path.relative(FRONTEND_DIR, BASELINE_FILE)}（构建与本地共用同一份门槛，不允许缺失）`], warnings }
  }

  let config: BaselineConfig
  try {
    config = JSON.parse(raw)
  } catch (e) {
    return { errors: [`基线文件不是合法 JSON: ${(e as Error).message}`], warnings }
  }

  // ---- simulation ----
  const sim = (config as Partial<BaselineConfig>).simulation as BaselineConfig['simulation'] | undefined
  if (!sim || typeof sim !== 'object') {
    errors.push('缺少 simulation 配置段')
  } else {
    if (!Number.isInteger(sim.canvasWidth) || sim.canvasWidth <= 0) errors.push('simulation.canvasWidth 必须是正整数')
    if (!Number.isInteger(sim.canvasHeight) || sim.canvasHeight <= 0) errors.push('simulation.canvasHeight 必须是正整数')
    if (!Number.isFinite(sim.latitude) || sim.latitude < -90 || sim.latitude > 90) errors.push('simulation.latitude 必须是 [-90, 90] 之间的数值')
    if (!isFiniteNumber(sim.panX)) errors.push('simulation.panX 必须是数值')
    if (!isFiniteNumber(sim.panY)) errors.push('simulation.panY 必须是数值')
    const t = new Date(sim.viewTime)
    if (!sim.viewTime || isNaN(t.getTime())) errors.push(`simulation.viewTime 不是合法时间: ${JSON.stringify(sim.viewTime)}`)
  }

  // ---- measurement ----
  const meas = (config as Partial<BaselineConfig>).measurement as BaselineConfig['measurement'] | undefined
  if (!meas || typeof meas !== 'object') {
    errors.push('缺少 measurement 配置段')
  } else {
    if (!Number.isInteger(meas.warmupFrames) || meas.warmupFrames < 0) errors.push('measurement.warmupFrames 必须是非负整数')
    if (!Number.isInteger(meas.frames) || meas.frames <= 0) errors.push('measurement.frames 必须是正整数')
    if (meas.globalWarmupFrames !== undefined && (!Number.isInteger(meas.globalWarmupFrames) || meas.globalWarmupFrames < 0)) {
      errors.push('measurement.globalWarmupFrames 必须是非负整数（或省略）')
    }
  }

  const globalWarmupFrames = meas?.globalWarmupFrames ?? 100

  // ---- zoom tiers（要求覆盖低/中/高三档）----
  const tiers = (config as Partial<BaselineConfig>).zoomTiers
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('zoomTiers 必须是非空数组（每种缩放档位各取低、中、高）')
  } else {
    const seenTierIds = new Set<string>()
    for (const tier of tiers) {
      if (!tier || typeof tier.id !== 'string' || !tier.id) { errors.push('存在缺少 id 的 zoomTiers 条目'); continue }
      if (seenTierIds.has(tier.id)) { errors.push(`zoomTiers 中 id 重复: ${tier.id}`); continue }
      seenTierIds.add(tier.id)
      if (!isFiniteNumber(tier.zoom) || tier.zoom < 0.3 || tier.zoom > 3) {
        errors.push(`zoomTiers.${tier.id}.zoom = ${JSON.stringify((tier as ZoomTier).zoom)} 非法，必须在 [0.3, 3] 范围内`)
      }
    }
    for (const need of ['low', 'mid', 'high']) {
      if (!seenTierIds.has(need)) warnings.push(`zoomTiers 未包含约定的 “${need}” 档位，请确认缩放档位覆盖完整`)
    }
  }

  // ---- layer combos（三个图层开关的完整真值表，共 8 种组合）----
  const combos = (config as Partial<BaselineConfig>).layerCombos
  if (!Array.isArray(combos) || combos.length === 0) {
    errors.push('layerCombos 必须是非空数组（应覆盖三个图层开关的全部 8 种组合）')
  } else {
    const seenComboIds = new Set<string>()
    const seenTriples = new Set<string>()
    for (const combo of combos) {
      if (!combo || typeof combo.id !== 'string' || !combo.id) { errors.push('存在缺少 id 的 layerCombos 条目'); continue }
      if (seenComboIds.has(combo.id)) { errors.push(`layerCombos 中 id 重复: ${combo.id}`); continue }
      seenComboIds.add(combo.id)
      const flags = [combo.showLabels, combo.showConstLines, combo.showGrid]
      if (!flags.every(v => typeof v === 'boolean')) {
        errors.push(`layerCombos.${combo.id} 的三个开关必须是布尔值（showLabels/showConstLines/showGrid）`)
        continue
      }
      const key = flags.map(v => v ? '1' : '0').join('')
      if (seenTriples.has(key)) errors.push(`layerCombos.${combo.id} 与另一组开关组合重复（标签=${combo.showLabels}, 连线=${combo.showConstLines}, 网格=${combo.showGrid}）`)
      seenTriples.add(key)
    }
    for (let mask = 0; mask < 8; mask++) {
      const key = `${(mask >> 2) & 1}${(mask >> 1) & 1}${mask & 1}`
      if (!seenTriples.has(key)) {
        const [l, c, g] = key.split('').map(v => v === '1' ? '开' : '关')
        errors.push(`layerCombos 缺少开关组合: 标签${l} / 连线${c} / 网格${g}（三个图层开关的 8 种组合必须全部覆盖，不允许静默跳过）`)
      }
    }
  }

  // ---- budgets（每个参数组合都必须有合法门槛）----
  const budgets = (config as Partial<BaselineConfig>).budgets
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
    errors.push('budgets 必须是 “用例id -> 平均帧耗时门槛(ms)” 的映射对象')
  }

  // 基础结构没通过就无法生成用例矩阵，直接返回
  const tiersOk = Array.isArray(tiers) && tiers.length > 0 && !errors.some(e => e.startsWith('zoomTiers'))
  const combosOk = Array.isArray(combos) && combos.length > 0 && !errors.some(e => e.startsWith('layerCombos'))
  if (errors.length > 0 && !(tiersOk && combosOk && budgets)) {
    return { errors, warnings }
  }

  const cases: CaseSpec[] = []
  const knownCaseIds = new Set<string>()
  for (const tier of tiers as ZoomTier[]) {
    if (!isFiniteNumber(tier.zoom)) continue
    for (const combo of combos as LayerCombo[]) {
      if (typeof combo.showLabels !== 'boolean' || typeof combo.showConstLines !== 'boolean' || typeof combo.showGrid !== 'boolean') continue
      const caseId = `${tier.id}__${combo.id}`
      knownCaseIds.add(caseId)
      const budget = (budgets as Record<string, unknown>)[caseId]
      if (budget === undefined) {
        errors.push(`参数组合 ${caseId}（缩放=${tier.zoom}, 标签=${combo.showLabels}, 连线=${combo.showConstLines}, 网格=${combo.showGrid}）在 budgets 中缺少门槛，该项不会被静默跳过`)
        continue
      }
      if (!isFiniteNumber(budget) || budget <= 0) {
        errors.push(`参数组合 ${caseId} 的门槛不合法: ${JSON.stringify(budget)}，必须是大于 0 的毫秒数`)
        continue
      }
      cases.push({ caseId, zoomId: tier.id, comboId: combo.id, zoom: tier.zoom, combo, budget })
    }
  }

  if (budgets && typeof budgets === 'object' && !Array.isArray(budgets)) {
    for (const id of Object.keys(budgets as Record<string, unknown>)) {
      if (!knownCaseIds.has(id)) warnings.push(`budgets 中的 ${id} 不匹配任何缩放×图层组合，该门槛项不会被使用`)
    }
  }

  if (errors.length > 0) return { errors, warnings }
  return { config, cases, globalWarmupFrames }
}

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

/** 全局预热：轮换全部缩放档与图层组合，把各代码路径先 JIT 编译热，避免首个用例偏慢 */
function globalWarmup(config: BaselineConfig, cases: CaseSpec[], frames: number): void {
  const ctx = createMockContext()
  for (let i = 0; i < frames; i++) {
    const c = cases[i % cases.length]
    renderFrame(ctx, config.simulation.canvasWidth, config.simulation.canvasHeight, {
      zoom: c.zoom,
      panX: config.simulation.panX,
      panY: config.simulation.panY,
      showLabels: c.combo.showLabels,
      showConstLines: c.combo.showConstLines,
      showGrid: c.combo.showGrid,
      viewTime: new Date(config.simulation.viewTime),
      latitude: config.simulation.latitude,
    })
  }
}

function measureOne(c: CaseSpec, config: BaselineConfig): CaseResult {
  const ctx = createMockContext()
  const view = {
    zoom: c.zoom,
    panX: config.simulation.panX,
    panY: config.simulation.panY,
    showLabels: c.combo.showLabels,
    showConstLines: c.combo.showConstLines,
    showGrid: c.combo.showGrid,
    viewTime: new Date(config.simulation.viewTime),
    latitude: config.simulation.latitude,
  }
  const { warmupFrames, frames } = config.measurement

  for (let i = 0; i < warmupFrames; i++) {
    renderFrame(ctx, config.simulation.canvasWidth, config.simulation.canvasHeight, view)
  }
  // 丢弃轮：按与正式测量完全相同的长度先跑一遍（逐帧计时但不保留）。
  // 实测首个完整测量轮会触发 V8 再优化/GC，导致结果系统性偏高，
  // 必须先引爆这一次性抖动，否则每组矩阵里的第一个用例不可比。
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now()
    renderFrame(ctx, config.simulation.canvasWidth, config.simulation.canvasHeight, view)
    void (performance.now() - t0)
  }

  const samples: number[] = new Array(frames)
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now()
    renderFrame(ctx, config.simulation.canvasWidth, config.simulation.canvasHeight, view)
    samples[i] = performance.now() - t0
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    caseId: c.caseId,
    zoomId: c.zoomId,
    comboId: c.comboId,
    zoom: c.zoom,
    showLabels: c.combo.showLabels,
    showConstLines: c.combo.showConstLines,
    showGrid: c.combo.showGrid,
    frames,
    meanMs: mean,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    budgetMs: c.budget,
    overByMs: 0,
    overByPct: 0,
    prevMeanMs: null,
    deltaPrevPct: null,
    pass: true,
  }
}

interface StoredResults {
  configHash: string
  measuredAt: string
  cases: Array<Pick<CaseResult, 'caseId' | 'meanMs' | 'medianMs' | 'p95Ms' | 'minMs' | 'maxMs' | 'frames'>>
}

async function main(): Promise<number> {
  const lines: string[] = []
  const log = (s = ''): void => { console.log(s); lines.push(s) }

  const loaded = await loadConfig()
  if ('errors' in loaded) {
    log('========================================')
    log(' 星图渲染性能基线：配置校验失败')
    log('========================================')
    for (const w of loaded.warnings) log(`  [警告] ${w}`)
    for (const e of loaded.errors) log(`  [错误] ${e}`)
    log('')
    log('已中止基线测量：请补全缺失的参数组合或修正非法门槛后重试（不会静默跳过任何一项）。')
    await mkdir(LOCAL_DIR, { recursive: true })
    await writeFile(LAST_REPORT_FILE, lines.join('\n') + '\n', 'utf8').catch(() => {})
    return 2
  }

  const { config, cases, globalWarmupFrames } = loaded
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12)

  // 读取本地保存的上一次基线数据
  let prevByCase = new Map<string, StoredResults['cases'][number]>()
  let prevMeta: { configHash?: string; measuredAt?: string } = {}
  if (existsSync(LAST_RESULTS_FILE)) {
    try {
      const prev = JSON.parse(await readFile(LAST_RESULTS_FILE, 'utf8')) as StoredResults
      prevMeta = prev
      for (const pc of prev.cases ?? []) prevByCase.set(pc.caseId, pc)
    } catch (e) {
      log(`[警告] 本地基线数据损坏，已忽略上次结果: ${(e as Error).message}`)
    }
  }

  log('========================================')
  log(' 星图渲染性能基线')
  log('========================================')
  const cpu = os.cpus()[0]
  log(`模式:       ${CHECK_MODE ? '构建检查（超门槛将失败）' : '本地开发（超门槛仅提示）'}`)
  log(`机器:       ${os.platform()}/${os.arch()} ${cpu?.model?.trim() ?? 'unknown'} × ${os.cpus().length}`)
  log(`Node:       ${process.version}`)
  log(`时间:       ${new Date().toISOString()}`)
  log(`画布:       ${config.simulation.canvasWidth}×${config.simulation.canvasHeight}`)
  log(`模拟时刻:   ${config.simulation.viewTime}（纬度 ${config.simulation.latitude}°）`)
  log(`每用例帧数: ${config.measurement.frames}（预热 ${config.measurement.warmupFrames}，全局预热 ${globalWarmupFrames}）`)
  log(`用例总数:   ${cases.length}（${config.zoomTiers.length} 缩放档 × ${config.layerCombos.length} 图层组合）`)
  log(`门槛配置:   perf/perf-baseline.json @ ${configHash}`)
  if (prevMeta.measuredAt) {
    const sameCfg = prevMeta.configHash === configHash
    log(`上次数据:   ${prevMeta.measuredAt}${sameCfg ? '' : '（注意：门槛配置自上次后已变更）'}`)
  } else {
    log('上次数据:   无（首次运行，将建立本地基线）')
  }
  log('')

  const results: CaseResult[] = []
  globalWarmup(config, cases, globalWarmupFrames)
  for (const c of cases) {
    const r = measureOne(c, config)
    const prev = prevByCase.get(c.caseId)
    if (prev) {
      r.prevMeanMs = prev.meanMs
      r.deltaPrevPct = ((r.meanMs - prev.meanMs) / prev.meanMs) * 100
    }
    r.overByMs = r.meanMs - r.budgetMs
    r.overByPct = (r.overByMs / r.budgetMs) * 100
    r.pass = r.meanMs <= r.budgetMs
    results.push(r)
  }

  // 报告表格
  const head = ['用例', '缩放', '标签', '连线', '网格', '均值', 'P95', '最大', '门槛', '差值', 'vs上次', '结果']
  const rows = results.map(r => [
    r.caseId,
    `${r.zoom}x`,
    r.showLabels ? '开' : '关',
    r.showConstLines ? '开' : '关',
    r.showGrid ? '开' : '关',
    MS(r.meanMs),
    MS(r.p95Ms),
    MS(r.maxMs),
    MS(r.budgetMs),
    `${r.overByMs >= 0 ? '+' : ''}${MS(r.overByMs)} (${r.overByPct >= 0 ? '+' : ''}${r.overByPct.toFixed(1)}%)`,
    r.deltaPrevPct === null ? '—' : `${r.deltaPrevPct >= 0 ? '+' : ''}${r.deltaPrevPct.toFixed(1)}%`,
    r.pass ? 'PASS' : 'FAIL',
  ])
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map(row => displayWidth(row[i]))))
  const fmtRow = (row: string[]): string => row.map((v, i) => padDisplay(v, widths[i])).join('  ').trimEnd()
  log(fmtRow(head))
  log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of rows) log(fmtRow(row))
  log('')

  const failures = results.filter(r => !r.pass)
  if (failures.length > 0) {
    log(`超门槛用例 ${failures.length} 个：`)
    for (const r of failures) {
      log(`  ✗ ${r.caseId}`)
      log(`      缩放=${r.zoom}x, 标签=${r.showLabels ? '开' : '关'}, 连线=${r.showConstLines ? '开' : '关'}, 网格=${r.showGrid ? '开' : '关'}`)
      log(`      平均 ${MS(r.meanMs)} / 门槛 ${MS(r.budgetMs)}，超出 ${MS(r.overByMs)}（+${r.overByPct.toFixed(1)}%），P95 ${MS(r.p95Ms)}，最大 ${MS(r.maxMs)}`)
      if (r.deltaPrevPct !== null) log(`      与上一次本地结果相比: ${r.deltaPrevPct >= 0 ? '+' : ''}${r.deltaPrevPct.toFixed(1)}%`)
      const suggested = Math.ceil(r.meanMs * 1.5 * 100) / 100
      log(`      如需按当前机器重新定档，可将 budgets.${r.caseId} 调整为不低于 ${suggested}（需人工确认后提交）`)
    }
    log('')
  } else {
    log(`全部 ${results.length} 组参数的平均帧耗时均在门槛之内。`)
    log('')
  }

  const totalMean = results.reduce((a, r) => a + r.meanMs, 0) / results.length
  log(`汇总: ${results.length - failures.length}/${results.length} 通过，全体平均 ${MS(totalMean)}，最慢 ${MS(Math.max(...results.map(r => r.meanMs)))}`)
  log(CHECK_MODE
    ? (failures.length > 0 ? '构建判定: 失败（渲染性能基线未达标）' : '构建判定: 通过')
    : '本地测量已完成，结果已保存供下次对照')

  // 基线数据本地保存，供下次复用
  await mkdir(LOCAL_DIR, { recursive: true })
  const stored: StoredResults = {
    configHash,
    measuredAt: new Date().toISOString(),
    cases: results.map(r => ({
      caseId: r.caseId,
      meanMs: r.meanMs,
      medianMs: r.medianMs,
      p95Ms: r.p95Ms,
      minMs: r.minMs,
      maxMs: r.maxMs,
      frames: r.frames,
    })),
  }
  await writeFile(LAST_RESULTS_FILE, JSON.stringify(stored, null, 2) + '\n', 'utf8')
  await writeFile(LAST_REPORT_FILE, lines.join('\n') + '\n', 'utf8')
  log(`\n结果已保存: ${path.relative(FRONTEND_DIR, LAST_RESULTS_FILE)} / ${path.relative(FRONTEND_DIR, LAST_REPORT_FILE)}`)

  return CHECK_MODE && failures.length > 0 ? 1 : 0
}

main().then(code => process.exit(code)).catch(e => {
  console.error('[perf] 基线运行异常:', e)
  process.exit(2)
})
