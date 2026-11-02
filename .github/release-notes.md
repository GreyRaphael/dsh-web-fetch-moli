## [0.8.0]

## 主要更新

### 1. 全面对齐 DeepSeek Harness `dsh-v0.2.1-rc.3+` 平台契约
- **引擎与依赖范围收紧**：`package.json` 将 `engines.dsh` 移至顶层宿主读取路径，明确限定为 `">=0.2.1-rc.3 <0.3.0"`；`peerDependencies`（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`）同步收紧为 `">=0.2.1-rc.3 <0.3.0"`。
- **客户端基线模块解耦**：遵循 DSH `rc.3+` 隐式 `PLATFORM_MODULES` 规范，移除 `dsh.client.external` 中的平台基线包声明；在 `dsh.client.inject` 补齐 `@deepseek-ai/dsh-client-ui-plugin-manager`。
- **构建精简与类型安全**：消除 `createSnapshotStore` 死值导入与 `paths.cordis` 别名，产物直接使用规范 `@deepseek-ai/cordis`。

### 2. 宿主核心稳定性与 DoS 防护
- **修复 patch 覆盖 searchProvider 缺陷（P0）**：在 `cordis.patch.yml` 的 `web` 行显式声明 `searchProvider: deepseek-official`，解决 DSH 全行覆盖机制导致的 `WEB_PROVIDER_AMBIGUOUS`。
- **DOM 深度与节点预算保护（P0）**：在 Readability 评分前执行显式栈 DFS `clampDepth`（深度上限 128）与 12,000 节点预算截断，彻底消除深层/超宽 DOM 导致的同步阻塞 DoS（1024 层 DOM 耗时由 ~45s 降至 ~200ms）。
- **CDP 租约关闭与连接池生命周期保护（P1）**：标签页释放增加 1.5s 超时兜底，防止 CDP 连接挂死；`CdpConnectionPool` 增加终态 `disposed` 守卫，杜绝卸载期连接复活。
- **内容类型扩充**：支持 `application/xml`、`*+json` 与 `*+xml` 等结构化文档放行。

### 3. Cloudflare 人机验证探针与降噪优化
- **双探针一致性与防误报（P1）**：代码块剥离提前至结构标记扫描之前，消除技术文章中引用 Cloudflare 路径导致的误判；补齐 `[name="cf-challenge"]` 选择器，确保三套检测入口结论严格一致。
- **降噪保真度提升**：保留文章容器内的 `<header>`/`<footer>` 结构（标题与作者信息），回退容器按最大文本量选取；状态机保留代码块内部空行；修复包含前导换行的 Data-URI 解析。

### 4. 供应链安全与 Web 设置面板完善
- **二进制 SHA-256 校验**：改用 GitHub Release API `assets[].digest` 进行解包前完整性校验，不可达时发出显式未验证告警。
- **配置项补齐**：Web UI 设置卡片与宿主同步新增 `ignoreCertificateErrors` 开关，词典补齐中英文多语言文案，全面清理历史残留数据。

---

## 验证
- `pnpm typecheck` & `pnpm build` 通过
- `vitest` **237 项测试全绿通过**
- CI 包打包与模块表依赖闭合校验全通过
