## 问题分析
- 高频写入 `chrome.storage.local`：每次导航都整包写入 `nodes/edges`，造成主线程阻塞与内存压力。
- UI过度刷新：侧边面板监听存储变更后全量重渲染，且树视图递归展开所有分支，导致大DOM与频繁布局。
- 事件过度采集：内容脚本监听 `contextmenu` 等频繁事件，产生消息风暴。
- 非必要记录：`tabs.onActivated` 对标签切换也创建节点，导致数据膨胀。

## 修复目标
- 将记录写入改为批量缓冲，按时间或批次数刷新存储。
- 限制树视图展开深度与渲染量，默认时间线视图。
- 减少事件监听范围与频率，避免无关记录。
- 保持功能完整，显著降低卡顿与崩溃概率。

## 改造方案
- 背景服务：
  - 引入内存缓冲 `store{session,nodes,edges}`，`scheduleFlush()` 每2秒或累积N条再写入。
  - `addNode/addEdge` 仅操作缓冲；只在定时器触发时写入存储。
  - 移除 `tabs.onActivated` 的节点创建，仅记录 `activeTabId`。
  - 在 `new-session/ensure-session` 时同步缓冲与存储。
- 内容脚本：移除 `contextmenu` 监听，仅保留 `click/auxclick`，降低消息频率。
- 侧边面板：
  - 默认视图设为“时间线”，限制显示最近200条。
  - 树视图限制展开深度（如2层），避免递归渲染整图。
  - 为存储变更添加防抖（~400ms），减少频繁重绘。

## 验证
- 浏览常见场景（点击、新标签、搜索、地址栏输入），确认记录生成且UI可见。
- 观察CPU与内存占用显著下降，无卡顿与崩溃。

## 变更范围
- `extension/background/index.js`、`extension/content/content.js`、`extension/sidepanel/index.js`、`extension/sidepanel/index.html`

如确认，我将立即按此方案实施并交付。