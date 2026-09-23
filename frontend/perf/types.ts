export interface ZoomTier {
  id: string
  zoom: number
}

export interface LayerCombo {
  id: string
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
}

export interface PerfConfig {
  canvas: { width: number; height: number }
  latitude: number
  startTimeMs: number
  timeStepMs: number
  warmupFrames: number
  measureFrames: number
  globalWarmupFrames: number
  /** 统计前丢弃的最高耗时帧比例（[0,0.5)），抗调度/GC 离群帧 */
  trimTailFraction: number
  zoomTiers: ZoomTier[]
  layerCombos: LayerCombo[]
  /** 生成基线时在实测值之上预留的倍数（>1） */
  headroom: number
  /** 门槛绝对抖动地板（毫秒，>=0）：max(实测×headroom, 实测+jitterFloor) */
  jitterFloorMs: number
  /** worst（截尾最差帧）专用的抖动地板 */
  worstJitterFloorMs: number
}

/** 一组显示参数：缩放档位 × 图层开关组合，时间逐帧推进 */
export interface CaseSpec {
  caseId: string
  zoomTierId: string
  comboId: string
  zoom: number
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
}

export interface CaseMeasurement {
  caseId: string
  zoomTierId: string
  comboId: string
  zoom: number
  layers: string
  frames: number
  /** 截尾后每帧平均耗时（毫秒） */
  meanMs: number
  /** 截尾后最差一帧耗时（毫秒） */
  worstMs: number
  /** 未截尾的观测最大值，仅用于日志参考 */
  rawMaxMs: number
}

export interface BaselineEntry {
  caseId: string
  zoomTierId: string
  comboId: string
  layers: string
  zoom: number
  frames: number
  meanMs: number
  worstMs: number
}

export interface BaselineFile {
  schemaVersion: number
  generatedAt: string
  headroom: number
  jitterFloorMs: number
  worstJitterFloorMs: number
  trimTailFraction: number
  configSignature: string
  entries: BaselineEntry[]
}
