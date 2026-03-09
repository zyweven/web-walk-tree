async function getStorage(keys) { return await chrome.storage.local.get(keys) }
function sessionKey(id) { return `data:${id}:session` }
function nodesKey(id) { return `data:${id}:nodes` }
function edgesKey(id) { return `data:${id}:edges` }

async function loadSessions() {
  const { sessions = [], currentSessionId } = await getStorage(["sessions", "currentSessionId"])
  const sel = document.getElementById("sessionSelect")
  sel.innerHTML = ""
  sessions.slice().reverse().forEach(s => {
    const o = document.createElement("option")
    o.value = s.id
    o.textContent = s.id
    sel.appendChild(o)
  })
  if (currentSessionId) sel.value = currentSessionId
}

function download(filename, text) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

async function exportSession() {
  const sel = document.getElementById("sessionSelect")
  const id = sel.value
  const data = await getStorage([sessionKey(id), nodesKey(id), edgesKey(id)])
  const out = { session: data[sessionKey(id)], nodes: data[nodesKey(id)] || [], edges: data[edgesKey(id)] || [] }
  const json = JSON.stringify(out, null, 2)
  document.getElementById("preview").textContent = json
  download(`${id}.json`, json)
}

document.getElementById("exportBtn").onclick = exportSession
loadSessions()