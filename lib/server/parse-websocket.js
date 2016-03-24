module.exports = parseWebSocketRequest

var common = require('../common')

function parseWebSocketRequest (socket, opts, params) {
  if (!opts) opts = {}
  params = JSON.parse(params) // may throw

  params.type = 'ws'
  params.socket = socket
  if (params.action === 'announce') {
    params.action = common.ACTIONS.ANNOUNCE

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
  } else if (params.action === 'scrape') {
    params.action = common.ACTIONS.SCRAPE

    if (typeof params.info_hash === 'string') params.info_hash = [ params.info_hash ]
    if (Array.isArray(params.info_hash)) {
      params.info_hash = params.info_hash.map(function (binaryInfoHash) {
        if (typeof binaryInfoHash !== 'string' || binaryInfoHash.length !== 20) {
          throw new Error('invalid info_hash')
        }
        return common.binaryToHex(binaryInfoHash)
      })
    }
  } else {
    throw new Error('invalid action in WS request: ' + params.action)
  }

  params.ip = opts.trustProxy
      ? socket.upgradeReq.headers['x-forwarded-for'] || socket.upgradeReq.connection.remoteAddress
      : socket.upgradeReq.connection.remoteAddress.replace(common.REMOVE_IPV4_MAPPED_IPV6_RE, '') // force ipv4
  params.port = socket.upgradeReq.connection.remotePort
  if (params.port) {
    params.addr = (common.IPV6_RE.test(params.ip) ? '[' + params.ip + ']' : params.ip) + ':' + params.port
  }

  params.headers = socket.upgradeReq.headers

  return params
}
