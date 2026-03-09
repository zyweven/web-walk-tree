## 文档目的
梳理并固化“浏览路径树记录器”Chrome 扩展的目标、约束、架构、数据模型、可视化与实现里程碑，作为后续实现与验收依据。

## 用户偏好与约束
1. 展示布局：径向（辐射状）树为主展示。
2. 激活方式：手动激活或浏览器启动即激活，支持随时暂停。
3. 树根规则：无来源页面即为树根；同一会话/一天内可能存在多个树根。
4. 会话定义：浏览器打开到关闭视为一次记录；过去历史可查看。
5. 导出格式：先仅支持 JSON。
6. 隐私：数据只保存在本机，不上传；支持域名黑名单。

## 总体架构（Manifest V3）
- 背景服务 worker：监听导航与标签事件、构建节点与边、维护会话与存储。
- 内容脚本：捕获页面内链接点击意图（`href/anchorText/domPath`），辅助关联后续导航。
- 侧边面板（主 UI）：径向树、面包屑、搜索过滤、树根切换、节点备注。
- 弹窗（辅 UI）：快速总览与控制（开启/暂停、新会话、最近树根）。
- 选项页：历史会话管理、导出设置、黑名单与偏好。

## 会话与树根规则
- 会话开启：浏览器启动（`onStartup`）自动开启新会话；用户可在弹窗手动开启。
- 会话结束：最后一个窗口关闭（`windows.onRemoved` + `getAll==0`）或空闲阈值触发（如 30 分钟）。
- 树根判定：
  - 无点击意图且 `transitionType=typed/keyword/generated`、或无法与前一页面关联 → 新建树根。
  - 同一会话允许多个树根；侧边面板提供树根列表与切换。

## 路径构建与关联策略
- 事件源：
  - `webNavigation.onCommitted/onBeforeNavigate` 识别导航与重定向。
  - `webNavigation.onCreatedNavigationTarget` 关联“在新标签打开”的父子关系。
  - `tabs.onActivated` 辅助识别当前活跃页面；可用于面包屑更新。
  - 内容脚本监听 `click/auxclick/contextmenu` 于 `<a>`，预记录意图并携带 `tabId/frameId`。
- 边类型：`click/typed/keyword/redirect/back/forward`；新标签标记 `openInNewTab=true`。
- 关联优先级：
  1) 点击意图（同 `tabId/frameId`）→ 后续 `onCommitted`；
  2) 新标签事件 `onCreatedNavigationTarget` 的 `sourceTabId/frameId`；
  3) 无来源则树根或会话根；
  4) 返回/前进由 `transitionQualifiers=forward_back` 识别并避免重复边。
- 重定向：合并为一条逻辑边（保留链路详情在边属性）。
- 去重与规范化：可选去除片段/指定查询参数；同源短时重复跳转抑制。

## 数据模型
- Node：
  - `id`、`url`、`title`、`faviconUrl`、`firstSeenAt`、`lastSeenAt`、`visitCount`、`sessionId`、`isRoot`
- Edge：
  - `id`、`fromNodeId`、`toNodeId`、`type`（`click|typed|keyword|redirect|back|forward`）、`createdAt`、`anchorText`、`domPath`、`openInNewTab`、`confidence`
- Session：
  - `id`、`date`、`startedAt`、`endedAt`、`rootNodeIds[]`、`notes`、`isPaused`
- 结构：内部存储为 DAG（允许多父）；UI 以树视图展开，重复节点以引用显示，避免视觉重复。

## 存储与导出
- 存储：默认使用 `chrome.storage.local`，按会话分块；规模扩大时切换 IndexedDB（为节点/边建立 `sessionId/domain` 索引）。
- 导出 JSON：
  - 会话导出：`{ session, nodes: Node[], edges: Edge[] }`
  - 单树根导出：同上但限定在某树根及其可到达子图。
  - 示例：
```
{
  "session": {"id":"2025-11-15-1","startedAt":1234567890,"endedAt":1234569999},
  "nodes": [
    {"id":"n1","url":"https://example.com","title":"Home","faviconUrl":"...","firstSeenAt":1234567890,"lastSeenAt":1234567890,"visitCount":1,"sessionId":"2025-11-15-1","isRoot":true}
  ],
  "edges": [
    {"id":"e1","fromNodeId":"n1","toNodeId":"n2","type":"click","createdAt":1234567900,"anchorText":"Blog","domPath":"#nav>a:nth-child(2)","openInNewTab":false,"confidence":0.95}
  ]
}
```

## 可视化设计（径向树）
- 径向布局：树根居中，层级向外扩展；边颜色与线型区分类型。
- 节点徽标：显示 `favicon/title/domain`；悬停显示锚文本与时间。
- 面包屑：显示当前标签到树根的路径，支持一键回跳祖先。
- 大图性能：虚拟化渲染（按扇区懒加载）、重复域聚合与折叠。

## 权限与 API
- 必需：`webNavigation`、`tabs`、`storage`、`sidePanel`、`activeTab`、`scripting`
- 可选：`history`（补全标题与时间）；`favicon` 或页面内解析 `<link rel="icon">`
- SPA 支持：内容脚本监听 `pushState/replaceState/popstate`，将路由跳转作为边记录。

## 隐私与控制
- 全本地存储，默认不采集页面内容，仅记录 URL/标题/时间/锚文本。
- 黑名单：按域名或规则禁用记录；匿名模式单独许可。
- 数据清理：按会话或时间范围清理；导出前提示体积与范围。

## 里程碑与验收
1) 最小闭环：自动会话、树根识别、节点/边存储、列表查看
2) 意图与新标签关联：准确率提升，重定向合并
3) 侧边面板径向树与面包屑：主交互完成
4) 历史会话与 JSON 导出、过滤黑名单
5) SPA 支持、性能优化与大图虚拟化
- 验收指标：边准确率、重复率、渲染帧率、存储体积

## 测试与验证
- 自动化：Playwright 复现点击/新标签/返回前进/重定向/搜索引擎进入等场景，断言边类型与关联。
- 手测清单：长链阅读、复制粘贴打开、站内 SPA 路由、域名过滤与暂停恢复。

## 术语定义
- 树根：无来源的首次访问页面
- 会话：浏览器打开到关闭的一段记录
- 点击意图：用户在页面内对链接的交互事件及其上下文

## 后续扩展（预研）
- 节点备注与标签、知识图谱聚合视图
- 跨设备同步（仅在用户选择时），多格式导出（GraphML/OPML）

## 下一步
- 在仓库创建 `docs/浏览路径树记录器.md` 写入本设计文档；实现按里程碑推进。请确认后开始落地。