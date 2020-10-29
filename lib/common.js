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

const config = require('./common-node')
Object.assign(exports, config)
