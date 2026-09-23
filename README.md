# solo-6600017: 天文星图交互式渲染器

## 技术栈
- Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS
- Canvas 2D 天文投影渲染

## 核心特性
1. **赤道坐标投影**：RA/Dec → 地平坐标 (Alt/Az) 实时转换
2. **88 星座渲染**：6 个典型星座（猎户/大熊/仙后/天蝎/天鹅/狮子）+ 连线 + 名称
3. **时间旅行**：通过日期时间选择器查看任意时刻的星空
4. **天体搜索**：输入星名定位，点击星体显示详细信息
5. **光谱色彩**：O/B/A/F/G/K/M 七种光谱类型对应不同颜色
6. **交互控制**：缩放、纬度调节、星名/连线/网格显示开关

## 启动
```bash
cd frontend && npm install && npm run dev
```

## 渲染性能基线
固定 3 个缩放档（低/中/高）× 3 个图层开关的 8 种组合共 24 组参数跑渲染，逐帧计时并与门槛对照：
```bash
cd frontend
npm run perf        # 本地测量，结果保存在 .perf/ 供下次对照
npm run perf:check  # 构建用，超门槛即失败；已串联进 npm run build
```
详见 [frontend/perf/README.md](frontend/perf/README.md)。
