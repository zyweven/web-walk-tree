const fs = require('fs')
const vm = require('vm')

function createEvent() {
  const listeners = []
  return { addListener: fn => listeners.push(fn), _trigger: (...args) => listeners.forEach(fn => fn(...args)) }
}

const mem = {}

const chrome = {
  storage: { local: { async get(keys){ const out={}; keys.forEach(k=>out[k]=mem[k]); return out }, async set(obj){ Object.assign(mem,obj) } } },
  runtime: { onStartup: createEvent(), onInstalled: createEvent(), onMessage: createEvent(), sendMessage(){} },
  windows: { onRemoved: createEvent(), async getAll(){ return [] } },
  webNavigation: { onCreatedNavigationTarget: createEvent(), onCommitted: createEvent() },
  tabs: { onUpdated: createEvent(), onActivated: createEvent(), async get(id){ const t=mem._tabs[id]||{}; return { id, url:t.url||'', title:t.title||'', favIconUrl:'' } }, async query(){ return [] } },
  sidePanel: { async setOptions(){}, async open(){} }
}

mem.sessions = []

const code = fs.readFileSync('extension/background/index.js', 'utf8')
vm.runInNewContext(code, { console, setTimeout, clearTimeout, URL, chrome })

function d(ms){ return new Promise(r=>setTimeout(r,ms)) }

async function main(){
  chrome.runtime.onInstalled._trigger()
  await d(10)
  mem._tabs = { 1: { url: 'https://example.com/', title: 'Home' } }
  chrome.tabs.onUpdated._trigger(1, { url: 'https://example.com/' }, { id: 1, url: 'https://example.com/', title: 'Home', favIconUrl: '' })
  await d(50)
  chrome.webNavigation.onCreatedNavigationTarget._trigger({ sourceTabId: 1, sourceFrameId: 0, tabId: 2 })
  mem._tabs[2] = { url: 'https://example.com/b', title: 'Page B' }
  chrome.tabs.onUpdated._trigger(2, { url: 'https://example.com/b' }, { id: 2, url: 'https://example.com/b', title: 'Page B', favIconUrl: '' })
  await d(10)
  const sid = mem.currentSessionId
  const nodes = mem[`data:${sid}:nodes`]||[]
  const edges = mem[`data:${sid}:edges`]||[]
  console.log('nodes', nodes.length, nodes.map(n=>n.url))
  console.log('edges', edges.length, edges.map(e=>[e.type, e.openInNewTab]))
}

main()