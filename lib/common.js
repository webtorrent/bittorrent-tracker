/**
 * Functions/constants needed by both the client and server.
 */

var querystring = require('querystring')

exports.IPV4_RE = /^[\d\.]+$/
exports.IPV6_RE = /^[\da-fA-F:]+$/

exports.NUM_ANNOUNCE_PEERS = 50
exports.MAX_ANNOUNCE_PEERS = 82

exports.CONNECTION_ID = Buffer.concat([ toUInt32(0x417), toUInt32(0x27101980) ])
exports.ACTIONS = { CONNECT: 0, ANNOUNCE: 1, SCRAPE: 2, ERROR: 3 }
exports.EVENTS = { update: 0, completed: 1, started: 2, stopped: 3 }
exports.EVENT_IDS = {
  0: 'update',
  1: 'completed',
  2: 'started',
  3: 'stopped'
}
exports.EVENT_NAMES = {
  update: 'update',
  completed: 'complete',
  started: 'start',
  stopped: 'stop'
}

function toUInt32 (n) {
  var buf = new Buffer(4)
  buf.writeUInt32BE(n, 0)
  return buf
}
exports.toUInt32 = toUInt32

exports.binaryToHex = function (str) {
  return new Buffer(str, 'binary').toString('hex')
}

exports.hexToBinary = function (str) {
  return new Buffer(str, 'hex').toString('binary')
}

/**
 * `querystring.parse` using `unescape` instead of decodeURIComponent, since bittorrent
 * clients send non-UTF8 querystrings
 * @param  {string} q
 * @return {Object}
 */
exports.querystringParse = function (q) {
  var saved = querystring.unescape
  querystring.unescape = unescape // global
  var ret = querystring.parse(q)
  querystring.unescape = saved
  return ret
}

/**
 * `querystring.stringify` using `escape` instead of encodeURIComponent, since bittorrent
 * clients send non-UTF8 querystrings
 * @param  {Object} obj
 * @return {string}
 */
exports.querystringStringify = function (obj) {
  var saved = querystring.escape
  querystring.escape = escape // global
  var ret = querystring.stringify(obj)
  ret = ret.replace(/[\@\*\/\+]/g, function (char) {
    // `escape` doesn't encode the characters @*/+ so we do it manually
    return '%' + char.charCodeAt(0).toString(16).toUpperCase()
  })
  querystring.escape = saved
  return ret
}
