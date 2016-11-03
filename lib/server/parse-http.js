module.exports = parseHttpRequest

var common = require('../common')

function parseHttpRequest (req, opts) {
  if (!opts) opts = {}
  var s = req.url.split('?')
  var params = common.querystringParse(s[1])
  params.type = 'http'

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

    // If we're trusting IPs supplied in the GET parameters, simply use that if available
    if (opts.trustIp && params.ip) {
      // No operation needed
    // Else, if we're trusting proxied headers, use that value if available,
    } else if (opts.trustProxy && req.headers['x-forwarded-for']) {
      params.ip = req.headers['x-forwarded-for']
    // Otherwise, simply use the connection's remote host address.
    } else {
      params.ip = req.connection.remoteAddress
        // Remove IPv4-Mapped address prefix from IPv6 address if present
        .replace(common.REMOVE_IPV4_MAPPED_IPV6_RE, '')
    }
    params.addr = (common.IPV6_RE.test(params.ip) ? '[' + params.ip + ']' : params.ip) + ':' + params.port

    params.headers = req.headers
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
    throw new Error('invalid action in HTTP request: ' + req.url)
  }

  return params
}
