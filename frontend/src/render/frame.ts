import { STARS, CONSTELLATIONS } from '../data/stars'

/**
 * 一帧渲染所需的全部显示参数。
 * 组件（实时渲染）与性能基线脚本（可重复测量）共用这一份定义，
 * 保证被测量的代码路径与线上渲染完全一致。
 */
export interface FrameParams {
  width: number
  height: number
  /** 该帧对应的时刻（epoch 毫秒），逐帧推进即可模拟时间旅行 */
  timeMs: number
  zoom: number
  latitude: number
  panX: number
  panY: number
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
}

export interface ProjectOptions {
  ra: number
  dec: number
  cx: number
  cy: number
  scale: number
  timeMs: number
  latitude: number
  panX: number
  panY: number
}

/** 由 epoch 毫秒计算本地恒星时（小时）。 */
export function localSiderealTimeMs(timeMs: number): number {
  const jd = timeMs / 86400000 + 2440587.5
  const T = (jd - 2451545.0) / 36525.0
  let lst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + T * T * (0.000387933 - T / 38710000)
  lst = ((lst % 360) + 360) % 360
  return lst / 15 // convert to hours
}

/** 赤道坐标（RA/Dec）-> 画布坐标，纯函数。地平以下返回 [-999, -999]。 */
export function projectStar(o: ProjectOptions): [number, number] {
  const ha = (localSiderealTimeMs(o.timeMs) - o.ra) * 15 * Math.PI / 180
  const decRad = o.dec * Math.PI / 180
  const latRad = o.latitude * Math.PI / 180

  const alt = Math.asin(Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha))
  const az = Math.atan2(-Math.cos(decRad) * Math.sin(ha), Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(ha))

  if (alt < -0.1) return [-999, -999] // below horizon

  const r = (Math.PI / 2 - alt) * o.scale * 0.45
  const x = o.cx + o.panX + r * Math.sin(az)
  const y = o.cy + o.panY - r * Math.cos(az)
  return [x, y]
}

export function starRadius(mag: number, zoom: number): number {
  return Math.max(1, 5 - mag) * zoom
}

export function spectralColor(spectral: string): string {
  const colors: Record<string, string> = {
    O: '#9bb0ff', B: '#aabfff', A: '#cad7ff',
    F: '#f8f7ff', G: '#fff4ea', K: '#ffd2a1', M: '#ffcc6f',
  }
  return colors[spectral] || '#ffffff'
}

type DrawContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font'
  | 'fillRect' | 'beginPath' | 'closePath' | 'moveTo' | 'lineTo'
  | 'arc' | 'fill' | 'stroke' | 'fillText' | 'createRadialGradient'
>

/**
 * 渲染单帧。逻辑与 StarCanvas 的 rAF 循环逐行对应，
 * 不依赖任何 DOM/Vue 状态，便于在 Node 下做可重复的性能测量。
 */
export function renderFrame(ctx: DrawContext, p: FrameParams): void {
  const w = p.width
  const h = p.height
  const cx = w / 2
  const cy = h / 2
  const scale = Math.min(w, h) * p.zoom

  const proj = (ra: number, dec: number): [number, number] =>
    projectStar({ ra, dec, cx, cy, scale, timeMs: p.timeMs, latitude: p.latitude, panX: p.panX, panY: p.panY })

  // background
  ctx.fillStyle = '#000814'
  ctx.fillRect(0, 0, w, h)

  // random background stars
  const rng = (seed: number) => {
    let s = seed
    return () => {
      s = (s * 16807) % 2147483647
      return s / 2147483647
    }
  }
  const r = rng(42)
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(255,255,255,${r() * 0.4})`
    ctx.beginPath()
    ctx.arc(r() * w, r() * h, r() * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // grid
  if (p.showGrid) {
    ctx.strokeStyle = 'rgba(100,100,200,0.15)'
    ctx.lineWidth = 1
    for (let dec = -60; dec <= 60; dec += 30) {
      ctx.beginPath()
      for (let ra = 0; ra <= 24; ra += 0.5) {
        const [x, y] = proj(ra, dec)
        if (x < -500) continue
        ra === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    for (let ra = 0; ra < 24; ra += 2) {
      ctx.beginPath()
      for (let dec = -90; dec <= 90; dec += 5) {
        const [x, y] = proj(ra, dec)
        if (x < -500) continue
        dec === -90 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // constellation lines
  if (p.showConstLines) {
    ctx.strokeStyle = 'rgba(100,180,255,0.4)'
    ctx.lineWidth = 1.5
    for (const c of CONSTELLATIONS) {
      for (const [i, j] of c.lines) {
        const s1 = STARS[i]
        const s2 = STARS[j]
        const [x1, y1] = proj(s1.ra, s1.dec)
        const [x2, y2] = proj(s2.ra, s2.dec)
        if (x1 < -500 || x2 < -500) continue
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
    }
  }

  // stars
  for (const star of STARS) {
    const [x, y] = proj(star.ra, star.dec)
    if (x < -500 || x > w + 500 || y < -500 || y > h + 500) continue
    const radius = starRadius(star.mag, p.zoom)
    const color = spectralColor(star.spectral)

    // glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 3)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
    ctx.fill()

    // core
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()

    // label
    if (p.showLabels && star.mag < 2.5) {
      ctx.fillStyle = 'rgba(200,200,255,0.7)'
      ctx.font = `${10 * p.zoom}px system-ui`
      ctx.fillText(star.name, x + radius + 4, y + 4)
    }
  }

  // horizon
  ctx.strokeStyle = 'rgba(0,200,100,0.3)'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let az = 0; az <= 360; az += 5) {
    const azRad = (az * Math.PI) / 180
    const rr = (Math.PI / 2) * scale * 0.45
    const x = cx + p.panX + rr * Math.sin(azRad)
    const y = cy + p.panY - rr * Math.cos(azRad)
    az === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.stroke()

  // constellation labels
  if (p.showLabels) {
    ctx.fillStyle = 'rgba(100,180,255,0.8)'
    ctx.font = `bold ${12 * p.zoom}px system-ui`
    for (const c of CONSTELLATIONS) {
      const midStar = STARS[c.stars[0]]
      const [x, y] = proj(midStar.ra, midStar.dec)
      if (x < -500) continue
      ctx.fillText(c.nameCn, x - 20, y - 15 * p.zoom)
    }
  }
}
