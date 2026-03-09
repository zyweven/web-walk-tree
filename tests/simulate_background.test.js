const fs = require('fs')
const vm = require('vm')

function createEvent() {
  const listeners = []
  return { addListener: fn => listeners.push(fn), _trigger: (...args) => listeners.forEach(fn => fn(...args)) }
}

const mem = {}

const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          const out = {}
          keys.forEach(k => { out[k] = mem[k] })
          return out
        }
        return { [keys]: mem[keys] }
      },
      async set(obj) {
        Object.assign(mem, obj)
      }
    }
  },
  runtime: {
    onStartup: createEvent(),
    onInstalled: createEvent(),
    onMessage: createEvent(),
    sendMessage() {},
  },
  windows: { onRemoved: createEvent(), async getAll() { return [] } },
  webNavigation: { onCreatedNavigationTarget: createEvent(), onCommitted: createEvent() },
  tabs: {
    onUpdated: createEvent(),
    onActivated: createEvent(),
    async get(id) { return { id, url: mem._tabs && mem._tabs[id] && mem._tabs[id].url || '', title: mem._tabs && mem._tabs[id] && mem._tabs[id].title || '', favIconUrl: '' } },
    async query() { return [] }
  },
  sidePanel: { async setOptions() {}, async open() {} }
}

mem.sessions = []

const code = fs.readFileSync('extension/background/index.js', 'utf8')
vm.runInNewContext(code, { console, setTimeout, clearTimeout, URL, chrome })

const delay = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  chrome.runtime.onInstalled._trigger()
  await delay(10)
  const sender = { tab: { id: 1 }, frameId: 0 }
  mem._tabs = { 1: { url: 'https://example.com/', title: 'Home' } }
  chrome.tabs.onUpdated._trigger(1, { url: 'https://example.com/' }, { id: 1, url: 'https://example.com/', title: 'Home', favIconUrl: '' })
  await delay(50)
  chrome.runtime.onMessage._trigger({ type: 'link-intent', href: 'https://example.com/a', anchorText: 'A', domPath: 'a:nth-of-type(1)' }, sender, () => {})
  mem._tabs[1] = { url: 'https://example.com/a', title: 'Page A' }
  chrome.tabs.onUpdated._trigger(1, { url: 'https://example.com/a' }, { id: 1, url: 'https://example.com/a', title: 'Page A', favIconUrl: '' })
  await delay(10)
  const sid = mem.currentSessionId
  const nodes = mem[`data:${sid}:nodes`] || []
  const edges = mem[`data:${sid}:edges`] || []
  console.log('session', sid)
  console.log('nodes', nodes.length, nodes.map(n => n.url))
  console.log('edges', edges.length, edges.map(e => [e.type, e.fromNodeId, e.toNodeId]))
}

main()