module.exports = Server
module.exports.parseHttpRequest = parseHttpRequest

var bencode = require('bencode')
var bufferEqual = require('buffer-equal')
var common = require('./lib/common')
var debug = require('debug')('bittorrent-tracker')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var ipLib = require('ip')
var portfinder = require('portfinder')
var string2compact = require('string2compact')

// Use random port above 1024
portfinder.basePort = Math.floor(Math.random() * 60000) + 1025

var NUM_ANNOUNCE_PEERS = 50
var MAX_ANNOUNCE_PEERS = 82
var REMOVE_IPV6_RE = /^::ffff:/

inherits(Server, EventEmitter)

/**
 * A BitTorrent tracker server.
 *
 * A "BitTorrent tracker" is an HTTP service which responds to GET requests from
 * BitTorrent clients. The requests include metrics from clients that help the tracker
 * keep overall statistics about the torrent. The response includes a peer list that
 * helps the client participate in the torrent.
 *
 * @param {Object}  opts            options
 * @param {Number}  opts.interval   interval in ms that clients should announce on
 * @param {Number}  opts.trustProxy Trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       Start an http server? (default: true)
 * @param {boolean} opts.udp        Start a udp server? (default: true)
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  opts = opts || {}

  self._intervalMs = opts.interval
    ? opts.interval / 1000
    : 10 * 60 // 10 min (in secs)

  self._trustProxy = !!opts.trustProxy

  self.listening = false
  self.port = null
  self.torrents = {}

  // default to starting an http server unless the user explictly says no
  if (opts.http !== false) {
    self._httpServer = http.createServer()
    self._httpServer.on('request', self._onHttpRequest.bind(self))
    self._httpServer.on('error', self._onError.bind(self))
    self._httpServer.on('listening', onListening)
  }

  // default to starting a udp server unless the user explicitly says no
  if (opts.udp !== false) {
    self._udpServer = dgram.createSocket('udp4')
    self._udpServer.on('message', self._onUdpRequest.bind(self))
    self._udpServer.on('error', self._onError.bind(self))
    self._udpServer.on('listening', onListening)
  }

  var num = !!self._httpServer + !!self._udpServer
  function onListening () {
    num -= 1
    if (num === 0) {
      self.listening = true
      self.emit('listening', self.port)
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
  if (self.listening) throw new Error('server already listening')
  if (onlistening) self.once('listening', onlistening)

  function onPort (err, port) {
    if (err) return self.emit('error', err)
    self.port = port
    self._httpServer && self._httpServer.listen(port.http || port)
    self._udpServer && self._udpServer.bind(port.udp || port)
  }

  if (port) onPort(null, port)
  else portfinder.getPort(onPort)
}

Server.prototype.close = function (cb) {
  var self = this
  cb = cb || function () {}
  if (self._udpServer) {
    self._udpServer.close()
  }
  if (self._httpServer) {
    self._httpServer.close(cb)
  } else {
    cb(null)
  }
}

Server.prototype.getSwarm = function (infoHash) {
  var self = this
  var binaryInfoHash = Buffer.isBuffer(infoHash)
    ? infoHash.toString('binary')
    : new Buffer(infoHash, 'hex').toString('binary')
  return self._getSwarm(binaryInfoHash)
}

Server.prototype._getSwarm = function (binaryInfoHash) {
  var self = this
  var swarm = self.torrents[binaryInfoHash]
  if (!swarm) {
    swarm = self.torrents[binaryInfoHash] = {
      complete: 0,
      incomplete: 0,
      peers: {}
    }
  }
  return swarm
}

Server.prototype._onHttpRequest = function (req, res) {
  var self = this

  var params
  try {
    params = parseHttpRequest(req, {
      trustProxy: self._trustProxy
    })
  } catch (err) {
    debug('sent error %s', err.message)
    res.end(bencode.encode({
      'failure reason': err.message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', err)
    
    return
  }

  this._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', new Error(err.message))
      response = {
        'failure reason': err.message
      }
    }

    delete response.action  // only needed for UDP encoding
    res.end(bencode.encode(response))
  })
}

Server.prototype._onUdpRequest = function (msg, rinfo) {
  var self = this

  var params
  try {
    params = parseUdpRequest(msg, rinfo)
  } catch (err) {
    self.emit('warning', err)
    // Do not reply for parsing errors
    return
  }

  // Do nothing with invalid request
  if (!params) return

  // Handle
  this._onRequest(params, function (err, response) {
    if (err) {
      self.emit('warning', new Error(err.message))
      response = {
        action: common.ACTIONS.ERRROR,
        'failure reason': err.message
      }
    }
    
    var socket = dgram.createSocket('udp4')
    response.transactionId = params.transactionId
    response.connectionId = params.connectionId
    var buf = makeUdpPacket(response)
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, function () {
      try {
        socket.close()
      } catch (err) {}
    })
  })
}

Server.prototype._onRequest = function (params, cb) {
  var response
  if (params && params.action === common.ACTIONS.CONNECT) {
    cb(null, { action: common.ACTIONS.CONNECT })
  } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
    this._onAnnounce(params, cb)
  } else if (params && params.action === common.ACTIONS.SCRAPE) {
    this._onScrape(params, cb)
  } else {
    cb(new Error('Invalid action'))
  }
}

Server.prototype._onAnnounce = function (params, cb) {
  var self = this

  var swarm = self._getSwarm(params.info_hash)
  var peer = swarm.peers[params.addr]

  var start = function () {
    if (peer) {
      debug('unexpected `started` event from peer that is already in swarm')
      return update() // treat as an update
    }
    if (params.left === 0) swarm.complete += 1
    else swarm.incomplete += 1
    peer = swarm.peers[params.addr] = {
      ip: params.ip,
      port: params.port,
      peerId: params.peer_id
    }
    self.emit('start', params.addr)
  }

  var stop = function () {
    if (!peer) {
      debug('unexpected `stopped` event from peer that is not in swarm')
      return // do nothing
    }
    if (peer.complete) swarm.complete -= 1
    else swarm.incomplete -= 1
    swarm.peers[params.addr] = null
    self.emit('stop', params.addr)
  }

  var complete = function () {
    if (!peer) {
      debug('unexpected `completed` event from peer that is not in swarm')
      return start() // treat as a start
    }
    if (peer.complete) {
      debug('unexpected `completed` event from peer that is already marked as completed')
      return // do nothing
    }
    swarm.complete += 1
    swarm.incomplete -= 1
    peer.complete = true
    self.emit('complete', params.addr)
  }

  var update = function () {
    if (!peer) {
      debug('unexpected `update` event from peer that is not in swarm')
      return start() // treat as a start
    }
    self.emit('update', params.addr)
  }

  switch (params.event) {
  case 'started':
    start()
    break
  case 'stopped':
    stop()
    break
  case 'completed':
    complete()
    break
  case '': case undefined: case 'empty': case 'update': // update
    update()
    break
  default:
    return cb(new Error('invalid event')) // early return
  }

  if (params.left === 0 && peer) peer.complete = true

  // send peers
  var peers = params.compact === 1
        ? self._getPeersCompact(swarm, params.numwant)
        : self._getPeers(swarm, params.numwant)

  cb(null, {
    action: common.ACTIONS.ANNOUNCE,
    complete: swarm.complete,
    incomplete: swarm.incomplete,
    peers: peers,
    intervalMs: self._intervalMs
  })
}

Server.prototype._onScrape = function (params, cb) {
  var self = this
  
  if (typeof params.info_hash === 'string') {
    params.info_hash = [ params.info_hash ]
  } else if (params.info_hash == null) {
    // if info_hash param is omitted, stats for all torrents are returned
    // TODO: make this configurable!
    params.info_hash = Object.keys(self.torrents)
  }
  
  if (!Array.isArray(params.info_hash)) {
    var err = new Error('invalid info_hash')
    self.emit('warning', err)
    return cb(err)
  }
  
  var response = {
    action: common.ACTIONS.SCRAPE,
    files: {},
    flags: {
      min_request_interval: self._intervalMs
    }
  }
  
  params.info_hash.some(function (infoHash) {
    var swarm = self._getSwarm(infoHash)
    
    response.files[infoHash] = {
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      downloaded: swarm.complete // TODO: this only provides a lower-bound
    }
  })

  cb(null, response)
}

Server.prototype._getPeers = function (swarm, numwant) {
  var peers = []
  for (var peerId in swarm.peers) {
    if (peers.length >= numwant) break
    var peer = swarm.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push({
      'peer id': peer.peerId,
      ip: peer.ip,
      port: peer.port
    })
  }
  return peers
}

Server.prototype._getPeersCompact = function (swarm, numwant) {
  var peers = []

  for (var peerId in swarm.peers) {
    if (peers.length >= numwant) break
    var peer = swarm.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push(peer.ip + ':' + peer.port)
  }

  return string2compact(peers)
}


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
      Number(params.numwant) || NUM_ANNOUNCE_PEERS,
      MAX_ANNOUNCE_PEERS
    )

    return params
  } else if (s[0] === '/scrape') { // unofficial scrape message
    params.action = common.ACTIONS.SCRAPE

    if (typeof params.info_hash === 'string') {
      params.info_hash = [ params.info_hash ]
    }

    if (params.info_hash) {
        if (!Array.isArray(params.info_hash)) throw new Error('invalid info_hash')

      params.info_hash.some(function (infoHash) {
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

function parseUdpRequest (msg, rinfo) {
  if (msg.length < 16) {
    throw new Error('received packet is too short')
  }

  if (rinfo.family !== 'IPv4') {
    throw new Error('udp tracker does not support IPv6')
  }

  var params = {
    connectionId: msg.slice(0, 8), // 64-bit
    action: msg.readUInt32BE(8),
    transactionId: msg.readUInt32BE(12)
  }

  // TODO: randomize:
  if (!bufferEqual(params.connectionId, common.CONNECTION_ID)) {
    throw new Error('received packet with invalid connection id')
  }

  if (params.action === common.ACTIONS.CONNECT) {
    // No further params
  } else if (params.action === common.ACTIONS.ANNOUNCE) {
    params.info_hash = msg.slice(16, 36).toString('binary') // 20 bytes
    params.peer_id = msg.slice(36, 56).toString('utf8') // 20 bytes
    params.downloaded = fromUInt64(msg.slice(56, 64)) // TODO: track this?
    params.left = fromUInt64(msg.slice(64, 72))
    params.uploaded = fromUInt64(msg.slice(72, 80)) // TODO: track this?
    params.event = msg.readUInt32BE(80)
    params.event = common.EVENT_IDS[params.event]
    if (!params.event) throw new Error('invalid event') // early return
    params.ip = msg.readUInt32BE(84) // optional
    params.ip = params.ip ?
      ipLib.toString(params.ip) :
      params.ip = rinfo.address
    params.key = msg.readUInt32BE(88) // TODO: what is this for?
    params.numwant = msg.readUInt32BE(92) // optional
    // never send more than MAX_ANNOUNCE_PEERS or else the UDP packet will get bigger than
    // 512 bytes which is not safe
    params.numwant = Math.min(params.numwant || NUM_ANNOUNCE_PEERS, MAX_ANNOUNCE_PEERS)
    params.port = msg.readUInt16BE(96) || rinfo.port // optional
    params.addr = params.ip + ':' + params.port // TODO: ipv6 brackets
    params.compact = 1 // udp is always compact

  } else if (params.action === common.ACTIONS.SCRAPE) { // scrape message
    params.info_hash = msg.slice(16, 36).toString('binary') // 20 bytes

    // TODO: support multiple info_hash scrape
    if (msg.length > 36) {
      throw new Error('multiple info_hash scrape not supported')
    }
  } else {
    return null
  }

  return params
}

function makeUdpPacket (params) {
  switch (params.action) {
    case common.ACTIONS.CONNECT:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.CONNECT),
        common.toUInt32(params.transactionId),
        params.connectionId
      ])
    case common.ACTIONS.ANNOUNCE:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.ANNOUNCE),
        common.toUInt32(params.transactionId),
        common.toUInt32(params.intervalMs),
        common.toUInt32(params.incomplete),
        common.toUInt32(params.complete),
        params.peers
      ])
    case common.ACTIONS.SCRAPE:
      var firstInfoHash = Object.keys(params.files)[0]
      var scrapeInfo = firstInfoHash ? {
        complete: params.files[firstInfoHash].complete,
        incomplete: params.files[firstInfoHash].incomplete,
        completed: params.files[firstInfoHash].complete // TODO: this only provides a lower-bound
      } : {}
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId),
        common.toUInt32(scrapeInfo.complete),
        common.toUInt32(scrapeInfo.completed),
        common.toUInt32(scrapeInfo.incomplete)
      ])
    case common.ACTIONS.ERROR:
      return Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        new Buffer(params.message, 'utf8')
      ])
  default:
    throw new Error('Action not implemented: ' + params.action)
  }
}

// HELPER FUNCTIONS

var TWO_PWR_32 = (1 << 16) * 2

/**
 * Return the closest floating-point representation to the buffer value. Precision will be
 * lost for big numbers.
 */
function fromUInt64 (buf) {
  var high = buf.readUInt32BE(0) | 0 // force
  var low = buf.readUInt32BE(4) | 0
  var lowUnsigned = (low >= 0) ? low : TWO_PWR_32 + low

  return high * TWO_PWR_32 + lowUnsigned
}
