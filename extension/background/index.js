const state = {
  tabNodeMap: new Map(),
  newTabParentMap: new Map(),
  intents: new Map()
}
const config = { useTabsCapture: true }

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

function normalizeUrl(u) {
  try {
    const url = new URL(u)
    // 移除常见的翻页参数
    const params = new URLSearchParams(url.search)
    const paginationParams = ['p', 'page', 'pageNum', 'pageNo', 'pageIndex', 'pg', 'pn']
    paginationParams.forEach(param => params.delete(param))
    
    // 移除追踪参数
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'share_from']
    trackingParams.forEach(param => params.delete(param))
    
    url.search = params.toString()
    return url.toString()
  } catch (e) {
    return u
  }
}

async function getStorage(keys) {
  return await chrome.storage.local.get(keys)
}

async function setStorage(obj) {
  await chrome.storage.local.set(obj)
}

function nodesKey() { return 'data:nodes' }
function edgesKey() { return 'data:edges' }

async function getData() {
  const data = await getStorage([nodesKey(), edgesKey()])
  return { nodes: data[nodesKey()] || [], edges: data[edgesKey()] || [] }
}

async function setData(nodes, edges) {
  await setStorage({ [nodesKey()]: nodes, [edgesKey()]: edges })
}

async function addNode(url, title, isRoot, faviconUrl) {
  const { nodes, edges } = await getData()
  const nurl = normalizeUrl(url)
  let node = nodes.find(n => n.url === nurl)
  if (!node) {
    node = { id: uid("n"), url: nurl, title: title || nurl, faviconUrl: faviconUrl || "", firstSeenAt: Date.now(), lastSeenAt: Date.now(), visitCount: 1, isRoot: !!isRoot }
    nodes.push(node)
  } else {
    node.lastSeenAt = Date.now()
    node.visitCount += 1
    if (faviconUrl && !node.faviconUrl) node.faviconUrl = faviconUrl
  }
  await setData(nodes, edges)
  return node
}

async function addEdge(fromNodeId, toNodeId, type, attrs = {}) {
  const { nodes, edges } = await getData()
  const edge = { id: uid("e"), fromNodeId, toNodeId, type, createdAt: Date.now(), anchorText: attrs.anchorText || "", domPath: attrs.domPath || "", openInNewTab: !!attrs.openInNewTab, confidence: attrs.confidence || 1 }
  edges.push(edge)
  await setData(nodes, edges)
  return edge
}

chrome.runtime.onStartup.addListener(() => {
  // 启动时无需操作
})

chrome.runtime.onInstalled.addListener(() => {
  // 安装时无需操作
})

chrome.windows.onRemoved.addListener(() => {
  // 窗口关闭时无需操作
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "link-intent" && sender && sender.tab && typeof sender.frameId === "number") {
    const key = `${sender.tab.id}:${sender.frameId}`
    state.intents.set(key, { url: msg.href, anchorText: msg.anchorText || "", domPath: msg.domPath || "", ts: Date.now() })
    sendResponse({ ok: true })
    return true
  }
  if (msg && msg.type === "get-data") {
    ;(async () => {
      const data = await getData()
      sendResponse({ ok: true, ...data })
    })()
    return true
  }
  if (msg && msg.type === "clear-data") {
    ;(async () => {
      await setData([], [])
      sendResponse({ ok: true })
    })()
    return true
  }
  if (msg && msg.type === "route-change" && sender && sender.tab) {
    ;(async () => {
      const tabId = sender.tab.id
      const url = msg.href
      const t = await chrome.tabs.get(tabId)
      const title = t.title || url
      const faviconUrl = t.favIconUrl || ""
      const parentNodeId = state.tabNodeMap.get(tabId) || null
      const node = await addNode(url, title, !parentNodeId, faviconUrl)
      if (parentNodeId) await addEdge(parentNodeId, node.id, "typed", { openInNewTab: false, confidence: 0.8 })
      state.tabNodeMap.set(tabId, node.id)
      await setStorage({ activeTabId: tabId })
    })()
    sendResponse({ ok: true })
    return true
  }
})

chrome.webNavigation.onCreatedNavigationTarget.addListener(async details => {
  const key = `${details.sourceTabId}:${details.sourceFrameId}`
  state.newTabParentMap.set(details.tabId, { sourceTabId: details.sourceTabId, sourceFrameId: details.sourceFrameId, key })
})

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return
  if (!shouldRecord(details.url)) return
  const url = details.url
  const tabId = details.tabId
  const frameId = details.frameId
  const transition = details.transitionType
  const key = `${tabId}:${frameId}`
  const intent = state.intents.get(key)
  let parentNodeId = state.tabNodeMap.get(tabId) || null
  let type = "typed"
  if (intent && intent.url) {
    type = "click"
  } else if (transition === "link") {
    type = "click"
  } else if (transition === "typed" || transition === "keyword" || transition === "generated") {
    type = transition
  }
  const isNewTabChild = state.newTabParentMap.get(tabId)
  if (isNewTabChild) {
    const srcTabId = isNewTabChild.sourceTabId
    parentNodeId = state.tabNodeMap.get(srcTabId) || parentNodeId
  }
  let title = details.title || url
  let faviconUrl = ""
  try {
    const t = await chrome.tabs.get(tabId)
    title = t.title || title
    faviconUrl = t.favIconUrl || ""
  } catch (e) {}
  const isRoot = !parentNodeId
  const node = await addNode(url, title, isRoot, faviconUrl)
  if (parentNodeId) {
    await addEdge(parentNodeId, node.id, type, intent ? { anchorText: intent.anchorText, domPath: intent.domPath, openInNewTab: !!isNewTabChild, confidence: 0.95 } : { openInNewTab: !!isNewTabChild })
  }
  state.tabNodeMap.set(tabId, node.id)
  state.intents.delete(key)
  state.newTabParentMap.delete(tabId)
  await setStorage({ activeTabId: tabId })
})

function pickIntent(tabId, url) {
  for (const [key, val] of state.intents.entries()) {
    if (!key.startsWith(`${tabId}:`)) continue
    if (val.url === url && Date.now() - val.ts < 3000) return val
  }
  return null
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!config.useTabsCapture) return
  if (!changeInfo.url) return
  if (!shouldRecord(changeInfo.url)) return
  const url = changeInfo.url
  if (!url) return
  let title = tab.title || url
  const faviconUrl = tab.favIconUrl || ""
  let parentNodeId = state.tabNodeMap.get(tabId) || null
  if (!parentNodeId) {
    const k = tabNodeKey(tabId)
    const v = await getStorage([k])
    parentNodeId = v[k] || null
  }
  const newTabInfo = state.newTabParentMap.get(tabId)
  if (newTabInfo) {
    const srcTabId = newTabInfo.sourceTabId
    parentNodeId = state.tabNodeMap.get(srcTabId) || parentNodeId
    if (!parentNodeId) {
      const sk = tabNodeKey(srcTabId)
      const sv = await getStorage([sk])
      parentNodeId = sv[sk] || parentNodeId
    }
  }
  const intent = pickIntent(tabId, url)
  const node = await addNode(url, title, !parentNodeId, faviconUrl)
  try { console.debug('onUpdated', { tabId, url, parentNodeId, nodeId: node.id, intent: !!intent }) } catch (e) {}
  if (parentNodeId) {
    await addEdge(parentNodeId, node.id, intent ? "click" : "typed", intent ? { anchorText: intent.anchorText, domPath: intent.domPath, openInNewTab: !!newTabInfo, confidence: 0.95 } : { openInNewTab: !!newTabInfo, confidence: 0.7 })
  }
  state.tabNodeMap.set(tabId, node.id)
  await setStorage({ [tabNodeKey(tabId)]: node.id })
  try { console.debug('setTabNodeMap', { tabId, nodeId: node.id }) } catch (e) {}
  state.newTabParentMap.delete(tabId)
  await setStorage({ activeTabId: tabId })
})

chrome.tabs.onActivated.addListener(async activeInfo => {
  const tab = await chrome.tabs.get(activeInfo.tabId)
  if (!tab || !tab.url) return
  await setStorage({ activeTabId: activeInfo.tabId })
})
function tabNodeKey(tabId) { return `tab_node_${tabId}` }
function shouldRecord(url) {
  if (!url) return false
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false
  
  // 过滤掉静态资源文件
  const staticExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.svg',
    '.css', '.js', '.json', '.xml',
    '.mp4', '.mp3', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.pdf', '.zip', '.rar', '.tar', '.gz',
    '.woff', '.woff2', '.ttf', '.eot', '.otf'
  ]
  
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()
    
    // 检查是否以静态资源扩展名结尾
    for (const ext of staticExtensions) {
      if (pathname.endsWith(ext)) {
        return false
      }
    }
    
    // 检查是否是 data: 或 blob: URL
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return false
    }
    
    return true
  } catch (e) {
    return false
  }
}