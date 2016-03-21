module.exports = parseUdpRequest

var bufferEquals = require('buffer-equals')
var ipLib = require('ip')
var extend = require('xtend/mutable')
var varstruct = require('varstruct')
var common = require('../common')

var defaultParams = { type: 'udp' }
var structParams = varstruct([
  { name: 'connectionId', type: varstruct.Buffer(8) },
  { name: 'action', type: varstruct.UInt32BE },
  { name: 'transactionId', type: varstruct.UInt32BE }
])

/**
 * Return the closest floating-point representation to the buffer value. Precision will be
 * lost for big numbers.
 */
var TWO_PWR_32 = (1 << 16) * 2
function decodeUInt64 (buffer, offset) {
  var high = buffer.readUInt32BE(offset) | 0 // force
  var low = buffer.readUInt32BE(offset + 4) | 0
  var lowUnsigned = (low >= 0) ? low : TWO_PWR_32 + low
  return high * TWO_PWR_32 + lowUnsigned
}
decodeUInt64.bytes = 8
function noop () {}
var UInt64 = { encode: noop, decode: decodeUInt64, encodingLength: noop }

var structAnnounce = varstruct([
  { name: 'info_hash', type: varstruct.String(20, 'hex') },
  { name: 'peer_id', type: varstruct.String(20, 'hex') },
  { name: 'downloaded', type: UInt64 },
  { name: 'left', type: UInt64 },
  { name: 'uploaded', type: UInt64 },
  { name: 'event', type: varstruct.UInt32BE },
  { name: 'ip', type: varstruct.UInt32BE },
  { name: 'key', type: varstruct.UInt32BE },
  { name: 'numwant', type: varstruct.UInt32BE },
  { name: 'port', type: varstruct.UInt16BE }
])

function parseUdpRequest (msg, rinfo) {
  if (msg.length < 16) throw new Error('received packet is too short')

  var params = extend(defaultParams, structParams.decode(msg))
  if (!bufferEquals(params.connectionId, common.CONNECTION_ID)) {
    throw new Error('received packet with invalid connection id')
  }

  if (params.action === common.ACTIONS.CONNECT) {
    // No further params
  } else if (params.action === common.ACTIONS.ANNOUNCE) {
    var data = structAnnounce.decode(msg, 16)

    params.info_hash = data.info_hash
    params.peer_id = data.peer_id
    params.downloaded = data.downloaded // TODO: track this?
    params.left = data.left
    params.uploaded = data.uploaded // TODO: track this?

    params.event = common.EVENT_IDS[data.event]
    if (!params.event) throw new Error('invalid event') // early return

    params.ip = data.ip
      ? ipLib.toString(data.ip)
      : rinfo.address

    params.key = data.key // Optional: unique random key from client

    // never send more than MAX_ANNOUNCE_PEERS or else the UDP packet will get bigger than
    // 512 bytes which is not safe
    params.numwant = Math.min(
      data.numwant || common.DEFAULT_ANNOUNCE_PEERS, // optional
      common.MAX_ANNOUNCE_PEERS
    )

    params.port = data.port || rinfo.port // optional
    params.addr = params.ip + ':' + params.port // TODO: ipv6 brackets
    params.compact = 1 // udp is always compact
  } else if (params.action === common.ACTIONS.SCRAPE) { // scrape message
    if ((msg.length - 16) % 20 !== 0) throw new Error('invalid scrape message')
    var codec = varstruct.Array((msg.length - 16) / 20, varstruct.String(20, 'hex'))
    params.info_hash = codec.decode(msg, 16)
  } else {
    throw new Error('Invalid action in UDP packet: ' + params.action)
  }

  return params
}
