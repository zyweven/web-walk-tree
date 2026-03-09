function cssPath(el) {
  if (!(el instanceof Element)) return ""
  const path = []
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.nodeName.toLowerCase()
    if (el.id) {
      selector += `#${el.id}`
      path.unshift(selector)
      break
    } else {
      let sib = el, nth = 1
      while (sib = sib.previousElementSibling) {
        if (sib.nodeName.toLowerCase() === selector) nth++
      }
      selector += `:nth-of-type(${nth})`
    }
    path.unshift(selector)
    el = el.parentElement
  }
  return path.join(" > ")
}

function getAnchor(target) {
  let el = target
  while (el && el !== document.body) {
    if (el.tagName && el.tagName.toLowerCase() === "a" && el.href) return el
    el = el.parentElement
  }
  return null
}

function reportIntent(e) {
  const a = getAnchor(e.target)
  if (!a || !a.href) return
  const href = a.href
  const anchorText = (a.textContent || "").trim().slice(0, 200)
  const domPath = cssPath(a)
  chrome.runtime.sendMessage({ type: "link-intent", href, anchorText, domPath })
}

document.addEventListener("click", reportIntent, { capture: true })
document.addEventListener("auxclick", reportIntent, { capture: true })

function reportRoute() {
  try {
    chrome.runtime.sendMessage({ type: "route-change", href: location.href })
  } catch (e) {}
}

const _pushState = history.pushState
const _replaceState = history.replaceState
history.pushState = function() { _pushState.apply(this, arguments); reportRoute() }
history.replaceState = function() { _replaceState.apply(this, arguments); reportRoute() }
window.addEventListener("popstate", reportRoute)