module.exports = Server

var bencode = require('bencode')
var debug = require('debug')('bittorrent-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var series = require('run-series')
var string2compact = require('string2compact')
var WebSocketServer = require('ws').Server

var common = require('./lib/common')
var Swarm = require('./lib/swarm')
var parseHttpRequest = require('./lib/parse_http')
var parseUdpRequest = require('./lib/parse_udp')
var parseWebSocketRequest = require('./lib/parse_websocket')

inherits(Server, EventEmitter)

/**
 * BitTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.interval   tell clients to announce on this interval (ms)
 * @param {Number}  opts.trustProxy trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       start an http server? (default: true)
 * @param {boolean} opts.udp        start a udp server? (default: true)
 * @param {boolean} opts.ws         start a websocket server? (default: true)
 * @param {function} opts.filter    black/whitelist fn for disallowing/allowing torrents
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  if (!opts) opts = {}

  debug('new server %s', JSON.stringify(opts))

  self._intervalMs = opts.interval
    ? opts.interval
    : 10 * 60 * 1000 // 10 min

  self._trustProxy = !!opts.trustProxy
  if (typeof opts.filter === 'function') self._filter = opts.filter

  self.listening = false
  self.torrents = {}

  self.http = null
  self.udp = null
  self.ws = null

  // start an http tracker unless the user explictly says no
  if (opts.http !== false) {
    self.http = http.createServer()
    self.http.on('request', self.onHttpRequest.bind(self))
    self.http.on('error', self._onError.bind(self))
    self.http.on('listening', onListening)
  }

  // start a udp tracker unless the user explicitly says no
  if (opts.udp !== false) {
    self.udp = dgram.createSocket('udp4')
    self.udp.on('message', self.onUdpRequest.bind(self))
    self.udp.on('error', self._onError.bind(self))
    self.udp.on('listening', onListening)
  }

  // start a websocket tracker (for WebTorrent) unless the user explicitly says no
  if (opts.ws === true) {
    if (!self.http) {
      self.http = http.createServer()
      self.http.on('error', self._onError.bind(self))
      self.http.on('listening', onListening)
    }
    self.ws = new WebSocketServer({ server: self.http })
    self.ws.on('error', self._onError.bind(self))
    self.ws.on('connection', self.onWebSocketConnection.bind(self))
  }

  var num = !!(self.http || self.ws) + !!self.udp
  function onListening () {
    num -= 1
    if (num === 0) {
      self.listening = true
      debug('listening')
      self.emit('listening')
    }
  }
}

Server.prototype._onError = function (err) {
  var self = this
  self.emit('error', err)
}

Server.prototype.listen = function (port, onlistening) {
  var self = this
  if (typeof port === 'function') {
    onlistening = port
    port = undefined
  }
  if (!port) port = 0
  if (self.listening) throw new Error('server already listening')
  debug('listen %o', port)

  if (onlistening) self.once('listening', onlistening)

  // ATTENTION:
  // binding to :: only receives IPv4 connections if the bindv6only
  // sysctl is set 0, which is the default on many operating systems.
  self.http && self.http.listen(port.http || port, '::')
  self.udp && self.udp.bind(port.udp || port)
}

Server.prototype.close = function (cb) {
  var self = this
  if (!cb) cb = function () {}
  debug('close')

  self.listening = false

  if (self.udp) {
    try {
      self.udp.close()
    } catch (err) {}
  }

  if (self.ws) {
    try {
      self.ws.close()
    } catch (err) {}
  }

  if (self.http) self.http.close(cb)
  else cb(null)
}

Server.prototype.getSwarm = function (infoHash, params) {
  var self = this
  if (!params) params = {}
  if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

  if (self._filter && !self._filter(infoHash, params)) return null

  var swarm = self.torrents[infoHash]
  if (!swarm) swarm = self.torrents[infoHash] = new Swarm(infoHash, self)

  return swarm
}

Server.prototype.onHttpRequest = function (req, res, opts) {
  var self = this
  if (!opts) opts = {}
  opts.trustProxy = opts.trustProxy || self._trustProxy

  var params
  try {
    params = parseHttpRequest(req, opts)
    params.httpReq = req
    params.httpRes = res
  } catch (err) {
    res.end(bencode.encode({
      'failure reason': err.message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', err)
    return
  }

  self._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', err)
      response = {
        'failure reason': err.message
      }
    }

    delete response.action  // only needed for UDP encoding
    res.end(bencode.encode(response))

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr)
    }
  })
}

Server.prototype.onUdpRequest = function (msg, rinfo) {
  var self = this

  var params
  try {
    params = parseUdpRequest(msg, rinfo)
  } catch (err) {
    self.emit('warning', err)
    // Do not reply for parsing errors
    return
  }

  self._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', err)
      response = {
        action: common.ACTIONS.ERROR,
        'failure reason': err.message
      }
    }
    if (!self.listening) return

    response.transactionId = params.transactionId
    response.connectionId = params.connectionId

    var buf = makeUdpPacket(response)
    self.udp.send(buf, 0, buf.length, rinfo.port, rinfo.address)

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr)
    }
  })
}

Server.prototype.onWebSocketConnection = function (socket) {
  var self = this
  socket.peerId = null
  socket.infoHashes = []
  socket.onSend = self._onWebSocketSend.bind(self, socket)
  socket.on('message', self._onWebSocketRequest.bind(self, socket))
  socket.on('error', self._onWebSocketError.bind(self, socket))
  socket.on('close', self._onWebSocketClose.bind(self, socket))
}

Server.prototype._onWebSocketRequest = function (socket, params) {
  var self = this

  try {
    params = parseWebSocketRequest(socket, params)
  } catch (err) {
    socket.send(JSON.stringify({
      'failure reason': err.message,
      info_hash: params.info_hash
    }), socket.onSend)

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', err)
    return
  }

  if (!socket.peerId) socket.peerId = params.peer_id

  self._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', err)
      response = {
        'failure reason': err.message
      }
    }
    if (!self.listening) return

    if (socket.infoHashes.indexOf(params.info_hash) === -1) {
      socket.infoHashes.push(params.info_hash)
    }

    var peers = response.peers
    delete response.peers

    response.interval = self._intervalMs
    response.info_hash = params.info_hash
    socket.send(JSON.stringify(response), socket.onSend)

    debug('sent response %s to %s', JSON.stringify(response), params.peer_id)

    if (params.numwant) {
      debug('got offers %s from %s', JSON.stringify(params.offers), params.peer_id)
      debug('got %s peers from swarm %s', peers.length, params.info_hash)
      peers.forEach(function (peer, i) {
        peer.socket.send(JSON.stringify({
          offer: params.offers[i].offer,
          offer_id: params.offers[i].offer_id,
          peer_id: params.peer_id,
          info_hash: params.info_hash
        }))
        debug('sent offer to %s from %s', peer.peerId, params.peer_id)
      })
    }

    if (params.answer) {
      debug('got answer %s from %s', JSON.stringify(params.answer), params.peer_id)

      var swarm = self.getSwarm(params.info_hash, params)
      var toPeer = swarm.peers[params.to_peer_id]
      if (!toPeer) {
        return self.emit('warning', new Error('no peer with that `to_peer_id`'))
      }

      toPeer.socket.send(JSON.stringify({
        answer: params.answer,
        offer_id: params.offer_id,
        peer_id: params.peer_id,
        info_hash: params.info_hash
      }))
      debug('sent answer to %s from %s', toPeer.peerId, params.peer_id)
    }

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr)
    }
  })
}

Server.prototype._onRequest = function (params, cb) {
  var self = this
  if (params && params.action === common.ACTIONS.CONNECT) {
    cb(null, { action: common.ACTIONS.CONNECT })
  } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
    self._onAnnounce(params, cb)
  } else if (params && params.action === common.ACTIONS.SCRAPE) {
    self._onScrape(params, cb)
  } else {
    cb(new Error('Invalid action'))
  }
}

Server.prototype._onAnnounce = function (params, cb) {
  var self = this
  var swarm = self.getSwarm(params.info_hash, params)
  if (swarm === null) return cb(new Error('disallowed info_hash'))
  if (!params.event || params.event === 'empty') params.event = 'update'
  swarm.announce(params, function (err, response) {
    if (err) return cb(err)

    if (!response.action) response.action = common.ACTIONS.ANNOUNCE
    if (!response.interval) response.interval = Math.ceil(self._intervalMs / 1000)

    if (params.compact === 1) {
      var peers = response.peers

      // Find IPv4 peers
      response.peers = string2compact(peers.filter(function (peer) {
        return common.IPV4_RE.test(peer.ip)
      }).map(function (peer) {
        return peer.ip + ':' + peer.port
      }))
      // Find IPv6 peers
      response.peers6 = string2compact(peers.filter(function (peer) {
        return common.IPV6_RE.test(peer.ip)
      }).map(function (peer) {
        return '[' + peer.ip + ']:' + peer.port
      }))
    } else if (params.compact === 0) {
      // IPv6 peers are not separate for non-compact responses
      response.peers = response.peers.map(function (peer) {
        return {
          'peer id': peer.peerId,
          ip: peer.ip,
          port: peer.port
        }
      })
    } // else, return full peer objects (used for websocket responses)

    cb(err, response)
  })
}

Server.prototype._onScrape = function (params, cb) {
  var self = this

  if (params.info_hash == null) {
    // if info_hash param is omitted, stats for all torrents are returned
    // TODO: make this configurable!
    params.info_hash = Object.keys(self.torrents)
  }

  series(params.info_hash.map(function (infoHash) {
    var swarm = self.getSwarm(infoHash)
    return function (cb) {
      swarm.scrape(params, function (err, scrapeInfo) {
        cb(err, scrapeInfo && {
          infoHash: infoHash,
          complete: scrapeInfo.complete || 0,
          incomplete: scrapeInfo.incomplete || 0
        })
      })
    }
  }), function (err, results) {
    if (err) return cb(err)

    var response = {
      action: common.ACTIONS.SCRAPE,
      files: {},
      flags: { min_request_interval: Math.ceil(self._intervalMs / 1000) }
    }

    results.forEach(function (result) {
      response.files[common.hexToBinary(result.infoHash)] = {
        complete: result.complete,
        incomplete: result.incomplete,
        downloaded: result.complete // TODO: this only provides a lower-bound
      }
    })

    cb(null, response)
  })
}

function makeUdpPacket (params) {
  var packet
  switch (params.action) {
    case common.ACTIONS.CONNECT:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.CONNECT),
        common.toUInt32(params.transactionId),
        params.connectionId
      ])
      break
    case common.ACTIONS.ANNOUNCE:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ANNOUNCE),
        common.toUInt32(params.transactionId),
        common.toUInt32(params.interval),
        common.toUInt32(params.incomplete),
        common.toUInt32(params.complete),
        params.peers
      ])
      break
    case common.ACTIONS.SCRAPE:
      var firstInfoHash = Object.keys(params.files)[0]
      var scrapeInfo = firstInfoHash ? {
        complete: params.files[firstInfoHash].complete,
        incomplete: params.files[firstInfoHash].incomplete,
        completed: params.files[firstInfoHash].complete // TODO: this only provides a lower-bound
      } : {}
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId),
        common.toUInt32(scrapeInfo.complete),
        common.toUInt32(scrapeInfo.completed),
        common.toUInt32(scrapeInfo.incomplete)
      ])
      break
    case common.ACTIONS.ERROR:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        new Buffer(params['failure reason'], 'utf8')
      ])
      break
    default:
      throw new Error('Action not implemented: ' + params.action)
  }
  return packet
}

Server.prototype._onWebSocketSend = function (socket, err) {
  var self = this
  if (err) self._onWebSocketError(socket, err)
}

Server.prototype._onWebSocketClose = function (socket) {
  var self = this
  if (!socket.peerId || !socket.infoHashes) return
  debug('websocket close')

  socket.infoHashes.forEach(function (infoHash) {
    var swarm = self.torrents[infoHash]
    if (swarm) {
      swarm.announce({
        event: 'stopped',
        numwant: 0,
        peer_id: socket.peerId
      }, function () {})
    }
  })
}

Server.prototype._onWebSocketError = function (socket, err) {
  var self = this
  debug('websocket error %s', err.message || err)
  self.emit('warning', err)
  self._onWebSocketClose(socket)
}
