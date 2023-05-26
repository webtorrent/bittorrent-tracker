/**
 * Functions/constants needed by both the client and server.
 */
import * as common from './common-node.js'
export * from './common-node.js'

export const DEFAULT_ANNOUNCE_PEERS = 50
export const MAX_ANNOUNCE_PEERS = 82

// HACK: Fix for WHATWG URL object not parsing non-standard URL schemes like
// 'udp:'. Just replace it with 'http:' since we only need a few properties.
//
// Note: Only affects Chrome and Firefox. Works fine in Node.js, Safari, and
// Edge.
//
// Note: UDP trackers aren't used in the normal browser build, but they are
// used in a Chrome App build (i.e. by Brave Browser).
//
// Bug reports:
// - Chrome: https://bugs.chromium.org/p/chromium/issues/detail?id=734880
// - Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1374505
export const parseUrl = str => {
  const url = new URL(str.replace(/^udp:/, 'http:'))

  if (str.match(/^udp:/)) {
    Object.defineProperties(url, {
      href: { value: url.href.replace(/^http/, 'udp') },
      protocol: { value: url.protocol.replace(/^http/, 'udp') },
      origin: { value: url.origin.replace(/^http/, 'udp') }
    })
  }

  return url
}

export default {
  DEFAULT_ANNOUNCE_PEERS,
  MAX_ANNOUNCE_PEERS,
  parseUrl,
  ...common
}
