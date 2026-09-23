/**
 * Node 环境下的 CanvasRenderingContext2D 替身。
 *
 * 真实浏览器里 Canvas 2D 调用会走光栅化管线，Node 中没有 DOM；
 * 这里用同构的对象接住 renderFrame 的全部调用，基线脚本测量的是
 * 渲染器本身（投影三角运算、路径构建、渐变与标签数量等 JS 开销），
 * 同一台机器、同一组参数下结果可重复，适用于回归对照。
 */

class MockGradient {
  addColorStop(_offset: number, _color: string): void { /* no-op */ }
}

export function createMockContext(): CanvasRenderingContext2D {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    fillRect(): void { /* no-op */ },
    clearRect(): void { /* no-op */ },
    beginPath(): void { /* no-op */ },
    closePath(): void { /* no-op */ },
    moveTo(): void { /* no-op */ },
    lineTo(): void { /* no-op */ },
    arc(): void { /* no-op */ },
    fill(): void { /* no-op */ },
    stroke(): void { /* no-op */ },
    fillText(): void { /* no-op */ },
    strokeText(): void { /* no-op */ },
    save(): void { /* no-op */ },
    restore(): void { /* no-op */ },
    scale(): void { /* no-op */ },
    translate(): void { /* no-op */ },
    rotate(): void { /* no-op */ },
    createRadialGradient(): CanvasGradient {
      return new MockGradient() as unknown as CanvasGradient
    },
    createLinearGradient(): CanvasGradient {
      return new MockGradient() as unknown as CanvasGradient
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}
