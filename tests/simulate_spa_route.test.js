const fs = require('fs')
const vm = require('vm')

function createEvent(){ const listeners=[]; return { addListener: fn=>listeners.push(fn), _trigger: (...a)=>listeners.forEach(fn=>fn(...a)) } }

const mem={ sessions: [] }

const chrome = {
  storage: { local: { async get(keys){ const out={}; keys.forEach(k=>out[k]=mem[k]); return out }, async set(obj){ Object.assign(mem,obj) } } },
  runtime: { onStartup: createEvent(), onInstalled: createEvent(), onMessage: createEvent(), sendMessage(){} },
  windows: { onRemoved: createEvent(), async getAll(){ return [] } },
  webNavigation: { onCreatedNavigationTarget: createEvent(), onCommitted: createEvent() },
  tabs: { onUpdated: createEvent(), onActivated: createEvent(), async get(id){ const t=mem._tabs[id]||{}; return { id, url:t.url||'', title:t.title||'', favIconUrl:'' } }, async query(){ return [] } },
  sidePanel: { async setOptions(){}, async open(){} }
}

const code = fs.readFileSync('extension/background/index.js', 'utf8')
vm.runInNewContext(code, { console, setTimeout, clearTimeout, URL, chrome })

function d(ms){ return new Promise(r=>setTimeout(r,ms)) }

async function main(){
  chrome.runtime.onInstalled._trigger()
  await d(10)
  mem._tabs = { 3: { url: 'https://spa.example.com/', title: 'SPA' } }
  chrome.tabs.onUpdated._trigger(3, { url: 'https://spa.example.com/' }, { id: 3, url: 'https://spa.example.com/', title: 'SPA', favIconUrl: '' })
  await d(50)
  chrome.runtime.onMessage._trigger({ type: 'route-change', href: 'https://spa.example.com/page1' }, { tab: { id: 3 }, frameId: 0 }, () => {})
  await d(10)
  const sid = mem.currentSessionId
  const nodes = mem[`data:${sid}:nodes`]||[]
  const edges = mem[`data:${sid}:edges`]||[]
  console.log('nodes', nodes.length, nodes.map(n=>n.url))
  console.log('edges', edges.length)
}

main()