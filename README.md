# Web Walk Tree

## 项目介绍
Web Walk Tree 是一个 Chrome 扩展，用来自动记录你的网页浏览路径，并在侧边栏以思维导图（路径树）方式可视化展示。  
它会把页面访问关系组织成 `节点（页面）+ 边（跳转）+ 会话（一次浏览周期）`，方便你回看浏览过程与信息探索脉络。

## 安装方法（Chrome 加载已解压扩展）
1. 打开 Chrome，进入 `chrome://extensions/`。
2. 右上角开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目的 `extension/` 目录。
5. 安装完成后，工具栏会出现 `Web Walk Tree` 扩展图标。

## 功能说明
1. 自动追踪浏览路径
   - 监听页面导航、链接点击、新标签打开、SPA 路由变化（`pushState/replaceState/popstate/hashchange`）。
   - 自动构建页面节点与跳转边，支持边类型区分（如 `click/typed/redirect/back` 等）。
2. 思维导图可视化
   - 在 Side Panel 中以路径树形式展示浏览关系。
   - 支持缩放、拖动画布、拖拽节点，点击节点可重新打开页面。
3. 会话管理
   - 自动维护当前会话（浏览过程）。
   - 支持“新会话”与“暂停/恢复记录”。
   - 支持切换会话、切换根节点查看子树。
4. 导出 JSON
   - 支持按会话导出：`{ session, nodes, edges }`。
   - 可在侧边栏导出，也可在选项页导出。
5. 域名黑名单
   - 支持配置 `blacklistDomains`，命中域名（含子域名）不记录。
   - 适合排除隐私或噪声站点。

## 使用方法
1. 打开侧边栏
   - 点击扩展图标打开弹窗。
   - 点击“查看浏览路径”，即可打开 Side Panel。
2. 开始记录
   - 正常浏览网页即可自动记录。
   - 侧边栏顶部会显示“记录中/已暂停”状态。
3. 常用操作
   - `会话下拉`：切换历史会话。
   - `根节点下拉`：切换要聚焦的路径树根。
   - `搜索框`：按标题或 URL 过滤节点。
   - `暂停/恢复`：临时关闭或恢复记录。
   - `新会话`：从当前时刻开始新的浏览会话。
   - `导出 JSON`：下载当前会话数据文件。

## 数据结构（JSON）
### Node
```json
{
  "id": "n_1731158399123_1",
  "url": "https://example.com/article",
  "title": "Example Article",
  "faviconUrl": "https://example.com/favicon.ico",
  "firstSeenAt": 1731158399123,
  "lastSeenAt": 1731158455000,
  "visitCount": 2,
  "sessionId": "s_20261115123000123_456",
  "isRoot": false
}
```

### Edge
```json
{
  "id": "e_1731158455000_3",
  "fromNodeId": "n_1731158399123_1",
  "toNodeId": "n_1731158455000_2",
  "type": "click",
  "createdAt": 1731158455000,
  "anchorText": "下一篇",
  "domPath": "body > main:nth-of-type(1) > a:nth-of-type(2)",
  "openInNewTab": false,
  "confidence": 0.95
}
```

### Session
```json
{
  "id": "s_20261115123000123_456",
  "date": "2026-11-15",
  "startedAt": 1731158200000,
  "endedAt": null,
  "rootNodeIds": [
    "n_1731158399123_1"
  ],
  "notes": "",
  "isPaused": false
}
```

## 技术栈
- Manifest V3
- Service Worker（`background/index.js`）
- Content Script（`content/content.js`）
- Side Panel（`sidepanel/index.html + index.js`）
- Chrome Extension APIs：`webNavigation`、`tabs`、`storage`、`sidePanel`、`scripting`
