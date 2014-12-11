var common = require('./common')

var REMOVE_IPV6_RE = /^::ffff:/

module.exports = parseHttpRequest

function parseHttpRequest (req, options) {
  var s = req.url.split('?')
  var params = common.querystringParse(s[1])

  if (s[0] === '/announce') {
    params.action = common.ACTIONS.ANNOUNCE
    
    params.peer_id = typeof params.peer_id === 'string' && common.binaryToUtf8(params.peer_id)
    params.port = Number(params.port)

    if (typeof params.info_hash !== 'string') throw new Error('invalid info_hash')
    if (params.info_hash.length !== 20) throw new Error('invalid info_hash length')
    if (typeof params.peer_id !== 'string') throw new Error('invalid peer_id')
    if (params.peer_id.length !== 20) throw new Error('invalid peer_id length')
    if (!params.port) throw new Error('invalid port')

    params.left = Number(params.left)
    params.compact = Number(params.compact)

    params.ip = options.trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress.replace(REMOVE_IPV6_RE, '') // force ipv4
    params.addr = params.ip + ':' + params.port // TODO: ipv6 brackets?

    params.numwant = Math.min(
      Number(params.numwant) || common.NUM_ANNOUNCE_PEERS,
      common.MAX_ANNOUNCE_PEERS
    )

    return params
  } else if (s[0] === '/scrape') { // unofficial scrape message
    params.action = common.ACTIONS.SCRAPE

    if (typeof params.info_hash === 'string') {
      params.info_hash = [ params.info_hash ]
    }

    if (params.info_hash) {
      if (!Array.isArray(params.info_hash)) throw new Error('invalid info_hash array')

      params.info_hash.forEach(function (infoHash) {
        if (infoHash.length !== 20) {
          throw new Error('invalid info_hash')
        }
      })
    }

    return params
  } else {
    return null
  }
}
