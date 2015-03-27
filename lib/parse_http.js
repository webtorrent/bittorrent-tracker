module.exports = parseHttpRequest

var common = require('./common')

var REMOVE_IPV4_MAPPED_IPV6_RE = /^::ffff:/

function parseHttpRequest (req, opts) {
  if (!opts) opts = {}
  var s = req.url.split('?')
  var params = common.querystringParse(s[1])

  if (opts.action === 'announce' || s[0] === '/announce') {
    params.action = common.ACTIONS.ANNOUNCE

    if (typeof params.info_hash !== 'string' || params.info_hash.length !== 20) {
      throw new Error('invalid info_hash')
    }
    params.info_hash = common.binaryToHex(params.info_hash)

    if (typeof params.peer_id !== 'string' || params.peer_id.length !== 20) {
      throw new Error('invalid peer_id')
    }
    params.peer_id = common.binaryToHex(params.peer_id)

    params.port = Number(params.port)
    if (!params.port) throw new Error('invalid port')

    params.left = Number(params.left) || Infinity
    params.compact = Number(params.compact) || 0
    params.numwant = Math.min(
      Number(params.numwant) || common.DEFAULT_ANNOUNCE_PEERS,
      common.MAX_ANNOUNCE_PEERS
    )

    params.ip = opts.trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress.replace(REMOVE_IPV4_MAPPED_IPV6_RE, '') // force ipv4
    params.addr = (common.IPV6_RE.test(params.ip) ? '[' + params.ip + ']' : params.ip) + ':' + params.port
  } else if (opts.action === 'scrape' || s[0] === '/scrape') {
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
    throw new Error('invalid action in HTTP request: ' + params.action)
  }

  return params
}
