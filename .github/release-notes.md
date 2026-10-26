## 主要更新

### 1. 修复设置卡片在 DSH 0.1.7+ 完全消失

这是本次最重要的修复。症状是「DSH 更新后，插件配置项不见了」——而 `web_fetch` 抓取本身仍然工作，所以很容易误判为界面问题。

根因：DSH 在 `0.1.7-alpha.1`（`601d6761e4` / PR #4587）用 `SettingsForms` 整体替换了 `SettingsProvider`，删除了 `ctx.settings.installSection` / `register` / `settingsNamespace` 整套 API。旧代码调用抛出的是被 cordis 捕获、**只写进启动日志**的 `TypeError`，插件主体照常注册，于是设置卡静默消失。

迁移到新契约的关键点：`Config` 的每个字段必须声明 `.volatile()`。设置域用 `volatileForm(schema)` 过滤条目，**没有任何 volatile 字段的 schema 会被整条跳过、连表单都不产生**。同时 volatile 也是热更新的机制——保存后 Loader 原地替换引用并发出 `loader/volatile-update`，不重挂插件。

新增 `dsh.engines.dsh: ">=0.1.7-alpha.1"`，版本不满足时在安装/激活阶段就明确报错，而不是运行时静默失效。

### 2. 客户端删除 935 行手工转写层

`form.ts`(396) / `fields.tsx`(195) / `PluginCard.tsx`(71) 及两份 CSS(317) 原本是官方 `SettingsFormModel` + `ui-primitives` 的手工副本，文件头写的理由是 "external client bundles cannot value-import `@deepseek-ai/*` packages"。

该限制来自插件自己的 purity gate，而 rc.3 的浏览器壳层已把 `dsh-client-store` 与 `dsh-client-ui-primitives` 种入冻结模块表，前提不再成立。改用平台组件后 `lib/client.js` 从 36.4KB 降至 21.9KB（**−39%**），只剩三个 require，全部命中模块表。

插件自己只保留两处平台未覆盖的形状：backend 单选组（两个选项要联动禁用其它字段）、复选框旁的「已覆盖 + 恢复默认」徽章。

### 3. 依赖与工具链

- 声明项 29 → 23，删除 `dsh-settings`、`@types/mozilla__readability`（readability 自带类型）、`react-dom` 及两个空挂的 devDependencies
- 工具链升级：TypeScript `^5.8` → `^6.0.3`、tsdown `^0.22` → `^0.23.2`、vitest `^4.1` → `^5.0.5`
- 删除 `pnpm-workspace.yaml` 中锁在 0.1.2 世代的 `overrides`，它们让依赖树里同时存在两份 schemastery 并触发 `TS2742`

### 4. 修复 CI 中的脆弱网络测试

`tests/moli-resolve.spec.ts` 有一个真实访问 GitHub API 的用例，却沿用 vitest 默认的 5s 超时，本机实测 6 次有 4 次失败（`fetch failed after 5036ms`）。已为其设置 30s 预算，连跑 5 次全绿。

## 三项有意不升级的依赖

| 包 | latest | 保持 | 原因 |
| --- | --- | --- | --- |
| `react` | 19.3.1 | **18.x** | 宿主 `apps/web` 用 `^18.2.0`，模块表分发的也是 18.3.1。升 19 会并存两份 React，拆散 hook 与 element identity |
| `@mdream/js` | 2.0.3 | **1.x** | 2.x 丢弃 `data:` URI 图片源，插件的 base64 占位符失效，图片退化成 `![]()`，丢失 MIME 与尺寸线索（实测：1.7.2 → `![shot](data:image/png;base64,...3.0KB)`，2.0.3 → `![shot]()`） |
| `@types/node` | 26.x | **24.x** | 与 Node 运行时主版本对齐，跨大版本会引入无关类型噪声 |

## 兼容性

- **要求 DSH `>=0.1.7-alpha.1`**，不再支持更早版本（那套设置 API 已被上游删除，无法同时兼容）
- Node `>=22`
- 本版本在 DSH `0.2.1-rc.3` 上完整验证

## 验证

`tsc --noEmit` 通过 · `vitest` **171 passed / 13 files** · `pnpm run build` 成功 · 真实 Loader 端到端确认 fiber ACTIVE、字段为 volatile 引用、配置编辑在下一次抓取生效且不重挂插件、设置域会为该条目投放表单。

**完整变更见 [CHANGELOG.md](https://github.com/GreyRaphael/dsh-web-fetch-moli/blob/main/CHANGELOG.md)。**
