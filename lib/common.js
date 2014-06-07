/**
 * Functions and constants needed by both the tracker client and server.
 */

function toUInt32 (n) {
  var buf = new Buffer(4)
  buf.writeUInt32BE(n, 0)
  return buf
}
exports.toUInt32 = toUInt32

exports.CONNECTION_ID = Buffer.concat([ toUInt32(0x417), toUInt32(0x27101980) ])
exports.ACTIONS = { CONNECT: 0, ANNOUNCE: 1, SCRAPE: 2, ERROR: 3 }
exports.EVENTS = { update: 0, completed: 1, started: 2, stopped: 3 }
