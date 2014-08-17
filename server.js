module.exports = Server

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
  var warning
  var s = req.url.split('?')
  var params = common.querystringParse(s[1])
  var response
  if (s[0] === '/announce') {
    var infoHash = typeof params.info_hash === 'string' && params.info_hash
    var peerId = typeof params.peer_id === 'string' && common.binaryToUtf8(params.peer_id)
    var port = Number(params.port)

    if (!infoHash) return error('invalid info_hash')
    if (infoHash.length !== 20) return error('invalid info_hash')
    if (!peerId) return error('invalid peer_id')
    if (peerId.length !== 20) return error('invalid peer_id')
    if (!port) return error('invalid port')

    var ip = self._trustProxy
      ? req.headers['x-forwarded-for'] || req.connection.remoteAddress
      : req.connection.remoteAddress.replace(REMOVE_IPV6_RE, '') // force ipv4
    var addr = ip + ':' + port
    var swarm = self._getSwarm(infoHash)
    var peer = swarm.peers[addr]

    var numWant = Math.min(
      Number(params.numwant) || NUM_ANNOUNCE_PEERS,
      MAX_ANNOUNCE_PEERS
    )

    switch (params.event) {
      case 'started':
        if (peer) {
          warning = 'unexpected `started` event from peer that is already in swarm'
          break
        }

        if (Number(params.left) === 0) {
          swarm.complete += 1
        } else {
          swarm.incomplete += 1
        }

        swarm.peers[addr] = {
          ip: ip,
          port: port,
          peerId: peerId
        }
        self.emit('start', addr)
        break

      case 'stopped':
        if (!peer) {
          warning = 'unexpected `stopped` event from peer that is not in swarm'
          break
        }

        if (peer.complete) {
          swarm.complete -= 1
        } else {
          swarm.incomplete -= 1
        }

        swarm.peers[addr] = null
        self.emit('stop', addr)
        break

      case 'completed':
        if (!peer) {
          warning = 'unexpected `completed` event from peer that is not in swarm'
          break
        }
        if (peer.complete) {
          warning = 'unexpected `completed` event from peer that is already marked as completed'
          break
        }

        swarm.complete += 1
        swarm.incomplete -= 1

        peer.complete = true
        self.emit('complete', addr)
        break

      case '': // update
      case undefined:
        if (!peer) {
          warning = 'unexpected `update` event from peer that is not in swarm'
          break
        }

        self.emit('update', addr)
        break

      default:
        return error('invalid event') // early return
    }

    // send peers
    var peers = Number(params.compact) === 1
      ? self._getPeersCompact(swarm, numWant)
      : self._getPeers(swarm, numWant)

    response = {
      complete: swarm.complete,
      incomplete: swarm.incomplete,
      peers: peers,
      interval: self._intervalMs
    }

    if (warning) {
      response['warning message'] = warning
    }
    res.end(bencode.encode(response))
    debug('sent response %s', response)

  } else if (s[0] === '/scrape') { // unofficial scrape message
    if (typeof params.info_hash === 'string') {
      params.info_hash = [ params.info_hash ]
    } else if (params.info_hash == null) {
      // if info_hash param is omitted, stats for all torrents are returned
      params.info_hash = Object.keys(self.torrents)
    }

    if (!Array.isArray(params.info_hash)) return error('invalid info_hash')

    response = {
      files: {},
      flags: {
        min_request_interval: self._intervalMs
      }
    }

    params.info_hash.some(function (infoHash) {
      if (infoHash.length !== 20) {
        error('invalid info_hash')
        return true // early return
      }

      var swarm = self._getSwarm(infoHash)

      response.files[infoHash] = {
        complete: swarm.complete,
        incomplete: swarm.incomplete,
        downloaded: swarm.complete // TODO: this only provides a lower-bound
      }
    })

    res.end(bencode.encode(response))
    debug('sent response %s', response)

  } else {
    error('only /announce and /scrape are valid endpoints')
  }

  function error (message) {
    debug('sent error %s', message)
    res.end(bencode.encode({
      'failure reason': message
    }))

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', new Error(message))
  }
}

Server.prototype._onUdpRequest = function (msg, rinfo) {
  var self = this

  if (msg.length < 16) {
    return error('received packet is too short')
  }

  if (rinfo.family !== 'IPv4') {
    return error('udp tracker does not support IPv6')
  }

  var connectionId = msg.slice(0, 8) // 64-bit
  var action = msg.readUInt32BE(8)
  var transactionId = msg.readUInt32BE(12)

  if (!bufferEqual(connectionId, common.CONNECTION_ID)) {
    return error('received packet with invalid connection id')
  }

  var socket = dgram.createSocket('udp4')

  var infoHash, swarm
  if (action === common.ACTIONS.CONNECT) {
    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.CONNECT),
      common.toUInt32(transactionId),
      connectionId
    ]))
  } else if (action === common.ACTIONS.ANNOUNCE) {
    infoHash = msg.slice(16, 36).toString('binary') // 20 bytes
    var peerId = msg.slice(36, 56).toString('utf8') // 20 bytes
    var downloaded = fromUInt64(msg.slice(56, 64)) // TODO: track this?
    var left = fromUInt64(msg.slice(64, 72))
    var uploaded = fromUInt64(msg.slice(72, 80)) // TODO: track this?
    var event = msg.readUInt32BE(80)
    var ip = msg.readUInt32BE(84) // optional
    var key = msg.readUInt32BE(88) // TODO: what is this for?
    var numWant = msg.readUInt32BE(92) // optional
    var port = msg.readUInt16BE(96) // optional

    if (ip) {
      ip = ipLib.toString(ip)
    } else {
      ip = rinfo.address
    }

    if (!port) {
      port = rinfo.port
    }

    var addr = ip + ':' + port

    swarm = self._getSwarm(infoHash)
    var peer = swarm.peers[addr]

    // never send more than MAX_ANNOUNCE_PEERS or else the UDP packet will get bigger than
    // 512 bytes which is not safe
    numWant = Math.min(numWant || NUM_ANNOUNCE_PEERS, MAX_ANNOUNCE_PEERS)

    var warning
    switch (event) {
      case common.EVENTS.started:
        if (peer) {
          warning = 'unexpected `started` event from peer that is already in swarm'
          break
        }

        if (left === 0) {
          swarm.complete += 1
        } else {
          swarm.incomplete += 1
        }

        swarm.peers[addr] = {
          ip: ip,
          port: port,
          peerId: peerId
        }
        self.emit('start', addr)
        break

      case common.EVENTS.stopped:
        if (!peer) {
          warning = 'unexpected `stopped` event from peer that is not in swarm'
          break
        }

        if (peer.complete) {
          swarm.complete -= 1
        } else {
          swarm.incomplete -= 1
        }

        swarm.peers[addr] = null
        self.emit('stop', addr)
        break

      case common.EVENTS.completed:
        if (!peer) {
          warning = 'unexpected `completed` event from peer that is not in swarm'
          break
        }
        if (peer.complete) {
          warning = 'unexpected `completed` event from peer that is already marked as completed'
          break
        }

        swarm.complete += 1
        swarm.incomplete -= 1

        peer.complete = true
        self.emit('complete', addr)
        break

      case common.EVENTS.update: // update
        if (!peer) {
          warning = 'unexpected `update` event from peer that is not in swarm'
          break
        }

        self.emit('update', addr)
        break

      default:
        return error('invalid event') // early return
    }

    // send peers
    var peers = self._getPeersCompact(swarm, numWant)

    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.ANNOUNCE),
      common.toUInt32(transactionId),
      common.toUInt32(self._intervalMs),
      common.toUInt32(swarm.incomplete),
      common.toUInt32(swarm.complete),
      peers
    ]))

  } else if (action === common.ACTIONS.SCRAPE) { // scrape message
    infoHash = msg.slice(16, 36).toString('binary') // 20 bytes

    // TODO: support multiple info_hash scrape
    if (msg.length > 36) {
      error('multiple info_hash scrape not supported')
    }

    swarm = self._getSwarm(infoHash)

    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.SCRAPE),
      common.toUInt32(transactionId),
      common.toUInt32(swarm.complete),
      common.toUInt32(swarm.complete), // TODO: this only provides a lower-bound
      common.toUInt32(swarm.incomplete)
    ]))
  }

  function send (buf) {
    debug('sent response %s', buf.toString('hex'))
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, function () {
      try {
        socket.close()
      } catch (err) {}
    })
  }

  function error (message) {
    debug('sent error %s', message)
    send(Buffer.concat([
      common.toUInt32(common.ACTIONS.ERROR),
      common.toUInt32(transactionId || 0),
      new Buffer(message, 'utf8')
    ]))
    self.emit('warning', new Error(message))
  }
}

Server.prototype._getPeers = function (swarm, numWant) {
  var peers = []
  for (var peerId in swarm.peers) {
    if (peers.length >= numWant) break
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

Server.prototype._getPeersCompact = function (swarm, numWant) {
  var peers = []

  for (var peerId in swarm.peers) {
    if (peers.length >= numWant) break
    var peer = swarm.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push(peer.ip + ':' + peer.port)
  }

  return string2compact(peers)
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
