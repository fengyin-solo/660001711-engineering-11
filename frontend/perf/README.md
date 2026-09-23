# 星图渲染性能基线

固定一组显示参数跑渲染，逐帧统计耗时并与门槛对照，用于发现“缩放 / 时间推进 / 图层开关一换，单帧耗时从几毫秒跳到几十毫秒”的回归。**构建流程与本地开发共用同一份门槛**（`perf-baseline.json`，入库），测量结果只保存在本地（`.perf/`，已 gitignore）。

## 使用

```bash
npm run perf         # 本地开发：跑一遍，打印耗时/门槛/与上次的差异，结果保存到 .perf/
npm run perf:check   # 构建检查：与上者完全相同，但任一用例超门槛则退出码 1
npm run build        # 已串联 perf:check，基线不过则构建失败
```

不需要浏览器或原生 canvas 模块：Node 下用 `mockCanvas.ts` 的 2D context 替身执行
`src/render/skyRender.ts` 里的同一份 `renderFrame`，测量的是渲染器自身在固定参数下的
CPU 耗时，机器内可重复。源码用 sucrase（纯 JS，无平台二进制）即时转译后执行。

## 参数矩阵

- 缩放：低（0.5x）/ 中（1.0x）/ 高（2.5x）三档
- 图层：`showLabels` / `showConstLines` / `showGrid` 三个开关的全部 8 种组合
- 时间与地点固定（`simulation.viewTime` / `latitude`），保证矩阵逐次可比
- 共 3 × 8 = **24 个用例**，每用例预热 30 帧 + 丢弃 1 个完整测量轮（引爆 V8 再优化/GC 的一次性抖动）后计时 200 帧

## 门槛与判定

- `budgets` 以 `"<缩放档id>__<图层组合id>"` 为键，单位毫秒，对照的是平均帧耗时；报告同时给出 P95 / 最大值。
- 超门槛时报告会指出**具体是哪一组参数**（缩放档位 + 三个开关状态）、超出多少 ms / 百分之多少，并给出重新定档的建议值。
- 本地数据 `.perf/last-results.json` 每次运行覆盖保存，下次自动对照并打印 `vs上次` 差异列；门槛配置变更会在报告中提示。

退出码：`0` 通过（本地模式即使超门槛也为 0，仅提示）；`1` 有用例超门槛（仅 `--check`）；`2` 基线配置非法。

## 修改矩阵或门槛

改 `perf-baseline.json`：新增/删除缩放档或图层组合时**必须**同步补齐对应的 `budgets`，
runner 对以下情况会打印明确原因并以退出码 2 中止，不会静默跳过任何一项：

- 图层开关的 8 种组合没有全部覆盖（缺失的具体组合会被列出来）
- 某个参数组合在 `budgets` 中缺少门槛
- 门槛不是大于 0 的数值、缩放超出 [0.3, 3]、画布尺寸非法、时间无法解析等

因换机器等原因需要重新定档：先 `npm run perf` 看实测值，人工确认后按报告里的建议值
修改 `budgets` 并提交（门槛文件是构建与本地共用的唯一来源，不支持偷偷放宽）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `perf-baseline.json` | 参数矩阵 + 门槛（入库，构建与本地共用） |
| `benchmark.ts` | runner：校验、测量、对照、报告 |
| `mockCanvas.ts` | Node 下的 Canvas 2D 替身 |
| `run.mjs` | 入口：sucrase 转译 TS 后在 Node 执行 |
| `../src/render/skyRender.ts` | 框架无关的渲染内核，浏览器与基线共用 |
| `.perf/last-results.json` | 本地上次测量数据（gitignore，供下次对照） |
| `.perf/last-report.txt` | 本地上次完整报告（gitignore） |
