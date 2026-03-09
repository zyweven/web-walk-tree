function cssPath(element) {
  if (!(element instanceof Element)) return ""

  const segments = []
  let current = element

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.nodeName.toLowerCase()
    if (current.id) {
      selector += `#${current.id}`
      segments.unshift(selector)
      break
    }

    let sibling = current
    let index = 1
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.nodeName.toLowerCase() === selector) index += 1
    }

    selector += `:nth-of-type(${index})`
    segments.unshift(selector)
    current = current.parentElement
  }

  return segments.join(" > ")
}

function findAnchor(target) {
  let current = target
  while (current && current !== document.body) {
    if (current.tagName && current.tagName.toLowerCase() === "a" && current.href) {
      return current
    }
    current = current.parentElement
  }
  return null
}

function getPageFavicon() {
  const icon = document.querySelector("link[rel~='icon']")
  return icon && icon.href ? icon.href : ""
}

function sendMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload)
  } catch (error) {
    // Ignore transient runtime errors.
  }
}

function reportIntent(event) {
  const anchor = findAnchor(event.target)
  if (!anchor || !anchor.href) return

  const anchorText = (anchor.textContent || "").trim().slice(0, 240)
  sendMessage({
    type: "link-intent",
    href: anchor.href,
    anchorText,
    domPath: cssPath(anchor)
  })
}

let lastRouteHref = location.href

function reportRouteChange(routeKind) {
  const currentHref = location.href
  if (!currentHref || currentHref === lastRouteHref) return

  sendMessage({
    type: "route-change",
    href: currentHref,
    fromHref: lastRouteHref,
    routeKind,
    title: document.title || "",
    faviconUrl: getPageFavicon()
  })

  lastRouteHref = currentHref
}

const originalPushState = history.pushState
const originalReplaceState = history.replaceState

history.pushState = function patchedPushState() {
  const result = originalPushState.apply(this, arguments)
  reportRouteChange("pushState")
  return result
}

history.replaceState = function patchedReplaceState() {
  const result = originalReplaceState.apply(this, arguments)
  reportRouteChange("replaceState")
  return result
}

window.addEventListener("popstate", () => reportRouteChange("popstate"), true)
window.addEventListener("hashchange", () => reportRouteChange("hashchange"), true)
document.addEventListener("click", reportIntent, { capture: true })
document.addEventListener("auxclick", reportIntent, { capture: true })
document.addEventListener("contextmenu", reportIntent, { capture: true })
