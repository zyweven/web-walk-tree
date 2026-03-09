async function getStorage(keys) {
  return await chrome.storage.local.get(keys)
}

function sessionKey(id) { return `data:${id}:session` }
function nodesKey(id) { return `data:${id}:nodes` }
function edgesKey(id) { return `data:${id}:edges` }

async function loadSessions() {
  const { sessions = [], currentSessionId } = await getStorage(["sessions", "currentSessionId"])
  const sel = document.getElementById("sessionSelect")
  sel.innerHTML = ""
  const list = sessions.slice().reverse()
  const hasCurrent = list.some(s => s.id === currentSessionId)
  if (currentSessionId && !hasCurrent) list.unshift({ id: currentSessionId })
  list.forEach(s => {
    const o = document.createElement("option")
    o.value = s.id
    o.textContent = `${s.id}`
    sel.appendChild(o)
  })
  if (currentSessionId) sel.value = currentSessionId
  sel.onchange = () => render(sel.value)
  const viewSel = document.getElementById("viewSelect")
  const { sidepanelView } = await getStorage(["sidepanelView"]) 
  if (sidepanelView) {
    viewSel.value = sidepanelView
  } else {
    viewSel.value = "mindmap"
  }
  viewSel.onchange = () => { chrome.storage.local.set({ sidepanelView: viewSel.value }); render(sel.value) }
  await render(sel.value)
}

function buildIndex(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const children = new Map()
  edges.forEach(e => {
    const list = children.get(e.fromNodeId) || []
    list.push(e)
    children.set(e.fromNodeId, list)
  })
  const parent = new Map()
  edges.forEach(e => parent.set(e.toNodeId, e.fromNodeId))
  return { byId, children, parent }
}

function renderRoots(container, nodes, edges) {
  const { children } = buildIndex(nodes, edges)
  container.innerHTML = ""
  nodes.filter(n => n.isRoot).sort((a,b) => a.firstSeenAt - b.firstSeenAt).forEach(root => {
    const div = document.createElement("div")
    div.className = "root"
    const title = document.createElement("div")
    title.textContent = `${new URL(root.url).hostname} — ${root.title}`
    div.appendChild(title)
    const ul = document.createElement("ul")
    function addChildren(nodeId, depth=0) {
      if (depth >= 2) return
      const es = children.get(nodeId) || []
      es.forEach(e => {
        const n = nodes.find(x => x.id === e.toNodeId)
        const li = document.createElement("li")
        const a = document.createElement("a")
        a.href = n.url
        a.textContent = `${new URL(n.url).hostname} — ${n.title}`
        a.className = "url"
        a.target = "_blank"
        a.title = n.url
        li.appendChild(a)
        ul.appendChild(li)
        addChildren(n.id, depth+1)
      })
    }
    addChildren(root.id, 0)
    div.appendChild(ul)
    container.appendChild(div)
  })
}

function renderTimeline(container, nodes, edges) {
  container.innerHTML = ""
  const events = []
  nodes.filter(n => n.isRoot).forEach(n => {
    events.push({ ts: n.firstSeenAt, type: "root", node: n, edge: null })
  })
  edges.forEach(e => {
    const to = nodes.find(n => n.id === e.toNodeId)
    events.push({ ts: e.createdAt, type: e.type, node: to, edge: e })
  })
  events.sort((a,b) => b.ts - a.ts)
  const ul = document.createElement("ul")
  events.slice(0, 200).forEach(ev => {
    const li = document.createElement("li")
    const a = document.createElement("a")
    a.href = ev.node.url
    a.textContent = `${new Date(ev.ts).toLocaleTimeString()} · ${new URL(ev.node.url).hostname} · ${ev.node.title}`
    a.className = "url"
    a.target = "_blank"
    a.title = ev.node.url
    li.appendChild(a)
    ul.appendChild(li)
  })
  container.appendChild(ul)
}

async function renderRadial(container, nodes, edges) {
  container.innerHTML = ""
  function measure(el){
    let w = el.clientWidth || el.offsetWidth || (el.getBoundingClientRect().width || 600)
    let h = el.clientHeight || el.offsetHeight || (el.getBoundingClientRect().height || 480)
    w = Math.max(360, Math.floor(w))
    h = Math.max(360, Math.floor(h))
    return { w, h }
  }
  const { w: width, h: height } = measure(container)
  const cx = width / 2, cy = height / 2
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
  svg.style.width = "100%"
  svg.style.height = "100%"
  const gContent = document.createElementNS("http://www.w3.org/2000/svg", "g")
  const httpNodes = nodes.filter(n => /^https?:/i.test(n.url))
  const httpEdges = edges.filter(e => {
    const a = httpNodes.find(n => n.id === e.fromNodeId)
    const b = httpNodes.find(n => n.id === e.toNodeId)
    return !!a && !!b
  })
  const { children, parent } = buildIndex(httpNodes, httpEdges)
  const roots = httpNodes.filter(n => n.isRoot).sort((a,b)=>a.firstSeenAt-b.firstSeenAt)
  let root = roots[0] || httpNodes[0]
  try {
    const pref = await getStorage(["sidepanelRootId"]) 
    if (pref.sidepanelRootId) {
      const picked = httpNodes.find(n => n.id === pref.sidepanelRootId)
      if (picked) root = picked
    }
  } catch {}
  try {
    const { activeTabId } = await getStorage(["activeTabId"]) 
    if (activeTabId) {
      const tab = await chrome.tabs.get(activeTabId)
      const current = httpNodes.slice().reverse().find(n => n.url === tab.url)
      if (current) {
        let cur = current
        while (cur && !cur.isRoot) {
          const pId = parent.get(cur.id)
          cur = httpNodes.find(n => n.id === pId)
        }
        if (cur) root = cur
      }
    }
  } catch (e) {}
  if (!root) { container.textContent = "暂无数据"; return }
  const maxDepth = 3
  const levelNodes = []
  levelNodes[0] = [root]
  const seen = new Set([root.id])
  const usedEdgePairs = []
  for (let d=1; d<=maxDepth; d++) {
    const prev = levelNodes[d-1] || []
    const next = []
    prev.forEach(p => {
      const es = children.get(p.id) || []
      es.forEach(e => {
        const n = httpNodes.find(x => x.id === e.toNodeId)
        if (n && !seen.has(n.id)) { seen.add(n.id); next.push(n); usedEdgePairs.push({ from: p.id, to: n.id }) }
      })
    })
    levelNodes[d] = next.slice(0, 40)
  }
  const maxR = Math.min(cx, cy) - 60
  const radiusBase = Math.max(40, Math.floor(maxR / (maxDepth + 1)))
  const radiusStep = Math.max(60, Math.floor((maxR - radiusBase) / Math.max(1, maxDepth)))
  const pos = new Map()
  levelNodes.forEach((arr, d) => {
    let r = Math.min(maxR, radiusBase + d * radiusStep)
    const count = Math.max(arr.length, 1)
    if (count > 10) r = Math.min(maxR, r * 1.2)
    const base = Math.random() * Math.PI * 2
    const step = (Math.PI * 2) / count
    arr.forEach((n, i) => {
      const angle = base + step * i
      const x = cx + r * Math.cos(angle)
      const y = cy + r * Math.sin(angle)
      pos.set(n.id, { x, y })
    })
  })
  usedEdgePairs.forEach(e => {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) return
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line")
    line.setAttribute("x1", String(a.x))
    line.setAttribute("y1", String(a.y))
    line.setAttribute("x2", String(b.x))
    line.setAttribute("y2", String(b.y))
    line.setAttribute("stroke", "#ddd")
    line.setAttribute("stroke-width", "1")
    gContent.appendChild(line)
  })
  const formatTitle = t => (t || "").slice(0, 14)
  const host = u => { try { return new URL(u).hostname } catch { return u } }
  levelNodes.flat().forEach(n => {
    const p = pos.get(n.id)
    if (!p) return
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g")
    const link = document.createElementNS("http://www.w3.org/2000/svg", "a")
    link.setAttribute("href", n.url)
    link.setAttribute("target", "_blank")
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle")
    circle.setAttribute("cx", String(p.x))
    circle.setAttribute("cy", String(p.y))
    circle.setAttribute("r", "8")
    circle.setAttribute("fill", n.id === root.id ? "#0070f3" : "#666")
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text")
    text.setAttribute("x", String(p.x + 12))
    text.setAttribute("y", String(p.y + 4))
    text.setAttribute("font-size", "12")
    text.setAttribute("fill", "#333")
    text.textContent = `${host(n.url)} · ${formatTitle(n.title)}`
    text.setAttribute("dominant-baseline", "middle")
    text.setAttribute("textLength", String(Math.min(240, Math.max(60, width - p.x - 24))))
    link.appendChild(circle)
    group.appendChild(link)
    group.appendChild(text)
    gContent.appendChild(group)
  })
  const total = levelNodes.flat().length
  if (total <= 1) {
    const msg = document.createElement("div")
    msg.style.color = "#666"
    msg.style.fontSize = "12px"
    msg.textContent = "当前根下暂无子节点，继续浏览或切换视图查看。"
    container.appendChild(msg)
    svg.appendChild(gContent)
    container.appendChild(svg)
    return
  }
  svg.appendChild(gContent)
  const ctrl = enablePanZoom(svg, gContent, width, height)
  attachControls(ctrl, svg, gContent)
  container.appendChild(svg)
}

function enablePanZoom(svg, g, w, h) {
  let scale = 1
  let tx = 0, ty = 0
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
  function apply() { g.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`) }
  svg.addEventListener("wheel", e => {
    e.preventDefault()
    const rect = svg.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const preX = (mx - tx) / scale
    const preY = (my - ty) / scale
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    scale = clamp(scale * delta, 0.5, 3)
    tx = mx - preX * scale
    ty = my - preY * scale
    apply()
  }, { passive: false })
  let dragging = false, sx = 0, sy = 0
  svg.addEventListener("mousedown", e => { dragging = true; sx = e.clientX; sy = e.clientY })
  window.addEventListener("mouseup", () => { dragging = false })
  window.addEventListener("mousemove", e => { if (!dragging) return; tx += (e.clientX - sx); ty += (e.clientY - sy); sx = e.clientX; sy = e.clientY; apply() })
  apply()
  function fit() {
    try {
      const box = g.getBBox()
      const margin = 20
      const vw = svg.clientWidth || w
      const vh = svg.clientHeight || h
      const sx = (vw - margin * 2) / box.width
      const sy = (vh - margin * 2) / box.height
      scale = clamp(Math.min(sx, sy), 0.3, 4)
      tx = margin - box.x * scale
      ty = margin - box.y * scale
      apply()
    } catch {}
  }
  function zoomIn() { scale = clamp(scale * 1.2, 0.5, 4); apply() }
  function zoomOut() { scale = clamp(scale / 1.2, 0.5, 4); apply() }
  function centerRoot() {
    try {
      const circles = g.querySelectorAll('circle')
      const rootCircle = circles[0]
      if (!rootCircle) return
      const cx = parseFloat(rootCircle.getAttribute('cx'))
      const cy = parseFloat(rootCircle.getAttribute('cy'))
      const vw = svg.clientWidth || w
      const vh = svg.clientHeight || h
      tx = vw / 2 - cx * scale
      ty = vh / 2 - cy * scale
      apply()
    } catch {}
  }
  return { fit, zoomIn, zoomOut, centerRoot }
}

function attachControls(ctrl, svg, g) {
  const btnFit = document.getElementById('btnFit')
  const btnCenter = document.getElementById('btnCenter')
  const btnZoomIn = document.getElementById('btnZoomIn')
  const btnZoomOut = document.getElementById('btnZoomOut')
  if (btnFit) btnFit.onclick = () => ctrl.fit()
  if (btnCenter) btnCenter.onclick = () => ctrl.centerRoot()
  if (btnZoomIn) btnZoomIn.onclick = () => ctrl.zoomIn()
  if (btnZoomOut) btnZoomOut.onclick = () => ctrl.zoomOut()
  // 首次渲染自适配
  setTimeout(() => ctrl.fit(), 0)
}

async function renderMindmap(container, nodes, edges) {
  container.innerHTML = ""
  function measure(el){
    let w = el.clientWidth || el.offsetWidth || (el.getBoundingClientRect().width || 800)
    let h = el.clientHeight || el.offsetHeight || (el.getBoundingClientRect().height || 600)
    w = Math.max(480, Math.floor(w))
    h = Math.max(360, Math.floor(h))
    return { w, h }
  }
  const { w: width, h: height } = measure(container)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
  svg.style.width = "100%"
  svg.style.height = "100%"
  const gContent = document.createElementNS("http://www.w3.org/2000/svg", "g")
  const httpNodes = nodes.filter(n => /^https?:/i.test(n.url))
  const nodeById = new Map(httpNodes.map(n => [n.id, n]))
  const parent = new Map()
  edges.forEach(e => { if (nodeById.has(e.fromNodeId) && nodeById.has(e.toNodeId)) parent.set(e.toNodeId, e.fromNodeId) })
  const children = new Map()
  edges.forEach(e => { if (!nodeById.has(e.fromNodeId) || !nodeById.has(e.toNodeId)) return; const list = children.get(e.fromNodeId) || []; list.push(e.toNodeId); children.set(e.fromNodeId, list) })
  let roots = httpNodes.filter(n => n.isRoot)
  let root = roots.sort((a,b)=>a.firstSeenAt-b.firstSeenAt)[0] || httpNodes[0]
  try {
    const pref = await getStorage(["sidepanelRootId"]) 
    if (pref.sidepanelRootId) {
      const picked = httpNodes.find(n => n.id === pref.sidepanelRootId)
      if (picked) root = picked
    }
  } catch {}
  try {
    const { activeTabId } = await getStorage(["activeTabId"]) 
    if (activeTabId) {
      const tab = await chrome.tabs.get(activeTabId)
      const current = httpNodes.slice().reverse().find(n => n.url === tab.url)
      if (current) {
        let cur = current
        while (cur && !cur.isRoot) { const pId = parent.get(cur.id); cur = nodeById.get(pId) }
        if (cur) root = cur
      }
    }
  } catch {}
  if (!root) { container.textContent = "暂无数据"; return }
  const maxDepth = 4
  const levelNodes = []
  levelNodes[0] = [root]
  const seen = new Set([root.id])
  const usedEdgePairs = []
  for (let d=1; d<=maxDepth; d++) {
    const prev = levelNodes[d-1] || []
    const next = []
    prev.forEach(p => {
      const list = (children.get(p.id) || []).map(id => nodeById.get(id)).filter(Boolean)
      list.forEach(n => { if (!seen.has(n.id)) { seen.add(n.id); next.push(n); usedEdgePairs.push({ from: p.id, to: n.id }) } })
    })
    levelNodes[d] = next.slice(0, 24)
  }
  const margin = { left: 40, right: 40, top: 40, bottom: 40 }
  const layers = levelNodes.map((arr, d) => ({ arr, x: margin.left + d * ((width - margin.left - margin.right) / Math.max(1, maxDepth)) }))
  const pos = new Map()
  layers.forEach(({ arr, x }, d) => {
    const gap = (height - margin.top - margin.bottom) / Math.max(arr.length, 1)
    arr.forEach((n, i) => { const y = margin.top + gap * (i + 0.5); pos.set(n.id, { x, y }) })
  })
  function path(a, b){ const mx = (a.x + b.x) / 2; return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}` }
  const gLinks = document.createElementNS("http://www.w3.org/2000/svg", "g")
  gLinks.setAttribute("stroke", "#ddd"); gLinks.setAttribute("fill", "none")
  usedEdgePairs.forEach(e => { const a = pos.get(e.from); const b = pos.get(e.to); if (!a || !b) return; const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", path(a,b)); p.setAttribute("stroke-width", "1"); gLinks.appendChild(p) })
  gContent.appendChild(gLinks)
  const gNodes = document.createElementNS("http://www.w3.org/2000/svg", "g")
  function host(u){ try { return new URL(u).hostname } catch { return u } }
  function wrap(text, max){ const t = (text||"").trim(); if (t.length <= max) return [t]; const lines = []; let i = 0; while (i < t.length) { lines.push(t.slice(i, i+max)); i += max } return lines }
  const labelMax = 22
  levelNodes.flat().forEach(n => {
    const p = pos.get(n.id); if (!p) return
    const link = document.createElementNS("http://www.w3.org/2000/svg", "a"); link.setAttribute("href", n.url); link.setAttribute("target", "_blank")
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle"); circle.setAttribute("cx", String(p.x)); circle.setAttribute("cy", String(p.y)); circle.setAttribute("r", String(n.id===root.id?6:4)); circle.setAttribute("fill", n.id===root.id?"#0070f3":"#666")
    link.appendChild(circle)
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text"); text.setAttribute("x", String(p.x + 10)); text.setAttribute("y", String(p.y)); text.setAttribute("font-size", "12"); text.setAttribute("fill", "#333"); text.setAttribute("dominant-baseline", "middle")
    const lines = [`${host(n.url)}`, ...wrap(n.title, labelMax)]
    lines.forEach((line, i) => { const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan"); tspan.setAttribute("x", String(p.x + 10)); tspan.setAttribute("dy", String(i===0?0:14)); tspan.textContent = line; text.appendChild(tspan) })
    gNodes.appendChild(link); gNodes.appendChild(text)
  })
  gContent.appendChild(gNodes)
  if (levelNodes.flat().length <= 1) { const msg = document.createElement("div"); msg.style.color = "#666"; msg.style.fontSize = "12px"; msg.textContent = "当前根下暂无子节点，继续浏览或切换视图查看。"; container.appendChild(msg) }
  svg.appendChild(gContent)
  const ctrl = enablePanZoom(svg, gContent, width, height)
  attachControls(ctrl, svg, gContent)
  container.appendChild(svg)
}

async function renderBreadcrumb(currentSessionId, nodes, edges) {
  const div = document.getElementById("breadcrumb")
  const { activeTabId } = await getStorage(["activeTabId"]) 
  if (!activeTabId) { div.textContent = ""; return }
  const currentUrl = (await chrome.tabs.get(activeTabId)).url
  const currentNode = nodes.slice().reverse().find(n => n.url === currentUrl)
  if (!currentNode) { div.textContent = ""; return }
  const path = []
  let node = currentNode
  const parentsByChild = new Map()
  edges.forEach(e => parentsByChild.set(e.toNodeId, e.fromNodeId))
  while (node) {
    path.push(node)
    const pId = parentsByChild.get(node.id)
    node = nodes.find(n => n.id === pId)
  }
  path.reverse()
  div.textContent = path.map(n => new URL(n.url).hostname).join(" › ")
}

async function render(sessionId) {
  if (!sessionId) {
    const roots = document.getElementById("roots")
    roots.innerHTML = "尚未开始记录，请在弹窗中新建会话或恢复记录。"
    document.getElementById("breadcrumb").textContent = ""
    return
  }
  const data = await getStorage([sessionKey(sessionId), nodesKey(sessionId), edgesKey(sessionId)])
  const nodes = data[nodesKey(sessionId)] || []
  const edges = data[edgesKey(sessionId)] || []
  const groupChk = document.getElementById("groupByDomain")
  const grouped = groupChk && groupChk.checked
  const source = grouped ? aggregateByDomain(nodes, edges) : { nodes, edges }
  const rootSelect = document.getElementById("rootSelect")
  if (rootSelect) {
    rootSelect.innerHTML = ""
    const rootsList = nodes.filter(n => n.isRoot).sort((a,b)=>a.firstSeenAt-b.firstSeenAt)
    rootsList.forEach(r => {
      const opt = document.createElement("option")
      try { opt.textContent = new URL(r.url).hostname } catch { opt.textContent = r.url }
      opt.value = r.id
      rootSelect.appendChild(opt)
    })
    const pref = await getStorage(["sidepanelRootId"]) 
    if (pref.sidepanelRootId && rootsList.some(r => r.id === pref.sidepanelRootId)) rootSelect.value = pref.sidepanelRootId
    rootSelect.onchange = async () => { await chrome.storage.local.set({ sidepanelRootId: rootSelect.value }); await render(sessionId) }
  }
  const viewSel = document.getElementById("viewSelect")
  if (!nodes.length) {
    const roots = document.getElementById("roots")
    roots.innerHTML = "当前会话暂无记录，开始浏览或在弹窗中确认状态为记录中。"
  } else {
    if (viewSel.value === "timeline") {
      renderTimeline(document.getElementById("roots"), source.nodes, source.edges)
    } else if (viewSel.value === "radial") {
      await renderRadial(document.getElementById("roots"), source.nodes, source.edges)
    } else if (viewSel.value === "mindmap") {
      await renderMindmap(document.getElementById("roots"), source.nodes, source.edges)
    } else {
      renderRoots(document.getElementById("roots"), source.nodes, source.edges)
    }
  }
  await renderBreadcrumb(sessionId, nodes, edges)
}

chrome.runtime.sendMessage({ type: "ensure-session" }, async () => {
  await loadSessions()
})
let renderTimer = null
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return
  const sel = document.getElementById("sessionSelect")
  const current = sel.value
  const relevantKeys = new Set(["sessions", "currentSessionId", "sidepanelView", sessionKey(current), nodesKey(current), edgesKey(current)])
  const hasRelevant = Object.keys(changes).some(k => relevantKeys.has(k))
  if (hasRelevant) {
    if (renderTimer) clearTimeout(renderTimer)
    renderTimer = setTimeout(async () => {
      await loadSessions()
    }, 400)
  }
})
function aggregateByDomain(nodes, edges) {
  const hn = u => { try { return new URL(u).hostname } catch { return u } }
  const map = new Map()
  nodes.forEach(n => {
    const d = hn(n.url)
    const id = `d:${d}`
    if (!map.has(d)) map.set(d, { id, url: `https://${d}/`, title: d, isRoot: false, firstSeenAt: n.firstSeenAt })
    if (n.isRoot) map.get(d).isRoot = true
  })
  const aggNodes = Array.from(map.values())
  const uniq = new Set()
  const aggEdges = []
  edges.forEach(e => {
    const from = nodes.find(x => x.id === e.fromNodeId)
    const to = nodes.find(x => x.id === e.toNodeId)
    if (!from || !to) return
    const df = hn(from.url), dt = hn(to.url)
    const k = `${df}=>${dt}`
    if (df === dt) return
    if (uniq.has(k)) return
    uniq.add(k)
    aggEdges.push({ id: `de:${k}`, fromNodeId: `d:${df}`, toNodeId: `d:${dt}`, type: "domain" })
  })
  return { nodes: aggNodes, edges: aggEdges }
}