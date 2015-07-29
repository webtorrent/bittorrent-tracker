module.exports = parseWebSocketRequest

var common = require('../common')

function parseWebSocketRequest (socket, params) {
  params = JSON.parse(params) // may throw

  params.action = common.ACTIONS.ANNOUNCE
  params.socket = socket

  if (typeof params.info_hash !== 'string' || params.info_hash.length !== 20) {
    throw new Error('invalid info_hash')
  }
  params.info_hash = common.binaryToHex(params.info_hash)

  if (typeof params.peer_id !== 'string' || params.peer_id.length !== 20) {
    throw new Error('invalid peer_id')
  }
  params.peer_id = common.binaryToHex(params.peer_id)

  if (params.answer) {
    if (typeof params.to_peer_id !== 'string' || params.to_peer_id.length !== 20) {
      throw new Error('invalid `to_peer_id` (required with `answer`)')
    }
    params.to_peer_id = common.binaryToHex(params.to_peer_id)
  }

  params.left = Number(params.left) || Infinity
  params.numwant = Math.min(
    Number(params.offers && params.offers.length) || 0, // no default - explicit only
    common.MAX_ANNOUNCE_PEERS
  )
  params.compact = -1 // return full peer objects (used for websocket responses)

  return params
}
