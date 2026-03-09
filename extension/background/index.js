const SESSIONS_KEY = "sessions"
const CURRENT_SESSION_KEY = "currentSessionId"
const SETTINGS_KEY = "settings"
const TAB_NODE_MAP_KEY = "tabNodeMap"
const ACTIVE_TAB_KEY = "activeTabId"

const STATIC_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".css", ".js", ".json", ".xml", ".pdf", ".zip", ".rar", ".tar", ".gz",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".mp3", ".wav", ".mp4", ".webm"
]

const DEFAULT_SETTINGS = {
  isPaused: false,
  blacklistDomains: [],
  stripHash: true,
  stripTrackingParams: true,
  intentTtlMs: 12000,
  navDedupMs: 1200
}

const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "spm", "from", "share_source", "share_from"
]

const state = {
  uidCounter: 0,
  intents: new Map(),
  newTabParents: new Map(),
  lastNavByTab: new Map(),
  tabNodeCache: null
}

function uid(prefix) {
  state.uidCounter += 1
  return `${prefix}_${Date.now()}_${state.uidCounter}`
}

function sessionKey(id) { return `data:${id}:session` }
function nodesKey(id) { return `data:${id}:nodes` }
function edgesKey(id) { return `data:${id}:edges` }

async function getStorage(keys) {
  return await chrome.storage.local.get(keys)
}

async function setStorage(obj) {
  await chrome.storage.local.set(obj)
}

async function removeStorage(keys) {
  if (chrome.storage.local.remove) {
    await chrome.storage.local.remove(keys)
    return
  }
  const patch = {}
  keys.forEach((k) => { patch[k] = undefined })
  await setStorage(patch)
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) }
  const domains = Array.isArray(merged.blacklistDomains) ? merged.blacklistDomains : []
  merged.blacklistDomains = domains
    .map((d) => String(d || "").trim().toLowerCase())
    .filter(Boolean)
  merged.intentTtlMs = Number(merged.intentTtlMs) || DEFAULT_SETTINGS.intentTtlMs
  merged.navDedupMs = Number(merged.navDedupMs) || DEFAULT_SETTINGS.navDedupMs
  return merged
}

async function getSettings() {
  const data = await getStorage([SETTINGS_KEY])
  const settings = normalizeSettings(data[SETTINGS_KEY])
  if (!data[SETTINGS_KEY]) {
    await setStorage({ [SETTINGS_KEY]: settings })
  }
  return settings
}

async function setSettings(patch) {
  const current = await getSettings()
  const next = normalizeSettings({ ...current, ...(patch || {}) })
  await setStorage({ [SETTINGS_KEY]: next })
  return next
}

function formatSessionDate(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

function createSessionId(ts) {
  const iso = new Date(ts).toISOString().replace(/[-:.TZ]/g, "")
  return `s_${iso}_${Math.floor(Math.random() * 1000)}`
}

function normalizeUrl(rawUrl, settings) {
  try {
    const url = new URL(rawUrl)
    if (settings.stripTrackingParams) {
      TRACKING_PARAMS.forEach((name) => url.searchParams.delete(name))
    }
    if (settings.stripHash) {
      url.hash = ""
    }
    const params = new URLSearchParams(url.search)
    const ordered = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    url.search = ordered.length
      ? `?${ordered.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : ""
    return url.toString()
  } catch (error) {
    return rawUrl || ""
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch (error) {
    return ""
  }
}

function isBlacklistedHost(hostname, blacklistDomains) {
  if (!hostname) return false
  return blacklistDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

function isStaticResource(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  } catch (error) {
    return true
  }
}

function shouldRecord(url, settings) {
  if (!url || (typeof url !== "string")) return false
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false
  if (isStaticResource(url)) return false
  const host = hostFromUrl(url)
  if (isBlacklistedHost(host, settings.blacklistDomains)) return false
  return true
}

function chooseTitle(existingTitle, nextTitle, fallbackUrl) {
  const cleanedNext = String(nextTitle || "").trim()
  if (cleanedNext && cleanedNext !== fallbackUrl) return cleanedNext
  const cleanedOld = String(existingTitle || "").trim()
  if (cleanedOld && cleanedOld !== fallbackUrl) return cleanedOld
  return fallbackUrl
}

function summarizeSession(session) {
  return {
    id: session.id,
    date: session.date,
    startedAt: session.startedAt,
    endedAt: session.endedAt || null,
    isPaused: !!session.isPaused,
    rootCount: Array.isArray(session.rootNodeIds) ? session.rootNodeIds.length : 0
  }
}

async function ensureTabNodeCache() {
  if (state.tabNodeCache) return
  const data = await getStorage([TAB_NODE_MAP_KEY])
  state.tabNodeCache = data[TAB_NODE_MAP_KEY] && typeof data[TAB_NODE_MAP_KEY] === "object"
    ? data[TAB_NODE_MAP_KEY]
    : {}
}

async function getTabNodeId(tabId) {
  await ensureTabNodeCache()
  return state.tabNodeCache[String(tabId)] || null
}

async function setTabNodeId(tabId, nodeId) {
  await ensureTabNodeCache()
  state.tabNodeCache[String(tabId)] = nodeId
  await setStorage({ [TAB_NODE_MAP_KEY]: state.tabNodeCache })
}

async function removeTabNodeId(tabId) {
  await ensureTabNodeCache()
  delete state.tabNodeCache[String(tabId)]
  await setStorage({ [TAB_NODE_MAP_KEY]: state.tabNodeCache })
}

async function getSessionBundle(sessionId) {
  const data = await getStorage([sessionKey(sessionId), nodesKey(sessionId), edgesKey(sessionId)])
  return {
    session: data[sessionKey(sessionId)] || null,
    nodes: Array.isArray(data[nodesKey(sessionId)]) ? data[nodesKey(sessionId)] : [],
    edges: Array.isArray(data[edgesKey(sessionId)]) ? data[edgesKey(sessionId)] : []
  }
}

async function saveSessionBundle(sessionId, bundle) {
  await setStorage({
    [sessionKey(sessionId)]: bundle.session,
    [nodesKey(sessionId)]: bundle.nodes,
    [edgesKey(sessionId)]: bundle.edges
  })
}

async function syncSessionSummary(session) {
  const data = await getStorage([SESSIONS_KEY])
  const sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  const idx = sessions.findIndex((item) => item.id === session.id)
  if (idx >= 0) {
    sessions[idx] = summarizeSession(session)
  } else {
    sessions.push(summarizeSession(session))
  }
  await setStorage({ [SESSIONS_KEY]: sessions })
}

async function ensureSession(options = {}) {
  const forceNew = !!options.forceNew
  const data = await getStorage([SESSIONS_KEY, CURRENT_SESSION_KEY])
  let sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  let currentSessionId = data[CURRENT_SESSION_KEY] || null

  if (!forceNew && currentSessionId) {
    const existing = await getStorage([sessionKey(currentSessionId)])
    if (existing[sessionKey(currentSessionId)]) {
      return existing[sessionKey(currentSessionId)]
    }
  }

  if (forceNew && currentSessionId) {
    await endCurrentSession("new-session")
    const refreshed = await getStorage([SESSIONS_KEY, CURRENT_SESSION_KEY])
    sessions = Array.isArray(refreshed[SESSIONS_KEY]) ? refreshed[SESSIONS_KEY] : []
    currentSessionId = refreshed[CURRENT_SESSION_KEY] || null
  }

  const now = Date.now()
  const id = createSessionId(now)
  const session = {
    id,
    date: formatSessionDate(now),
    startedAt: now,
    endedAt: null,
    rootNodeIds: [],
    notes: "",
    isPaused: false
  }

  sessions.push(summarizeSession(session))
  await setStorage({
    [SESSIONS_KEY]: sessions,
    [CURRENT_SESSION_KEY]: id,
    [sessionKey(id)]: session,
    [nodesKey(id)]: [],
    [edgesKey(id)]: []
  })
  return session
}

async function endCurrentSession(reason) {
  const data = await getStorage([CURRENT_SESSION_KEY])
  const currentSessionId = data[CURRENT_SESSION_KEY]
  if (!currentSessionId) return null

  const bundle = await getSessionBundle(currentSessionId)
  if (!bundle.session) {
    await setStorage({ [CURRENT_SESSION_KEY]: null })
    return null
  }

  if (!bundle.session.endedAt) {
    bundle.session.endedAt = Date.now()
  }
  if (reason && !bundle.session.notes) {
    bundle.session.notes = `ended:${reason}`
  }
  await saveSessionBundle(currentSessionId, bundle)
  await syncSessionSummary(bundle.session)
  await setStorage({ [CURRENT_SESSION_KEY]: null })
  return bundle.session
}

function inferEdgeType({ transitionType, transitionQualifiers, intent, routeKind }) {
  if (routeKind === "popstate") return "back"
  if (intent) return "click"

  const qualifiers = Array.isArray(transitionQualifiers) ? transitionQualifiers : []
  if (qualifiers.includes("server_redirect") || qualifiers.includes("client_redirect")) {
    return "redirect"
  }
  if (qualifiers.includes("forward_back")) {
    return "back"
  }

  switch (transitionType) {
    case "link":
    case "form_submit":
    case "auto_bookmark":
      return "click"
    case "keyword":
    case "keyword_generated":
      return "keyword"
    case "typed":
      return "typed"
    case "generated":
      return "typed"
    case "reload":
      return "redirect"
    default:
      return "typed"
  }
}

function shouldForceRoot(edgeType, hasIntent, openInNewTab, explicitParent) {
  if (explicitParent) return false
  if (openInNewTab) return false
  if (hasIntent) return false
  return edgeType === "typed" || edgeType === "keyword"
}

function findNodeByUrl(nodes, normalizedUrl) {
  return nodes.find((item) => item.url === normalizedUrl) || null
}

function pickIntent(tabId, frameId, rawUrl, settings) {
  const now = Date.now()
  const expected = normalizeUrl(rawUrl, settings)
  const preferredKey = `${tabId}:${frameId}`

  const keys = [preferredKey]
  for (const key of state.intents.keys()) {
    if (!key.startsWith(`${tabId}:`)) continue
    if (!keys.includes(key)) keys.push(key)
  }

  for (const key of keys) {
    const intent = state.intents.get(key)
    if (!intent) continue
    if (now - intent.ts > settings.intentTtlMs) {
      state.intents.delete(key)
      continue
    }
    const intentUrl = normalizeUrl(intent.href, settings)
    if (intentUrl !== expected) continue
    state.intents.delete(key)
    return intent
  }

  return null
}

function rememberNavigation(tabId, normalizedUrl) {
  state.lastNavByTab.set(tabId, { url: normalizedUrl, ts: Date.now() })
}

function isDuplicateNavigation(tabId, normalizedUrl, dedupeMs) {
  const previous = state.lastNavByTab.get(tabId)
  if (!previous) return false
  return previous.url === normalizedUrl && (Date.now() - previous.ts < dedupeMs)
}

function pruneMaps(settings) {
  const now = Date.now()
  for (const [key, value] of state.intents.entries()) {
    if (now - value.ts > settings.intentTtlMs) {
      state.intents.delete(key)
    }
  }
  for (const [tabId, value] of state.newTabParents.entries()) {
    if (now - value.ts > 30000) {
      state.newTabParents.delete(tabId)
    }
  }
}

function upsertNode(bundle, sessionId, nodeInput) {
  const now = Date.now()
  let node = findNodeByUrl(bundle.nodes, nodeInput.url)

  if (!node) {
    node = {
      id: uid("n"),
      url: nodeInput.url,
      title: chooseTitle("", nodeInput.title, nodeInput.url),
      faviconUrl: nodeInput.faviconUrl || "",
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1,
      sessionId,
      isRoot: !!nodeInput.isRoot
    }
    bundle.nodes.push(node)
  } else {
    node.lastSeenAt = now
    node.visitCount += 1
    node.title = chooseTitle(node.title, nodeInput.title, nodeInput.url)
    if (nodeInput.faviconUrl) {
      node.faviconUrl = nodeInput.faviconUrl
    }
    if (nodeInput.isRoot) {
      node.isRoot = true
    }
  }

  if (node.isRoot && !bundle.session.rootNodeIds.includes(node.id)) {
    bundle.session.rootNodeIds.push(node.id)
  }

  return node
}

function hasRecentEquivalentEdge(edges, edge, dedupeMs) {
  return edges.some((item) => (
    item.fromNodeId === edge.fromNodeId
    && item.toNodeId === edge.toNodeId
    && item.type === edge.type
    && edge.createdAt - item.createdAt < dedupeMs
  ))
}

function appendEdge(bundle, edgeInput, dedupeMs) {
  if (!edgeInput.fromNodeId || !edgeInput.toNodeId) return null
  if (edgeInput.fromNodeId === edgeInput.toNodeId) return null

  const edge = {
    id: uid("e"),
    fromNodeId: edgeInput.fromNodeId,
    toNodeId: edgeInput.toNodeId,
    type: edgeInput.type,
    createdAt: Date.now(),
    anchorText: edgeInput.anchorText || "",
    domPath: edgeInput.domPath || "",
    openInNewTab: !!edgeInput.openInNewTab,
    confidence: typeof edgeInput.confidence === "number" ? edgeInput.confidence : 0.8
  }

  if (hasRecentEquivalentEdge(bundle.edges, edge, dedupeMs)) {
    return null
  }

  bundle.edges.push(edge)
  return edge
}

async function resolveTabInfo(tabId, fallback) {
  const base = { title: fallback || "", faviconUrl: "" }
  if (!chrome.tabs || !chrome.tabs.get || tabId == null || tabId < 0) return base
  try {
    const tab = await chrome.tabs.get(tabId)
    return {
      title: tab && tab.title ? tab.title : base.title,
      faviconUrl: tab && tab.favIconUrl ? tab.favIconUrl : ""
    }
  } catch (error) {
    return base
  }
}

async function recordNavigation(nav) {
  const settings = await getSettings()
  pruneMaps(settings)

  if (settings.isPaused) return { recorded: false, reason: "paused" }
  if (!shouldRecord(nav.url, settings)) return { recorded: false, reason: "filtered" }

  const normalizedUrl = normalizeUrl(nav.url, settings)
  if (isDuplicateNavigation(nav.tabId, normalizedUrl, settings.navDedupMs)) {
    return { recorded: false, reason: "duplicate" }
  }

  const session = await ensureSession()
  const bundle = await getSessionBundle(session.id)
  if (!bundle.session) {
    bundle.session = session
  }

  const tabId = nav.tabId
  const frameId = typeof nav.frameId === "number" ? nav.frameId : 0

  let parentNodeId = nav.parentNodeId || null
  let openInNewTab = false

  if (!parentNodeId && typeof tabId === "number") {
    parentNodeId = await getTabNodeId(tabId)
  }

  let newTabMeta = nav.newTabMeta || null
  if (!newTabMeta && typeof tabId === "number") {
    newTabMeta = state.newTabParents.get(tabId) || null
  }
  if (newTabMeta && typeof newTabMeta.sourceTabId === "number") {
    const sourceNodeId = await getTabNodeId(newTabMeta.sourceTabId)
    if (sourceNodeId) {
      parentNodeId = sourceNodeId
      openInNewTab = true
    }
    state.newTabParents.delete(tabId)
  }

  if (nav.fromUrl) {
    const normalizedFrom = normalizeUrl(nav.fromUrl, settings)
    const parentNode = findNodeByUrl(bundle.nodes, normalizedFrom)
    if (parentNode) {
      parentNodeId = parentNode.id
    }
  }

  const intent = nav.intent || pickIntent(tabId, frameId, nav.url, settings)
  const edgeType = nav.edgeType || inferEdgeType({
    transitionType: nav.transitionType,
    transitionQualifiers: nav.transitionQualifiers,
    intent,
    routeKind: nav.routeKind
  })

  if (shouldForceRoot(edgeType, !!intent, openInNewTab, nav.parentNodeId)) {
    parentNodeId = null
  }

  const tabInfo = await resolveTabInfo(tabId, nav.title || normalizedUrl)
  const node = upsertNode(bundle, session.id, {
    url: normalizedUrl,
    title: nav.title || tabInfo.title || normalizedUrl,
    faviconUrl: nav.faviconUrl || tabInfo.faviconUrl || "",
    isRoot: !parentNodeId
  })

  let edge = null
  if (parentNodeId) {
    edge = appendEdge(bundle, {
      fromNodeId: parentNodeId,
      toNodeId: node.id,
      type: edgeType,
      anchorText: intent ? intent.anchorText : (nav.anchorText || ""),
      domPath: intent ? intent.domPath : (nav.domPath || ""),
      openInNewTab,
      confidence: intent ? 0.95 : (nav.confidence || 0.75)
    }, settings.navDedupMs)
  }

  bundle.session.isPaused = settings.isPaused
  await saveSessionBundle(session.id, bundle)
  await syncSessionSummary(bundle.session)

  if (typeof tabId === "number" && tabId >= 0) {
    await setTabNodeId(tabId, node.id)
    await setStorage({ [ACTIVE_TAB_KEY]: tabId })
  }

  rememberNavigation(tabId, normalizedUrl)
  state.intents.delete(`${tabId}:${frameId}`)

  return {
    recorded: true,
    sessionId: session.id,
    nodeId: node.id,
    edgeId: edge ? edge.id : null,
    edgeType
  }
}

async function getCurrentSessionData() {
  const data = await getStorage([CURRENT_SESSION_KEY])
  const sessionId = data[CURRENT_SESSION_KEY]
  if (!sessionId) {
    return { sessionId: null, session: null, nodes: [], edges: [] }
  }
  const bundle = await getSessionBundle(sessionId)
  return { sessionId, session: bundle.session, nodes: bundle.nodes, edges: bundle.edges }
}

async function getCurrentNodeId() {
  const data = await getStorage([ACTIVE_TAB_KEY])
  const activeTabId = data[ACTIVE_TAB_KEY]
  if (typeof activeTabId !== "number") return null
  return await getTabNodeId(activeTabId)
}

async function getDashboard() {
  const data = await getStorage([SESSIONS_KEY, CURRENT_SESSION_KEY, ACTIVE_TAB_KEY])
  const sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  const currentSessionId = data[CURRENT_SESSION_KEY] || null
  const settings = await getSettings()

  let session = null
  let nodes = []
  let edges = []
  if (currentSessionId) {
    const bundle = await getSessionBundle(currentSessionId)
    session = bundle.session
    nodes = bundle.nodes
    edges = bundle.edges
  }

  const activeTabId = typeof data[ACTIVE_TAB_KEY] === "number" ? data[ACTIVE_TAB_KEY] : null
  const currentNodeId = activeTabId == null ? null : await getTabNodeId(activeTabId)

  return {
    sessions,
    currentSessionId,
    currentSession: session,
    settings,
    activeTabId,
    currentNodeId,
    currentStats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      rootCount: nodes.filter((n) => n.isRoot).length
    }
  }
}

async function getSessionsWithStats() {
  const data = await getStorage([SESSIONS_KEY])
  const sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  const enriched = []
  for (const summary of sessions) {
    const bundle = await getSessionBundle(summary.id)
    const roots = bundle.nodes.filter((node) => node.isRoot)
    enriched.push({
      ...summary,
      nodeCount: bundle.nodes.length,
      edgeCount: bundle.edges.length,
      rootCount: roots.length
    })
  }
  return enriched.sort((a, b) => b.startedAt - a.startedAt)
}

async function clearAllData() {
  const data = await getStorage([SESSIONS_KEY, CURRENT_SESSION_KEY])
  const sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  const keysToRemove = [SESSIONS_KEY, CURRENT_SESSION_KEY, TAB_NODE_MAP_KEY, ACTIVE_TAB_KEY]
  sessions.forEach((session) => {
    keysToRemove.push(sessionKey(session.id), nodesKey(session.id), edgesKey(session.id))
  })
  await removeStorage(keysToRemove)
  state.tabNodeCache = {}
  state.intents.clear()
  state.newTabParents.clear()
  state.lastNavByTab.clear()
  await ensureSession({ forceNew: true })
  return { ok: true }
}

async function deleteSession(sessionId) {
  if (!sessionId) return { ok: false, error: "missing-session-id" }

  const data = await getStorage([SESSIONS_KEY, CURRENT_SESSION_KEY])
  const sessions = Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : []
  const nextSessions = sessions.filter((item) => item.id !== sessionId)

  await removeStorage([sessionKey(sessionId), nodesKey(sessionId), edgesKey(sessionId)])
  if (data[CURRENT_SESSION_KEY] === sessionId) {
    await setStorage({ [CURRENT_SESSION_KEY]: null })
  }
  await setStorage({ [SESSIONS_KEY]: nextSessions })

  const refreshed = await getStorage([CURRENT_SESSION_KEY])
  if (!refreshed[CURRENT_SESSION_KEY]) {
    await ensureSession({ forceNew: true })
  }

  return { ok: true }
}

async function exportSession(sessionId) {
  let target = sessionId
  if (!target) {
    const data = await getStorage([CURRENT_SESSION_KEY])
    target = data[CURRENT_SESSION_KEY] || null
  }
  if (!target) {
    return { ok: false, error: "no-session" }
  }

  const bundle = await getSessionBundle(target)
  return {
    ok: true,
    sessionId: target,
    data: {
      session: bundle.session,
      nodes: bundle.nodes,
      edges: bundle.edges
    }
  }
}

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return { ok: false, error: "invalid-message" }

  switch (msg.type) {
    case "link-intent": {
      if (!sender || !sender.tab || typeof sender.frameId !== "number") {
        return { ok: false, error: "invalid-sender" }
      }
      const key = `${sender.tab.id}:${sender.frameId}`
      state.intents.set(key, {
        href: msg.href,
        anchorText: msg.anchorText || "",
        domPath: msg.domPath || "",
        ts: Date.now()
      })
      return { ok: true }
    }

    case "route-change": {
      if (!sender || !sender.tab) return { ok: false, error: "invalid-sender" }
      const result = await recordNavigation({
        tabId: sender.tab.id,
        frameId: typeof sender.frameId === "number" ? sender.frameId : 0,
        url: msg.href,
        fromUrl: msg.fromHref || "",
        routeKind: msg.routeKind || "route",
        transitionType: "link",
        title: msg.title || "",
        faviconUrl: msg.faviconUrl || "",
        confidence: 0.7
      })
      return { ok: true, ...result }
    }

    case "ensure-session": {
      const session = await ensureSession()
      return { ok: true, sessionId: session.id }
    }

    case "start-new-session": {
      const session = await ensureSession({ forceNew: true })
      return { ok: true, sessionId: session.id }
    }

    case "set-paused": {
      const next = await setSettings({ isPaused: !!msg.isPaused })
      const current = await getStorage([CURRENT_SESSION_KEY])
      if (current[CURRENT_SESSION_KEY]) {
        const bundle = await getSessionBundle(current[CURRENT_SESSION_KEY])
        if (bundle.session) {
          bundle.session.isPaused = next.isPaused
          await saveSessionBundle(current[CURRENT_SESSION_KEY], bundle)
          await syncSessionSummary(bundle.session)
        }
      }
      return { ok: true, settings: next }
    }

    case "toggle-paused": {
      const settings = await getSettings()
      const next = await setSettings({ isPaused: !settings.isPaused })
      return { ok: true, settings: next }
    }

    case "get-settings": {
      const settings = await getSettings()
      return { ok: true, settings }
    }

    case "update-settings": {
      const next = await setSettings(msg.settings || {})
      return { ok: true, settings: next }
    }

    case "get-dashboard": {
      const dashboard = await getDashboard()
      return { ok: true, ...dashboard }
    }

    case "get-sessions": {
      const sessions = await getSessionsWithStats()
      return { ok: true, sessions }
    }

    case "get-session-data": {
      let targetId = msg.sessionId || null
      if (!targetId) {
        const data = await getStorage([CURRENT_SESSION_KEY])
        targetId = data[CURRENT_SESSION_KEY] || null
      }
      if (!targetId) return { ok: true, sessionId: null, session: null, nodes: [], edges: [], currentNodeId: null }

      const bundle = await getSessionBundle(targetId)
      const currentNodeId = await getCurrentNodeId()
      return {
        ok: true,
        sessionId: targetId,
        session: bundle.session,
        nodes: bundle.nodes,
        edges: bundle.edges,
        currentNodeId
      }
    }

    case "export-session": {
      return await exportSession(msg.sessionId || null)
    }

    case "delete-session": {
      return await deleteSession(msg.sessionId)
    }

    case "clear-all-data": {
      return await clearAllData()
    }

    // Legacy API compatibility
    case "get-data": {
      const current = await getCurrentSessionData()
      return { ok: true, nodes: current.nodes, edges: current.edges }
    }

    case "clear-data": {
      return await clearAllData()
    }

    default:
      return { ok: false, error: `unknown-type:${msg.type}` }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }))
  return true
})

chrome.runtime.onInstalled.addListener(() => {
  ensureSession().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => {
  ensureSession({ forceNew: true }).catch(() => {})
})

chrome.windows.onRemoved.addListener(async () => {
  if (!chrome.windows || !chrome.windows.getAll) return
  try {
    const all = await chrome.windows.getAll()
    if (Array.isArray(all) && all.length === 0) {
      await endCurrentSession("all-windows-closed")
    }
  } catch (error) {
    // ignore
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabNodeId(tabId).catch(() => {})
})

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await setStorage({ [ACTIVE_TAB_KEY]: activeInfo.tabId })
})

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  state.newTabParents.set(details.tabId, {
    sourceTabId: details.sourceTabId,
    sourceFrameId: details.sourceFrameId,
    ts: Date.now()
  })
})

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return
  if (details.tabId < 0) return
  if (details.transitionType === "auto_subframe" || details.transitionType === "manual_subframe") return

  recordNavigation({
    tabId: details.tabId,
    frameId: details.frameId,
    url: details.url,
    transitionType: details.transitionType,
    transitionQualifiers: details.transitionQualifiers || []
  }).catch(() => {})
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return

  recordNavigation({
    tabId,
    frameId: 0,
    url: changeInfo.url,
    transitionType: "typed",
    title: tab && tab.title ? tab.title : "",
    faviconUrl: tab && tab.favIconUrl ? tab.favIconUrl : "",
    confidence: 0.65
  }).catch(() => {})
})
