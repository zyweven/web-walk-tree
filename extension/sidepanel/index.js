const EDGE_COLORS = {
  click: "#0ea5e9",
  typed: "#6b7280",
  keyword: "#8b5cf6",
  redirect: "#f59e0b",
  back: "#ef4444",
  forward: "#f97316",
  default: "#94a3b8"
}

const state = {
  dashboard: null,
  settings: null,
  sessionData: null,
  selectedSessionId: "",
  selectedRootId: "",
  searchText: "",
  graph: null,
  transform: {
    x: 400,
    y: 300,
    scale: 1
  },
  autoFit: true,
  interaction: {
    mode: null,
    nodeId: null,
    startX: 0,
    startY: 0,
    moved: false
  },
  renderCache: {
    nodeById: new Map(),
    edgeEls: [],
    nodeEls: []
  }
}

function getEl(id) {
  return document.getElementById(id)
}

function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

async function callBg(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload })
  if (!response || response.ok === false) {
    throw new Error(response && response.error ? response.error : `request-failed:${type}`)
  }
  return response
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch (error) {
    return url || ""
  }
}

function formatTime(ts) {
  if (!ts) return "-"
  try {
    return new Date(ts).toLocaleString()
  } catch (error) {
    return String(ts)
  }
}

function trunc(text, max) {
  const value = String(text || "")
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function svgSize() {
  const svg = getEl("graphSvg")
  const rect = svg.getBoundingClientRect()
  return {
    width: Math.max(360, Math.round(rect.width || 800)),
    height: Math.max(300, Math.round(rect.height || 600))
  }
}

function populateSessionSelect(sessions, currentSessionId) {
  const select = getEl("sessionSelect")
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt)
  select.innerHTML = ""

  if (!sorted.length) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "无会话"
    select.appendChild(option)
    state.selectedSessionId = ""
    return
  }

  sorted.forEach((session) => {
    const option = document.createElement("option")
    option.value = session.id
    const endedText = session.endedAt ? "已结束" : "进行中"
    option.textContent = `${session.id} (${endedText})`
    select.appendChild(option)
  })

  const targetId = state.selectedSessionId
    || currentSessionId
    || sorted[0].id

  if (sorted.some((item) => item.id === targetId)) {
    select.value = targetId
    state.selectedSessionId = targetId
  } else {
    select.value = sorted[0].id
    state.selectedSessionId = sorted[0].id
  }
}

function guessRootId(nodes, edges, currentNodeId) {
  const roots = nodes.filter((node) => node.isRoot)
  if (!roots.length) return ""

  if (!currentNodeId) return roots[0].id

  const parentByChild = new Map()
  edges.forEach((edge) => {
    if (!parentByChild.has(edge.toNodeId)) {
      parentByChild.set(edge.toNodeId, edge.fromNodeId)
    }
  })

  const byId = new Map(nodes.map((node) => [node.id, node]))
  let cursor = byId.get(currentNodeId)
  const seen = new Set()

  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    if (cursor.isRoot) return cursor.id
    cursor = byId.get(parentByChild.get(cursor.id))
  }

  return roots[0].id
}

function populateRootSelect(nodes, edges, currentNodeId) {
  const select = getEl("rootSelect")
  const roots = nodes.filter((node) => node.isRoot).sort((a, b) => a.firstSeenAt - b.firstSeenAt)

  select.innerHTML = ""

  const autoOption = document.createElement("option")
  autoOption.value = ""
  autoOption.textContent = "自动根节点"
  select.appendChild(autoOption)

  roots.forEach((node) => {
    const option = document.createElement("option")
    option.value = node.id
    option.textContent = `${hostOf(node.url)} · ${trunc(node.title, 18)}`
    select.appendChild(option)
  })

  const autoRootId = guessRootId(nodes, edges, currentNodeId)
  if (state.selectedRootId && roots.some((root) => root.id === state.selectedRootId)) {
    select.value = state.selectedRootId
  } else {
    select.value = ""
    state.selectedRootId = autoRootId
  }
}

function buildGraph(nodes, edges, rootId, currentNodeId, searchText) {
  const nodeById = new Map(nodes.map((node) => [node.id, { ...node }]))
  const validEdges = edges.filter((edge) => nodeById.has(edge.fromNodeId) && nodeById.has(edge.toNodeId))

  let pickedRootId = rootId
  if (!pickedRootId || !nodeById.has(pickedRootId)) {
    pickedRootId = guessRootId(nodes, validEdges, currentNodeId)
  }

  let visibleIds = new Set(nodeById.keys())
  if (pickedRootId && nodeById.has(pickedRootId)) {
    visibleIds = new Set([pickedRootId])
    const queue = [pickedRootId]
    while (queue.length) {
      const fromId = queue.shift()
      validEdges.forEach((edge) => {
        if (edge.fromNodeId !== fromId) return
        if (!visibleIds.has(edge.toNodeId)) {
          visibleIds.add(edge.toNodeId)
          queue.push(edge.toNodeId)
        }
      })
    }
  }

  let filteredEdges = validEdges.filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId))
  let filteredNodes = [...visibleIds].map((id) => nodeById.get(id)).filter(Boolean)

  const query = String(searchText || "").trim().toLowerCase()
  if (query) {
    const matched = new Set(
      filteredNodes
        .filter((node) => (
          node.title.toLowerCase().includes(query)
          || node.url.toLowerCase().includes(query)
        ))
        .map((node) => node.id)
    )

    const keep = new Set(matched)

    // 保留匹配节点的上下文，避免孤立节点。
    let changed = true
    while (changed) {
      changed = false
      filteredEdges.forEach((edge) => {
        if (keep.has(edge.fromNodeId) && !keep.has(edge.toNodeId)) {
          keep.add(edge.toNodeId)
          changed = true
        }
        if (keep.has(edge.toNodeId) && !keep.has(edge.fromNodeId)) {
          keep.add(edge.fromNodeId)
          changed = true
        }
      })
    }

    filteredNodes = filteredNodes.filter((node) => keep.has(node.id))
    filteredEdges = filteredEdges.filter((edge) => keep.has(edge.fromNodeId) && keep.has(edge.toNodeId))
  }

  const graphNodeById = new Map(filteredNodes.map((node) => [node.id, node]))
  const outEdges = new Map()
  filteredEdges.forEach((edge) => {
    const list = outEdges.get(edge.fromNodeId) || []
    list.push(edge)
    outEdges.set(edge.fromNodeId, list)
  })

  const depthByNode = new Map()
  if (pickedRootId && graphNodeById.has(pickedRootId)) {
    depthByNode.set(pickedRootId, 0)
    const queue = [pickedRootId]
    while (queue.length) {
      const id = queue.shift()
      const depth = depthByNode.get(id)
      const outgoing = outEdges.get(id) || []
      outgoing.forEach((edge) => {
        if (!depthByNode.has(edge.toNodeId)) {
          depthByNode.set(edge.toNodeId, depth + 1)
          queue.push(edge.toNodeId)
        }
      })
    }
  }

  const preparedNodes = filteredNodes.map((node) => {
    const depth = depthByNode.has(node.id) ? depthByNode.get(node.id) : 1
    const radius = node.id === currentNodeId ? 17 : (node.id === pickedRootId ? 15 : 12)
    return {
      ...node,
      depth,
      radius,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      isCurrent: node.id === currentNodeId,
      isPickedRoot: node.id === pickedRootId
    }
  })

  return {
    rootId: pickedRootId,
    nodes: preparedNodes,
    edges: filteredEdges
  }
}

function initNodePositions(graph) {
  if (!graph.nodes.length) return

  const byDepth = new Map()
  graph.nodes.forEach((node) => {
    const list = byDepth.get(node.depth) || []
    list.push(node)
    byDepth.set(node.depth, list)
  })

  const root = graph.nodes.find((node) => node.id === graph.rootId) || graph.nodes[0]
  root.x = 0
  root.y = 0

  const maxDepth = Math.max(...graph.nodes.map((node) => node.depth))
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const layer = byDepth.get(depth) || []
    if (!layer.length) continue
    const radius = 120 + depth * 130
    const step = (Math.PI * 2) / layer.length
    const offset = (depth % 2) * 0.4
    layer.forEach((node, index) => {
      const angle = offset + step * index
      node.x = Math.cos(angle) * radius
      node.y = Math.sin(angle) * radius
    })
  }
}

function runForceLayout(graph) {
  const nodes = graph.nodes
  const edges = graph.edges
  if (!nodes.length) return

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const root = nodes.find((node) => node.id === graph.rootId) || nodes[0]
  const iterations = nodes.length > 220 ? 120 : 220

  for (let tick = 0; tick < iterations; tick += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distSq = dx * dx + dy * dy
        if (distSq < 0.1) {
          dx = (Math.random() - 0.5) * 2
          dy = (Math.random() - 0.5) * 2
          distSq = dx * dx + dy * dy
        }

        const minDist = a.radius + b.radius + 24
        if (distSq > (minDist * minDist) * 6) continue

        const dist = Math.sqrt(distSq)
        const repel = 900 / distSq
        const ux = dx / dist
        const uy = dy / dist
        a.vx += ux * repel
        a.vy += uy * repel
        b.vx -= ux * repel
        b.vy -= uy * repel

        if (dist < minDist) {
          const overlap = (minDist - dist) * 0.02
          a.vx += ux * overlap
          a.vy += uy * overlap
          b.vx -= ux * overlap
          b.vy -= uy * overlap
        }
      }
    }

    edges.forEach((edge) => {
      const from = nodeById.get(edge.fromNodeId)
      const to = nodeById.get(edge.toNodeId)
      if (!from || !to) return

      const dx = to.x - from.x
      const dy = to.y - from.y
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const target = 110 + Math.abs((to.depth || 1) - (from.depth || 1)) * 34
      const spring = (dist - target) * 0.004
      const ux = dx / dist
      const uy = dy / dist

      from.vx += ux * spring
      from.vy += uy * spring
      to.vx -= ux * spring
      to.vy -= uy * spring
    })

    nodes.forEach((node) => {
      if (node.id === root.id) {
        node.vx += (0 - node.x) * 0.02
        node.vy += (0 - node.y) * 0.02
      } else {
        const depth = Math.max(1, node.depth || 1)
        const targetRadius = 120 + depth * 130
        const dist = Math.max(1, Math.sqrt(node.x * node.x + node.y * node.y))
        const radial = (targetRadius - dist) * 0.0015
        node.vx += (node.x / dist) * radial
        node.vy += (node.y / dist) * radial
      }

      node.vx *= 0.86
      node.vy *= 0.86
      node.x += node.vx
      node.y += node.vy

      node.x = Math.max(-2400, Math.min(2400, node.x))
      node.y = Math.max(-2400, Math.min(2400, node.y))
    })
  }

  root.x = 0
  root.y = 0
}

function applyTransform() {
  const viewport = getEl("viewport")
  const t = state.transform
  viewport.setAttribute("transform", `translate(${t.x}, ${t.y}) scale(${t.scale})`)
}

function fitGraphToViewport() {
  if (!state.graph || !state.graph.nodes.length) return
  const { width, height } = svgSize()

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  state.graph.nodes.forEach((node) => {
    minX = Math.min(minX, node.x - node.radius)
    maxX = Math.max(maxX, node.x + node.radius)
    minY = Math.min(minY, node.y - node.radius)
    maxY = Math.max(maxY, node.y + node.radius)
  })

  const graphWidth = Math.max(1, maxX - minX)
  const graphHeight = Math.max(1, maxY - minY)
  const margin = 60
  const scale = Math.max(0.2, Math.min(1.8, Math.min(
    (width - margin) / graphWidth,
    (height - margin) / graphHeight
  )))

  state.transform.scale = scale
  state.transform.x = width / 2 - ((minX + maxX) / 2) * scale
  state.transform.y = height / 2 - ((minY + maxY) / 2) * scale
  applyTransform()
}

function worldPoint(clientX, clientY) {
  const svg = getEl("graphSvg")
  const rect = svg.getBoundingClientRect()
  const x = (clientX - rect.left - state.transform.x) / state.transform.scale
  const y = (clientY - rect.top - state.transform.y) / state.transform.scale
  return { x, y }
}

function updateGeometry() {
  const nodeById = state.renderCache.nodeById

  state.renderCache.edgeEls.forEach(({ edge, el }) => {
    const from = nodeById.get(edge.fromNodeId)
    const to = nodeById.get(edge.toNodeId)
    if (!from || !to) return

    const dx = to.x - from.x
    const dy = to.y - from.y
    const bend = Math.min(70, Math.max(-70, (Math.abs(dx) + Math.abs(dy)) * 0.08))
    const mx = (from.x + to.x) / 2
    const my = (from.y + to.y) / 2 - bend
    el.setAttribute("d", `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`)
  })

  state.renderCache.nodeEls.forEach(({ node, el }) => {
    el.setAttribute("transform", `translate(${node.x}, ${node.y})`)
  })
}

function renderGraph() {
  const graph = state.graph
  const edgeLayer = getEl("edgeLayer")
  const nodeLayer = getEl("nodeLayer")
  const empty = getEl("empty")

  edgeLayer.innerHTML = ""
  nodeLayer.innerHTML = ""
  state.renderCache.nodeById = new Map()
  state.renderCache.edgeEls = []
  state.renderCache.nodeEls = []

  if (!graph || !graph.nodes.length) {
    empty.style.display = "flex"
    return
  }

  empty.style.display = "none"

  graph.nodes.forEach((node) => state.renderCache.nodeById.set(node.id, node))

  graph.edges.forEach((edge) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.classList.add("edge")
    path.setAttribute("stroke", EDGE_COLORS[edge.type] || EDGE_COLORS.default)
    edgeLayer.appendChild(path)
    state.renderCache.edgeEls.push({ edge, el: path })
  })

  graph.nodes.forEach((node) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g")
    g.classList.add("node")
    if (node.isPickedRoot) g.classList.add("root")
    if (node.isCurrent) g.classList.add("current")
    g.dataset.nodeId = node.id

    const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle")
    halo.classList.add("halo")
    halo.setAttribute("r", String(node.radius + 7))

    const base = document.createElementNS("http://www.w3.org/2000/svg", "circle")
    base.classList.add("base")
    base.setAttribute("r", String(node.radius))

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text")
    label.setAttribute("x", String(node.radius + 6))
    label.setAttribute("y", "4")
    const labelText = `${hostOf(node.url)} · ${trunc(node.title, 16)}`
    label.textContent = labelText

    const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title")
    tooltip.textContent = [
      `标题: ${node.title || "-"}`,
      `URL: ${node.url || "-"}`,
      `首次访问: ${formatTime(node.firstSeenAt)}`,
      `最后访问: ${formatTime(node.lastSeenAt)}`,
      `访问次数: ${node.visitCount}`
    ].join("\n")

    g.appendChild(halo)
    g.appendChild(base)
    g.appendChild(label)
    g.appendChild(tooltip)

    g.addEventListener("dblclick", (event) => {
      event.stopPropagation()
      chrome.tabs.create({ url: node.url })
    })

    nodeLayer.appendChild(g)
    state.renderCache.nodeEls.push({ node, el: g })
  })

  updateGeometry()

  if (state.autoFit) {
    fitGraphToViewport()
  } else {
    applyTransform()
  }
}

function renderBreadcrumb() {
  const el = getEl("breadcrumb")
  const graph = state.graph
  if (!graph || !graph.nodes.length) {
    el.textContent = ""
    return
  }

  const current = graph.nodes.find((node) => node.isCurrent)
  const rootId = graph.rootId
  if (!current || !rootId) {
    el.textContent = "当前页未落在可视化子树中"
    return
  }

  if (current.id === rootId) {
    el.textContent = `${hostOf(current.url)} (当前根节点)`
    return
  }

  const parent = new Map()
  const queue = [rootId]
  const visited = new Set([rootId])

  while (queue.length) {
    const fromId = queue.shift()
    graph.edges.forEach((edge) => {
      if (edge.fromNodeId !== fromId) return
      if (visited.has(edge.toNodeId)) return
      visited.add(edge.toNodeId)
      parent.set(edge.toNodeId, edge.fromNodeId)
      queue.push(edge.toNodeId)
    })
  }

  if (!visited.has(current.id)) {
    el.textContent = `${hostOf(current.url)} (当前页不在所选树根下)`
    return
  }

  const path = []
  let cursor = current.id
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  while (cursor) {
    const node = byId.get(cursor)
    if (!node) break
    path.push(node)
    if (cursor === rootId) break
    cursor = parent.get(cursor)
  }

  path.reverse()
  el.innerHTML = path.map((node) => escapeHtml(hostOf(node.url))).join(" &rsaquo; ")
}

function renderStats() {
  const statsText = getEl("statsText")
  if (!state.sessionData) {
    statsText.textContent = "无会话数据"
    return
  }

  const totalNodes = state.sessionData.nodes.length
  const totalEdges = state.sessionData.edges.length
  const shownNodes = state.graph ? state.graph.nodes.length : 0
  const shownEdges = state.graph ? state.graph.edges.length : 0
  statsText.textContent = `总节点 ${totalNodes} / 展示 ${shownNodes} · 总边 ${totalEdges} / 展示 ${shownEdges}`
}

function updatePauseUI() {
  const paused = state.settings && state.settings.isPaused
  const tag = getEl("pausedTag")
  const btn = getEl("btnPause")

  tag.textContent = paused ? "已暂停" : "记录中"
  tag.style.background = paused ? "#fef3c7" : "#dff6f3"
  tag.style.color = paused ? "#92400e" : "#0f766e"

  btn.textContent = paused ? "恢复" : "暂停"
}

function rebuildGraph() {
  if (!state.sessionData) {
    state.graph = null
    renderGraph()
    renderBreadcrumb()
    renderStats()
    return
  }

  const rootSelectValue = getEl("rootSelect").value
  const selectedRootId = rootSelectValue || state.selectedRootId || ""

  state.graph = buildGraph(
    state.sessionData.nodes,
    state.sessionData.edges,
    selectedRootId,
    state.sessionData.currentNodeId,
    state.searchText
  )

  initNodePositions(state.graph)
  runForceLayout(state.graph)
  renderGraph()
  renderBreadcrumb()
  renderStats()
}

async function loadSessionData(sessionId) {
  if (!sessionId) {
    state.sessionData = { nodes: [], edges: [], currentNodeId: null }
    return
  }

  const response = await callBg("get-session-data", { sessionId })
  state.sessionData = {
    sessionId: response.sessionId,
    session: response.session,
    nodes: response.nodes || [],
    edges: response.edges || [],
    currentNodeId: response.currentNodeId || null
  }
}

async function refreshAll() {
  const dashboard = await callBg("get-dashboard")
  state.dashboard = dashboard
  state.settings = dashboard.settings

  populateSessionSelect(dashboard.sessions || [], dashboard.currentSessionId)
  updatePauseUI()

  await loadSessionData(state.selectedSessionId)
  populateRootSelect(state.sessionData.nodes, state.sessionData.edges, state.sessionData.currentNodeId)

  state.autoFit = true
  rebuildGraph()
}

function downloadJson(filename, data) {
  const content = JSON.stringify(data, null, 2)
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function onExport() {
  if (!state.selectedSessionId) return
  const response = await callBg("export-session", { sessionId: state.selectedSessionId })
  downloadJson(`${state.selectedSessionId}.json`, response.data)
}

async function onTogglePause() {
  const paused = state.settings && state.settings.isPaused
  const response = await callBg("set-paused", { isPaused: !paused })
  state.settings = response.settings
  updatePauseUI()
}

async function onNewSession() {
  await callBg("start-new-session")
  state.selectedRootId = ""
  await refreshAll()
}

function bindControls() {
  getEl("sessionSelect").addEventListener("change", async (event) => {
    state.selectedSessionId = event.target.value
    state.selectedRootId = ""
    await loadSessionData(state.selectedSessionId)
    populateRootSelect(state.sessionData.nodes, state.sessionData.edges, state.sessionData.currentNodeId)
    state.autoFit = true
    rebuildGraph()
  })

  getEl("rootSelect").addEventListener("change", (event) => {
    state.selectedRootId = event.target.value || state.selectedRootId
    state.autoFit = true
    rebuildGraph()
  })

  const debouncedSearch = debounce((value) => {
    state.searchText = value
    state.autoFit = true
    rebuildGraph()
  }, 220)

  getEl("searchInput").addEventListener("input", (event) => {
    debouncedSearch(event.target.value || "")
  })

  getEl("btnRefresh").addEventListener("click", async () => {
    await refreshAll()
  })

  getEl("btnPause").addEventListener("click", async () => {
    await onTogglePause()
  })

  getEl("btnNewSession").addEventListener("click", async () => {
    await onNewSession()
  })

  getEl("btnExport").addEventListener("click", async () => {
    await onExport()
  })
}

function bindCanvasInteractions() {
  const svg = getEl("graphSvg")

  function startPan(clientX, clientY) {
    state.interaction.mode = "pan"
    state.interaction.startX = clientX
    state.interaction.startY = clientY
    state.interaction.moved = false
  }

  function startNodeDrag(nodeId, clientX, clientY) {
    state.interaction.mode = "node"
    state.interaction.nodeId = nodeId
    state.interaction.startX = clientX
    state.interaction.startY = clientY
    state.interaction.moved = false
  }

  svg.addEventListener("wheel", (event) => {
    event.preventDefault()
    const rect = svg.getBoundingClientRect()
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const previousScale = state.transform.scale
    const nextScale = Math.max(0.15, Math.min(2.8, previousScale * (event.deltaY > 0 ? 0.9 : 1.1)))

    const wx = (mx - state.transform.x) / previousScale
    const wy = (my - state.transform.y) / previousScale

    state.transform.scale = nextScale
    state.transform.x = mx - wx * nextScale
    state.transform.y = my - wy * nextScale
    state.autoFit = false
    applyTransform()
  }, { passive: false })

  svg.addEventListener("mousedown", (event) => {
    const targetNode = event.target.closest(".node")
    if (targetNode) {
      startNodeDrag(targetNode.dataset.nodeId, event.clientX, event.clientY)
      return
    }
    startPan(event.clientX, event.clientY)
  })

  window.addEventListener("mousemove", (event) => {
    if (!state.interaction.mode) return

    const dx = event.clientX - state.interaction.startX
    const dy = event.clientY - state.interaction.startY
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      state.interaction.moved = true
    }

    if (state.interaction.mode === "pan") {
      state.transform.x += dx
      state.transform.y += dy
      state.interaction.startX = event.clientX
      state.interaction.startY = event.clientY
      state.autoFit = false
      applyTransform()
      return
    }

    if (state.interaction.mode === "node" && state.graph) {
      const point = worldPoint(event.clientX, event.clientY)
      const node = state.graph.nodes.find((item) => item.id === state.interaction.nodeId)
      if (!node) return
      node.x = point.x
      node.y = point.y
      node.vx = 0
      node.vy = 0
      state.autoFit = false
      updateGeometry()
    }
  })

  window.addEventListener("mouseup", (event) => {
    if (!state.interaction.mode) return

    const { mode, nodeId, moved } = state.interaction
    state.interaction.mode = null

    if (mode === "node" && !moved && nodeId && state.graph) {
      const node = state.graph.nodes.find((item) => item.id === nodeId)
      if (node) {
        chrome.tabs.create({ url: node.url })
      }
    }

    state.interaction.nodeId = null
    state.interaction.startX = event.clientX
    state.interaction.startY = event.clientY
  })

  window.addEventListener("resize", () => {
    if (state.autoFit) {
      fitGraphToViewport()
    } else {
      applyTransform()
    }
  })
}

async function init() {
  bindControls()
  bindCanvasInteractions()
  await refreshAll()

  const debouncedRefresh = debounce(async () => {
    try {
      await refreshAll()
    } catch (error) {
      getEl("statsText").textContent = `刷新失败: ${error.message}`
    }
  }, 350)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return
    const keys = Object.keys(changes)
    if (!keys.length) return
    debouncedRefresh()
  })
}

init().catch((error) => {
  getEl("statsText").textContent = `初始化失败: ${error.message}`
})
