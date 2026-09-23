import { readFileSync } from 'node:fs'
import type {
  BaselineEntry, BaselineFile, CaseSpec, LayerCombo, PerfConfig, ZoomTier,
} from './types'

/* ------------------------------------------------------------------ */
/* 基础校验工具：任何一项不合法都明确报原因，绝不静默跳过                  */
/* ------------------------------------------------------------------ */

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(msg)
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${what} 必须是对象，实际得到：${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  return raw as Record<string, unknown>
}

function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${what} 必须是有限数字，实际得到：${JSON.stringify(v)} (${typeof v})`)
  }
  return v
}

function asBoolean(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') {
    fail(`${what} 必须是布尔值，实际得到：${JSON.stringify(v)} (${typeof v})`)
  }
  return v
}

function asPositiveInteger(v: unknown, what: string): number {
  const n = asFiniteNumber(v, what)
  if (!Number.isInteger(n) || n <= 0) fail(`${what} 必须是正整数，实际得到：${n}`)
  return n
}

/* ------------------------------------------------------------------ */
/* 配置加载与校验                                                        */
/* ------------------------------------------------------------------ */

export function loadConfig(path: string): PerfConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    fail(`无法读取/解析参数配置 ${path}：${(err as Error).message}`)
  }

  const root = asObject(raw, 'perf 配置根节点')

  const canvasRaw = asObject(root.canvas, 'config.canvas')
  const width = asPositiveInteger(canvasRaw.width, 'config.canvas.width')
  const height = asPositiveInteger(canvasRaw.height, 'config.canvas.height')

  const latitude = asFiniteNumber(root.latitude, 'config.latitude')
  if (latitude < -90 || latitude > 90) fail(`config.latitude 必须在 [-90, 90]，实际：${latitude}`)

  const startTimeMs = asFiniteNumber(root.startTimeMs, 'config.startTimeMs')
  const timeStepMs = asFiniteNumber(root.timeStepMs, 'config.timeStepMs')
  const warmupFrames = asPositiveInteger(root.warmupFrames, 'config.warmupFrames')
  const measureFrames = asPositiveInteger(root.measureFrames, 'config.measureFrames')
  const globalWarmupFrames = asPositiveInteger(root.globalWarmupFrames, 'config.globalWarmupFrames')
  const trimTailFraction = asFiniteNumber(root.trimTailFraction, 'config.trimTailFraction')
  if (trimTailFraction < 0 || trimTailFraction >= 0.5) {
    fail(`config.trimTailFraction 必须在 [0, 0.5)，实际：${trimTailFraction}`)
  }

  const headroom = asFiniteNumber(root.headroom, 'config.headroom')
  if (headroom <= 1) fail(`config.headroom 必须 > 1（门槛=实测×headroom），实际：${headroom}`)
  const jitterFloorMs = asFiniteNumber(root.jitterFloorMs, 'config.jitterFloorMs')
  if (jitterFloorMs < 0) fail(`config.jitterFloorMs 必须 >= 0，实际：${jitterFloorMs}`)
  const worstJitterFloorMs = asFiniteNumber(root.worstJitterFloorMs, 'config.worstJitterFloorMs')
  if (worstJitterFloorMs < 0) fail(`config.worstJitterFloorMs 必须 >= 0，实际：${worstJitterFloorMs}`)

  if (!Array.isArray(root.zoomTiers) || root.zoomTiers.length === 0) {
    fail('config.zoomTiers 必须是非空数组（需要覆盖低/中/高缩放档位）')
  }
  const zoomTiers: ZoomTier[] = root.zoomTiers.map((t, i) => {
    const o = asObject(t, `zoomTiers[${i}]`)
    if (typeof o.id !== 'string' || !o.id.trim()) fail(`zoomTiers[${i}].id 必须是非空字符串`)
    const zoom = asFiniteNumber(o.zoom, `zoomTiers[${i}](${o.id}).zoom`)
    if (zoom <= 0) fail(`zoomTiers[${i}](${o.id}).zoom 必须 > 0，实际：${zoom}`)
    return { id: o.id, zoom }
  })
  if (new Set(zoomTiers.map(t => t.id)).size !== zoomTiers.length) {
    fail('zoomTiers 中存在重复 id：' + zoomTiers.map(t => t.id).join(', '))
  }

  if (!Array.isArray(root.layerCombos) || root.layerCombos.length === 0) {
    fail('config.layerCombos 必须是非空数组（需要覆盖三个图层开关的组合）')
  }
  const layerCombos: LayerCombo[] = root.layerCombos.map((c, i) => {
    const o = asObject(c, `layerCombos[${i}]`)
    if (typeof o.id !== 'string' || !o.id.trim()) fail(`layerCombos[${i}].id 必须是非空字符串`)
    return {
      id: o.id,
      showLabels: asBoolean(o.showLabels, `layerCombos[${i}](${o.id}).showLabels`),
      showConstLines: asBoolean(o.showConstLines, `layerCombos[${i}](${o.id}).showConstLines`),
      showGrid: asBoolean(o.showGrid, `layerCombos[${i}](${o.id}).showGrid`),
    }
  })
  if (new Set(layerCombos.map(c => c.id)).size !== layerCombos.length) {
    fail('layerCombos 中存在重复 id：' + layerCombos.map(c => c.id).join(', '))
  }

  // 校验确实覆盖了三个开关各自的开/关，而不是只有全关一类的组合
  for (const key of ['showLabels', 'showConstLines', 'showGrid'] as const) {
    const values = new Set(layerCombos.map(c => c[key]))
    if (!values.has(true) || !values.has(false)) {
      fail(`图层组合未覆盖 ${key} 的开与关两种状态（当前仅：${[...values].join('/')}）`)
    }
  }

  return {
    canvas: { width, height },
    latitude,
    startTimeMs,
    timeStepMs,
    warmupFrames,
    measureFrames,
    globalWarmupFrames,
    trimTailFraction,
    zoomTiers,
    layerCombos,
    headroom,
    jitterFloorMs,
    worstJitterFloorMs,
  }
}

/** 稳定签名：配置漂移时与基线中的签名对照并给出告警。 */
export function configSignature(config: PerfConfig): string {
  const { canvas, latitude, startTimeMs, timeStepMs, warmupFrames, measureFrames, globalWarmupFrames, trimTailFraction, zoomTiers, layerCombos } = config
  return JSON.stringify({
    canvas, latitude, startTimeMs, timeStepMs, warmupFrames, measureFrames, globalWarmupFrames, trimTailFraction,
    zoomTiers: zoomTiers.map(t => ({ id: t.id, zoom: t.zoom })),
    layerCombos: layerCombos.map(c => ({
      id: c.id,
      showLabels: c.showLabels,
      showConstLines: c.showConstLines,
      showGrid: c.showGrid,
    })),
  })
}

/* ------------------------------------------------------------------ */
/* 参数矩阵展开                                                          */
/* ------------------------------------------------------------------ */

export function buildCases(config: PerfConfig): CaseSpec[] {
  const cases: CaseSpec[] = []
  for (const tier of config.zoomTiers) {
    for (const combo of config.layerCombos) {
      cases.push({
        caseId: `${tier.id}__${combo.id}`,
        zoomTierId: tier.id,
        comboId: combo.id,
        zoom: tier.zoom,
        showLabels: combo.showLabels,
        showConstLines: combo.showConstLines,
        showGrid: combo.showGrid,
      })
    }
  }
  return cases
}

/* ------------------------------------------------------------------ */
/* 门槛（基线）加载与校验                                                 */
/* ------------------------------------------------------------------ */

export function loadBaseline(path: string, expectedCases: CaseSpec[]): BaselineFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    fail(`无法读取/解析门槛文件 ${path}：${(err as Error).message}`)
  }

  const root = asObject(raw, 'baseline 根节点')
  if (root.schemaVersion !== 1) {
    fail(`baseline.schemaVersion 不支持：${JSON.stringify(root.schemaVersion)}（期望 1）`)
  }
  if (typeof root.generatedAt !== 'string' || !root.generatedAt) {
    fail('baseline.generatedAt 必须是非空字符串')
  }
  const headroom = asFiniteNumber(root.headroom, 'baseline.headroom')
  if (headroom <= 1) fail(`baseline.headroom 必须 > 1，实际：${headroom}`)
  const jitterFloorMs = asFiniteNumber(root.jitterFloorMs, 'baseline.jitterFloorMs')
  if (jitterFloorMs < 0) fail(`baseline.jitterFloorMs 必须 >= 0，实际：${jitterFloorMs}`)
  const worstJitterFloorMs = asFiniteNumber(root.worstJitterFloorMs, 'baseline.worstJitterFloorMs')
  if (worstJitterFloorMs < 0) fail(`baseline.worstJitterFloorMs 必须 >= 0，实际：${worstJitterFloorMs}`)
  const trimTailFraction = asFiniteNumber(root.trimTailFraction, 'baseline.trimTailFraction')
  if (trimTailFraction < 0 || trimTailFraction >= 0.5) {
    fail(`baseline.trimTailFraction 必须在 [0, 0.5)，实际：${trimTailFraction}`)
  }
  if (typeof root.configSignature !== 'string' || !root.configSignature) {
    fail('baseline.configSignature 缺失或不是字符串')
  }
  if (!Array.isArray(root.entries) || root.entries.length === 0) {
    fail('baseline.entries 必须是非空数组')
  }

  const expectedIds = new Set(expectedCases.map(c => c.caseId))
  const seen = new Set<string>()
  const entries: BaselineEntry[] = root.entries.map((e, i) => {
    const o = asObject(e, `baseline.entries[${i}]`)
    if (typeof o.caseId !== 'string' || !o.caseId) fail(`baseline.entries[${i}].caseId 必须是非空字符串`)
    if (seen.has(o.caseId)) fail(`baseline.entries 中 caseId 重复：${o.caseId}`)
    seen.add(o.caseId)
    if (!expectedIds.has(o.caseId)) {
      fail(`baseline.entries[${i}].caseId="${o.caseId}" 在当前参数矩阵中不存在（配置变更后请运行 npm run perf:update）`)
    }
    if (typeof o.zoomTierId !== 'string' || typeof o.comboId !== 'string' || typeof o.layers !== 'string') {
      fail(`baseline.entries[${i}](${o.caseId}) 的 zoomTierId/comboId/layers 必须是字符串`)
    }
    const zoom = asFiniteNumber(o.zoom, `baseline.entries[${i}](${o.caseId}).zoom`)
    if (zoom <= 0) fail(`baseline.entries[${i}](${o.caseId}).zoom 必须 > 0，实际：${zoom}`)
    const frames = asPositiveInteger(o.frames, `baseline.entries[${i}](${o.caseId}).frames`)
    const meanMs = asFiniteNumber(o.meanMs, `baseline.entries[${i}](${o.caseId}).meanMs`)
    const worstMs = asFiniteNumber(o.worstMs, `baseline.entries[${i}](${o.caseId}).worstMs`)
    if (meanMs <= 0 || worstMs <= 0) fail(`baseline.entries[${i}](${o.caseId}) 门槛必须为正数：meanMs=${meanMs}, worstMs=${worstMs}`)
    if (worstMs < meanMs) {
      fail(`baseline.entries[${i}](${o.caseId}) 门槛不合法：worstMs(${worstMs}) 小于 meanMs(${meanMs})`)
    }
    if (frames <= 0) fail(`baseline.entries[${i}](${o.caseId}).frames 必须为正整数`)
    return { caseId: o.caseId, zoomTierId: o.zoomTierId, comboId: o.comboId, layers: o.layers, zoom, frames, meanMs, worstMs }
  })

  for (const c of expectedCases) {
    if (!seen.has(c.caseId)) {
      fail(`门槛缺失参数组 "${c.caseId}"（zoom=${c.zoom}, 图层 labels=${c.showLabels}/lines=${c.showConstLines}/grid=${c.showGrid}）。请运行 npm run perf:update 生成完整门槛`)
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: root.generatedAt,
    headroom,
    jitterFloorMs,
    worstJitterFloorMs,
    trimTailFraction,
    configSignature: root.configSignature,
    entries,
  }
}
