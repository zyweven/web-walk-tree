async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "get-data" })
  const { nodes = [], edges = [] } = response
  const status = document.getElementById("status")
  
  const rootNodes = nodes.filter(n => n.isRoot)
  const totalPages = nodes.length
  const totalDomains = new Set(nodes.map(n => {
    try { return new URL(n.url).hostname } catch { return '' }
  }).filter(Boolean)).size
  
  status.innerHTML = `
    <div style="margin-bottom:6px;"><strong>📊 统计信息</strong></div>
    <div>总页面数：<strong>${totalPages}</strong></div>
    <div>涉及域名：<strong>${totalDomains}</strong></div>
    <div>起始页面：<strong>${rootNodes.length}</strong></div>
  `
}

document.getElementById("openSidePanel").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel/index.html" })
  await chrome.sidePanel.open({ tabId: tab.id })
}

document.getElementById("clearData").onclick = async () => {
  if (!confirm('确定要清空所有浏览记录吗？此操作不可恢复！')) return
  await chrome.runtime.sendMessage({ type: "clear-data" })
  await refresh()
  alert('数据已清空')
}

refresh()