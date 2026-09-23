import { STARS, CONSTELLATIONS } from '../data/stars'

/**
 * 框架无关的星图渲染内核。
 * 浏览器中的 StarCanvas 与 Node 下的性能基线 runner 调用同一份代码，
 * 保证基线测量覆盖真实的逐帧渲染逻辑。
 */

/** 渲染一帧所需的全部显示参数 */
export interface RenderView {
  zoom: number
  panX: number
  panY: number
  showLabels: boolean
  showConstLines: boolean
  showGrid: boolean
  viewTime: Date
  latitude: number
}

export interface RenderGradient {
  addColorStop(offset: number, color: string): void
}

/** 只声明 renderFrame 实际使用的 Canvas 2D 接口，浏览器原生 ctx 与 Node mock 都能满足 */
export interface RenderContext {
  fillStyle: string | RenderGradient
  strokeStyle: string
  lineWidth: number
  font: string
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
  stroke(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  fillText(text: string, x: number, y: number): void
  createRadialGradient(
    x0: number, y0: number, r0: number,
    x1: number, y1: number, r1: number
  ): RenderGradient
}

/** 本地恒星时（小时） */
export function computeLocalSiderealTime(d: Date): number {
  const jd = d.getTime() / 86400000 + 2440587.5
  const T = (jd - 2451545.0) / 36525.0
  let lst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + T * T * (0.000387933 - T / 38710000)
  lst = ((lst % 360) + 360) % 360
  return lst / 15 // 转换为小时
}

export interface ProjectOptions {
  viewTime: Date
  latitude: number
  panX: number
  panY: number
}

/** 赤道坐标 (RA/Dec) → 画布像素坐标；地平线下返回 [-999, -999] */
export function projectStarCoords(
  ra: number, dec: number,
  cx: number, cy: number, scale: number,
  opts: ProjectOptions
): [number, number] {
  const lst = computeLocalSiderealTime(opts.viewTime)
  const ha = (lst - ra) * 15 * Math.PI / 180
  const decRad = dec * Math.PI / 180
  const latRad = opts.latitude * Math.PI / 180

  const alt = Math.asin(Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha))
  const az = Math.atan2(-Math.cos(decRad) * Math.sin(ha), Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(ha))

  if (alt < -0.1) return [-999, -999] // 地平线下

  const r = (Math.PI / 2 - alt) * scale * 0.45
  const x = cx + opts.panX + r * Math.sin(az)
  const y = cy + opts.panY - r * Math.cos(az)
  return [x, y]
}

export function starRadiusFor(mag: number, zoom: number): number {
  return Math.max(1, 5 - mag) * zoom
}

export function spectralColorFor(spectral: string): string {
  const colors: Record<string, string> = {
    'O': '#9bb0ff', 'B': '#aabfff', 'A': '#cad7ff',
    'F': '#f8f7ff', 'G': '#fff4ea', 'K': '#ffd2a1', 'M': '#ffcc6f'
  }
  return colors[spectral] || '#ffffff'
}

/** 渲染完整的一帧星空 */
export function renderFrame(ctx: RenderContext, w: number, h: number, view: RenderView): void {
  const cx = w / 2, cy = h / 2
  const scale = Math.min(w, h) * view.zoom
  const project = (ra: number, dec: number): [number, number] =>
    projectStarCoords(ra, dec, cx, cy, scale, view)

  // 背景
  ctx.fillStyle = '#000814'
  ctx.fillRect(0, 0, w, h)

  // 随机背景星（固定种子，保证逐帧可重复）
  const rng = (seed: number) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
  const r = rng(42)
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(255,255,255,${r() * 0.4})`
    ctx.beginPath()
    ctx.arc(r() * w, r() * h, r() * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // 坐标网格
  if (view.showGrid) {
    ctx.strokeStyle = 'rgba(100,100,200,0.15)'
    ctx.lineWidth = 1
    for (let dec = -60; dec <= 60; dec += 30) {
      ctx.beginPath()
      for (let ra = 0; ra <= 24; ra += 0.5) {
        const [x, y] = project(ra, dec)
        if (x < -500) continue
        ra === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    for (let ra = 0; ra < 24; ra += 2) {
      ctx.beginPath()
      for (let dec = -90; dec <= 90; dec += 5) {
        const [x, y] = project(ra, dec)
        if (x < -500) continue
        dec === -90 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // 星座连线
  if (view.showConstLines) {
    ctx.strokeStyle = 'rgba(100,180,255,0.4)'
    ctx.lineWidth = 1.5
    for (const c of CONSTELLATIONS) {
      for (const [i, j] of c.lines) {
        const s1 = STARS[i], s2 = STARS[j]
        const [x1, y1] = project(s1.ra, s1.dec)
        const [x2, y2] = project(s2.ra, s2.dec)
        if (x1 < -500 || x2 < -500) continue
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
    }
  }

  // 恒星
  for (const star of STARS) {
    const [x, y] = project(star.ra, star.dec)
    if (x < -500 || x > w + 500 || y < -500 || y > h + 500) continue
    const radius = starRadiusFor(star.mag, view.zoom)
    const color = spectralColorFor(star.spectral)

    // 光晕
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 3)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
    ctx.fill()

    // 星核
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()

    // 星名
    if (view.showLabels && star.mag < 2.5) {
      ctx.fillStyle = 'rgba(200,200,255,0.7)'
      ctx.font = `${10 * view.zoom}px system-ui`
      ctx.fillText(star.name, x + radius + 4, y + 4)
    }
  }

  // 地平圈
  ctx.strokeStyle = 'rgba(0,200,100,0.3)'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let az = 0; az <= 360; az += 5) {
    const azRad = az * Math.PI / 180
    const rr = (Math.PI / 2) * scale * 0.45
    const x = cx + view.panX + rr * Math.sin(azRad)
    const y = cy + view.panY - rr * Math.cos(azRad)
    az === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.stroke()

  // 星座名称
  if (view.showLabels) {
    ctx.fillStyle = 'rgba(100,180,255,0.8)'
    ctx.font = `bold ${12 * view.zoom}px system-ui`
    for (const c of CONSTELLATIONS) {
      const midStar = STARS[c.stars[0]]
      const [x, y] = project(midStar.ra, midStar.dec)
      if (x < -500) continue
      ctx.fillText(c.nameCn, x - 20, y - 15 * view.zoom)
    }
  }
}
