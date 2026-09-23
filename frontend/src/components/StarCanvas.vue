<template>
  <canvas ref="canvasRef" class="w-full h-full bg-black cursor-crosshair"
    @click="onClick" @wheel.prevent="onWheel" />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSkyStore } from '../store/sky'
import { renderFrame } from '../render/frame'

const store = useSkyStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
let animId = 0

function draw() {
  const canvas = canvasRef.value
  if (!canvas) { animId = requestAnimationFrame(draw); return }
  const ctx = canvas.getContext('2d')!
  canvas.width = canvas.offsetWidth * 2
  canvas.height = canvas.offsetHeight * 2

  renderFrame(ctx, {
    width: canvas.width,
    height: canvas.height,
    timeMs: store.viewDate.getTime(),
    zoom: store.zoom,
    latitude: store.latitude,
    panX: store.panX,
    panY: store.panY,
    showLabels: store.showLabels,
    showConstLines: store.showConstLines,
    showGrid: store.showGrid,
  })

  animId = requestAnimationFrame(draw)
}

function onClick(e: MouseEvent) {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) * 2
  const y = (e.clientY - rect.top) * 2
  const cx = canvas.width / 2, cy = canvas.height / 2
  const scale = Math.min(canvas.width, canvas.height) * store.zoom
  store.selectStar(x, y, cx, cy, scale)
}

function onWheel(e: WheelEvent) {
  store.zoom = Math.max(0.3, Math.min(3, store.zoom + (e.deltaY > 0 ? -0.1 : 0.1)))
}

onMounted(() => draw())
onUnmounted(() => cancelAnimationFrame(animId))
</script>
