/**
 * Functions/constants needed by both the client and server.
 */

exports.DEFAULT_ANNOUNCE_PEERS = 50
exports.MAX_ANNOUNCE_PEERS = 82

exports.binaryToHex = function (str) {
  if (typeof str !== 'string') {
    str = String(str)
  }
  return Buffer.from(str, 'binary').toString('hex')
}

exports.hexToBinary = function (str) {
  if (typeof str !== 'string') {
    str = String(str)
  }
  return Buffer.from(str, 'hex').toString('binary')
}

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
exports.parseUrl = function (str) {
  const isUDP = str.match(/^udp:/)
  const parsedUrl = (isUDP) ? new URL(str.replace(/^udp:/, 'http:')) : new URL(str)

  return {
    hash: parsedUrl.hash,
    host: parsedUrl.host,
    hostname: parsedUrl.hostname,
    href: isUDP ? parsedUrl.href.replace(/^http:/, 'udp:') : parsedUrl.href,
    origin: isUDP ? parsedUrl.origin.replace(/^http:/, 'udp:') : parsedUrl.origin,
    password: parsedUrl.password,
    pathname: parsedUrl.pathname,
    port: parsedUrl.port,
    protocol: isUDP ? 'udp:' : parsedUrl.protocol,
    search: parsedUrl.search,
    username: parsedUrl.username
  }
}

const config = require('./common-node')
Object.assign(exports, config)
