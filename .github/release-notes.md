## [0.9.0]

## 主要更新

### 1. 全面面向 DeepSeek Harness `>= v0.2.2-rc.5`（不保留旧版本兼容）
- **版本与依赖升级**：`engines.dsh`、`peerDependencies` 与 `devDependencies` 全面升级至 `0.2.2-rc.5`，`@deepseek-ai/cordis` 升级至 `>=4.1.0 <5`，`@deepseek-ai/schemastery` 升级至 `>=3.19.0 <4`。
- **修正 `cordis.patch.yml` 适配新版路由与 Preset 架构**：移除硬编码的 `searchProvider: deepseek-official`、宿主平面 `tool-web` 覆盖及与默认值冲突的 `timeoutMs: 60000`，完整保留 `dsh v0.2.2-rc.5` 按 LLM 路由自动选择搜索后端机制，避免向 `minimal` preset 泄漏 `tool-web`。
- **补齐设置页 Provider 元数据**：`MoliFetchProvider` 实现 `WebFetchProvider` 新增的 `title`（`Moli`）与中英文 `description`，在 Web 设置页的 Fetch 选择器中完整展示。
- **客户端类型契约清理**：`src/client/card.tsx` 改用 `@deepseek-ai/dsh-client-ui-plugin-manager/client` 官方 `'plugins.bundle.config'` `SlotMap` 声明，移除手写 `declare module` 补丁；`src/index.ts` 动态工具超时预算支持随配置双向升降。

### 2. 抓取管线延迟大幅优化与关键缺陷修复
- **修复短静态页 / 小型 SPA 25 秒假死（P0）**：`settleDynamicSpa` 新增 `readyState === 'complete'` + 无活跃 spinner + DOM 静默窗口提前收敛，同时修复 `cards >= 5` 误命中加载骨架屏及骨架替换计数回落（如 `170 → 130`）漏检问题：
  - 短静态页抓取延迟：`25,000ms+` → **`365ms`**（**-98.5%**）
  - 小型 SPA 页面延迟：`25,000ms+` → **`1,259ms`**（**-95.0%**）
- **消除高频 `outerHTML.length` 全量 DOM 序列化**：移除滚动等待中每 25ms 触发一次的 `document.documentElement.outerHTML.length` 全量序列化，改为轻量节点/文本计数与 `MutationObserver` 合并节流；小型静态页自动跳过无意义的滚动与截图步骤。
- **Markdown 去噪单遍显式栈 DFS**：`src/markdown.ts` 将原先 13 次全树 `querySelectorAll` / 遍历合并为单遍 `prepareDomTree`，并在进入 `<script>`/`<style>`/`<svg>`/`<nav>`/`<aside>` 及非内容容器 `<header>`/`<footer>` 前直接剪枝。

### 3. CDP 客户端与本地 Moli 守护进程零阻塞优化
- **CDP 管道与 `networkidle` 竞态修复**：`NativeCdpPage.init()` 并行发送 `Page.getFrameTree` 与 3 个 domain `enable`（每页减少 1 次 RTT）；`send()` 支持单命令 `timeoutMs`（不再被硬编码 60s 误杀长超时导航）；修复 `waitForLoadState('networkidle', { timeout: 500 })` 必超时竞态，网络已静默时 0ms 立即返回。
- **本地进程探活缓存与后台非阻塞更新**：`MoliProcessManager.ensure()` 增加 10s 健康状态 TTL 缓存，跳过并发抓取的重复 `/json/version` 探活；`resolveMoliBinary()` 在本地缓存二进制已存在时立即返回并后台异步检查更新，消除 24h TTL 过期时的首次抓取阻塞。

---

## 实测与验证（配合 Moli `v1.1.10`）
- `pnpm typecheck` & `pnpm build` 通过（含客户端纯净性门禁与 tarball 打包校验）
- `vitest` **14 个测试文件、243 项测试全部通过**（6 并发本地页集成测试含守护进程启动仅 **`581ms`**）
- 阿里云百炼模型广场端到端实测（`RUN_ONLINE_BENCHMARK=true` + 连续复测）：**4/4 稳定提取 129/129 模型卡片**（约 `11.0s ~ 12.3s`，含完整 SPA 渲染、9 轮滚动与 1.54MB HTML → 44KB Markdown 去噪）
