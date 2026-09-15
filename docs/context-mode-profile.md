# shareBrowserContext (Profile 模式) 架构与实现指引

> 状态：**已实现并在生产运行（插件 v0.3.2+）**。
> 本文档说明 `dsh-web-fetch-moli` 中 CDP 原生连接池、浏览器上下文作用域（`isolated` vs `profile`）及持久登录态复用的架构设计与实现机制。

---

## 1. 背景与动机

### 1.1 隔离模式（`isolated`）的生命周期

在默认隔离模式（`shareBrowserContext: false`）下，每次抓取的生命周期为：

```
CdpConnectionPool.acquire(endpoint, timeout, 'isolated')
  └─ browser.newContext()          ← CDP: Target.createBrowserContext
       └─ context.newPage()        ← CDP: Target.createTarget
            └─ 页面导航与渲染
  └─ release()
       ├─ page.close()             ← CDP: Target.closeTarget
       └─ context.close()          ← CDP: Target.disposeBrowserContext (销毁 Cookie / Storage)
```

`Target.createBrowserContext` 在 Chrome DevTools Protocol 规范中是完全独立的隐身沙箱，**不会**与浏览器默认的 Profile 共享 Cookie 与本地存储。因此：
* 远端真实浏览器中已登录的站点会话（如需要账号权限的控制台、内网系统）在隔离模式下不可见；
* 抓取会直接遇到登录墙或匿名重定向。

### 1.2 Profile 模式（`shareBrowserContext: true`，默认启用）

为了让模型能够借助用户远端浏览器已有的登录会话直接抓取授权页面，插件引入了 **Profile 共享模式**：

1. **复用持久登录态**：直接使用远端浏览器启动参数（`--remote-debugging-port`，带 `--user-data-dir`）中已有的 Cookie、LocalStorage 和 Session；
2. **Tab 级生命周期**：每次 fetch 仅在远端浏览器的**默认 Context** 中新建一个 Tab（Page）：打开 → 导航 → 提取内容 → 自动关闭 Tab；
3. **安全与隔离性**：
   * 各 fetch 任务在各自独立的 Page/Tab 中执行，DOM、JS 执行栈与导航互不干扰；
   * 抓取结束时**严禁关闭默认 Context**（关闭默认 Context 会直接切断整个浏览器乃至其他已开标签页），仅关闭所租借的 Tab。

---

## 2. 基于原生 CDP 客户端（NativeCdpClient）的实现原理

本项目完全移除了重型第三方依赖（如 `playwright-core`），基于 Node.js 原生 `WebSocket` 和 `fetch` 在 [`src/cdp-client.ts`](../src/cdp-client.ts) 中实现了轻量级 CDP 客户端。

### 2.1 默认上下文的挂载与识别

当客户端通过 WebSocket 连接到远端 CDP 端点时，`NativeCdpBrowser` 在初始化阶段便会构造一个单例的默认上下文：

```ts
export class NativeCdpBrowser implements CdpBrowser {
  private readonly defaultCtx: NativeCdpContext

  constructor(private readonly wsUrl: string, public readonly endpoint: string) {
    // browserContextId 为 undefined 即代表远端浏览器的默认 profile 上下文
    this.defaultCtx = new NativeCdpContext(this, undefined)
  }

  contexts(): CdpContext[] {
    return [this.defaultCtx, ...this.customContexts]
  }
}
```

* 协议约定：在 CDP 中，`Target.createTarget` 时若不传递 `browserContextId`，或者传递 `undefined`，Chrome 就会在默认 Profile（即用户登录态所在的 Context）中创建新目标；
* 索引确定性：`browser.contexts()[0]` 恒定指向该默认 Context，无需启发式查找。

### 2.2 连接池与租借管理（CdpConnectionPool）

在 [`src/cdp-pool.ts`](../src/cdp-pool.ts) 中，通过 `CdpLease` 统一管理生命周期：

```ts
export interface CdpLease {
  browser: CdpBrowser
  context: CdpContext
  page: CdpPage
  persistent: boolean // 为 true 时代表 profile 模式，release 时绝不调用 context.close()
}

// 申请租借
private async openLease(browser: CdpBrowser, mode: CdpAcquireMode): Promise<CdpLease> {
  if (mode === 'profile') {
    const context = browser.contexts?.()[0]
    if (!context) {
      throw new Error('the CDP endpoint exposed no default browser context')
    }
    return { browser, context, page: await context.newPage(), persistent: true }
  }
  const context = await browser.newContext()
  return { browser, context, page: await context.newPage(), persistent: false }
}

// 释放租借
async release(lease: CdpLease): Promise<void> {
  await lease.page.close().catch(() => {})
  if (!lease.persistent) {
    await lease.context.close().catch(() => {})
  }
}
```

### 2.3 弹窗防御（Popup Guard）

部分被抓取页面在加载时可能通过 `window.open` 产生弹窗。在 Profile 模式下，这些孤儿 Tab 会滞留在用户的日常浏览器中。
[`src/provider.ts`](../src/provider.ts) 在页面初始化时统一注册弹窗防御守卫：
```ts
function guardPopups(page: CdpPage): void {
  try {
    page.on?.('popup', popup => { void popup.close().catch(() => {}) })
  } catch {}
}
```
确保任何页面自行弹出的附属窗口在创建瞬间立即被关闭，杜绝标签页泄露。

---

## 3. 配置与使用

在 DeepSeek Harness 设置面板（设置 → 插件 → 插件配置 → *Moli 网页爬取*）中：
* **共享浏览器上下文（复用登录态）** (`shareBrowserContext`)：
  * **勾选（默认）**：启用 Profile 模式，复用已登录 Cookie；
  * **取消勾选**：启用 Isolated 模式，每次抓取全新沙箱，互不影响。
