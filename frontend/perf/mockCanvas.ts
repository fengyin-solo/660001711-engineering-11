import type { RenderContext, RenderGradient } from '../src/render/skyRender'

/**
 * Node 环境下的 CanvasRenderingContext2D 替身。
 *
 * 不做任何真实像素绘制，只保留与渲染器相同的调用路径和 JS 计算量，
 * 因此基线测量的是 renderFrame 自身在固定参数下的 CPU 耗时，
 * 结果在机器内可重复，不依赖浏览器或原生 canvas 模块。
 */

class MockGradient implements RenderGradient {
  addColorStop(_offset: number, _color: string): void {
    // no-op
  }
}

export interface MockCanvas2D extends RenderContext {
  fillStyle: string | RenderGradient
  strokeStyle: string
  lineWidth: number
  font: string
  callCount: number
}

export function createMockContext(): MockCanvas2D {
  const ctx: MockCanvas2D = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '10px sans-serif',
    callCount: 0,

    fillRect() { ctx.callCount++ },
    beginPath() { ctx.callCount++ },
    arc() { ctx.callCount++ },
    fill() { ctx.callCount++ },
    stroke() { ctx.callCount++ },
    moveTo() { ctx.callCount++ },
    lineTo() { ctx.callCount++ },
    closePath() { ctx.callCount++ },
    fillText() { ctx.callCount++ },
    createRadialGradient() {
      ctx.callCount++
      return new MockGradient()
    },
  }
  return ctx
}
