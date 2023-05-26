import { bin2hex } from 'uint8-util'

import common from '../common.js'

export default function (socket, opts, params) {
  if (!opts) opts = {}
  params = JSON.parse(params) // may throw

  params.type = 'ws'
  params.socket = socket
  if (params.action === 'announce') {
    params.action = common.ACTIONS.ANNOUNCE

    if (typeof params.info_hash !== 'string' || params.info_hash.length !== 20) {
      throw new Error('invalid info_hash')
    }
    params.info_hash = bin2hex(params.info_hash)

    if (typeof params.peer_id !== 'string' || params.peer_id.length !== 20) {
      throw new Error('invalid peer_id')
    }
    params.peer_id = bin2hex(params.peer_id)

    if (params.answer) {
      if (typeof params.to_peer_id !== 'string' || params.to_peer_id.length !== 20) {
        throw new Error('invalid `to_peer_id` (required with `answer`)')
      }
      params.to_peer_id = bin2hex(params.to_peer_id)
    }

    params.left = Number(params.left)
    if (Number.isNaN(params.left)) params.left = Infinity

    params.numwant = Math.min(
      Number(params.offers && params.offers.length) || 0, // no default - explicit only
      common.MAX_ANNOUNCE_PEERS
    )
    params.compact = -1 // return full peer objects (used for websocket responses)
  } else if (params.action === 'scrape') {
    params.action = common.ACTIONS.SCRAPE

    if (typeof params.info_hash === 'string') params.info_hash = [params.info_hash]
    if (Array.isArray(params.info_hash)) {
      params.info_hash = params.info_hash.map(binaryInfoHash => {
        if (typeof binaryInfoHash !== 'string' || binaryInfoHash.length !== 20) {
          throw new Error('invalid info_hash')
        }
        return bin2hex(binaryInfoHash)
      })
    }
  } else {
    throw new Error(`invalid action in WS request: ${params.action}`)
  }

  // On first parse, save important data from `socket.upgradeReq` and delete it
  // to reduce memory usage.
  if (socket.upgradeReq) {
    if (opts.trustProxy) {
      if (socket.upgradeReq.headers['x-forwarded-for']) {
        const [realIp] = socket.upgradeReq.headers['x-forwarded-for'].split(',')
        socket.ip = realIp.trim()
      } else {
        socket.ip = socket.upgradeReq.connection.remoteAddress
      }
    } else {
      socket.ip = socket.upgradeReq.connection.remoteAddress.replace(common.REMOVE_IPV4_MAPPED_IPV6_RE, '') // force ipv4
    }

    socket.port = socket.upgradeReq.connection.remotePort
    if (socket.port) {
      socket.addr = `${common.IPV6_RE.test(socket.ip) ? `[${socket.ip}]` : socket.ip}:${socket.port}`
    }

    socket.headers = socket.upgradeReq.headers

    // Delete `socket.upgradeReq` when it is no longer needed to reduce memory usage
    socket.upgradeReq = null
  }

  params.ip = socket.ip
  params.port = socket.port
  params.addr = socket.addr
  params.headers = socket.headers

  return params
}
