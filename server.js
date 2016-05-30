module.exports = Server

var Buffer = require('safe-buffer').Buffer
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
var Swarm = require('./lib/server/swarm')
var parseHttpRequest = require('./lib/server/parse-http')
var parseUdpRequest = require('./lib/server/parse-udp')
var parseWebSocketRequest = require('./lib/server/parse-websocket')

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
 * @param {boolean} opts.stats      enable web-based statistics? (default: true)
 * @param {function} opts.filter    black/whitelist fn for disallowing/allowing torrents
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  if (!opts) opts = {}

  debug('new server %s', JSON.stringify(opts))

  self.intervalMs = opts.interval
    ? opts.interval
    : 10 * 60 * 1000 // 10 min

  self._trustProxy = !!opts.trustProxy
  if (typeof opts.filter === 'function') self._filter = opts.filter

  self._listenCalled = false
  self.listening = false
  self.destroyed = false
  self.torrents = {}

  self.http = null
  self.udp4 = null
  self.udp6 = null
  self.ws = null

  // start an http tracker unless the user explictly says no
  if (opts.http !== false) {
    self.http = http.createServer()
    self.http.on('error', function (err) { self._onError(err) })
    self.http.on('listening', onListening)

    // Add default http request handler on next tick to give user the chance to add
    // their own handler first. Handle requests untouched by user's handler.
    process.nextTick(function () {
      self.http.on('request', function (req, res) {
        if (res.headersSent) return
        self.onHttpRequest(req, res)
      })
    })
  }

  // start a udp tracker unless the user explicitly says no
  if (opts.udp !== false) {
    var isNode10 = /^v0.10./.test(process.version)

    self.udp4 = self.udp = dgram.createSocket(
      isNode10 ? 'udp4' : { type: 'udp4', reuseAddr: true }
    )
    self.udp4.on('message', function (msg, rinfo) { self.onUdpRequest(msg, rinfo) })
    self.udp4.on('error', function (err) { self._onError(err) })
    self.udp4.on('listening', onListening)

    self.udp6 = dgram.createSocket(
      isNode10 ? 'udp6' : { type: 'udp6', reuseAddr: true }
    )
    self.udp6.on('message', function (msg, rinfo) { self.onUdpRequest(msg, rinfo) })
    self.udp6.on('error', function (err) { self._onError(err) })
    self.udp6.on('listening', onListening)
  }

  // start a websocket tracker (for WebTorrent) unless the user explicitly says no
  if (opts.ws !== false) {
    if (!self.http) {
      self.http = http.createServer()
      self.http.on('error', function (err) { self._onError(err) })
      self.http.on('listening', onListening)

      // Add default http request handler on next tick to give user the chance to add
      // their own handler first. Handle requests untouched by user's handler.
      process.nextTick(function () {
        self.http.on('request', function (req, res) {
          if (res.headersSent) return
          // For websocket trackers, we only need to handle the UPGRADE http method.
          // Return 404 for all other request types.
          res.statusCode = 404
          res.end('404 Not Found')
        })
      })
    }
    self.ws = new WebSocketServer({ server: self.http })
    self.ws.address = function () {
      return self.http.address()
    }
    self.ws.on('error', function (err) { self._onError(err) })
    self.ws.on('connection', function (socket) { self.onWebSocketConnection(socket) })
  }

  if (opts.stats !== false) {
    if (!self.http) {
      self.http = http.createServer()
      self.http.on('error', function (err) { self._onError(err) })
      self.http.on('listening', onListening)
    }

    // Http handler for '/stats' route
    self.http.on('request', function (req, res) {
      if (res.headersSent) return

      var infoHashes = Object.keys(self.torrents)
      var activeTorrents = 0
      var allPeers = {}

      function countPeers (filterFunction) {
        var count = 0
        var key

        for (key in allPeers) {
          if (allPeers.hasOwnProperty(key) && filterFunction(allPeers[key])) {
            count++
          }
        }

        return count
      }

      if (req.method === 'GET' && req.url === '/stats') {
        infoHashes.forEach(function (infoHash) {
          var peers = self.torrents[infoHash].peers
          var keys = Object.keys(peers)
          if (keys.length > 0) activeTorrents++

          keys.forEach(function (peerId) {
            if (!allPeers.hasOwnProperty(peerId)) {
              allPeers[peerId] = {
                ipv4: false,
                ipv6: false,
                seeder: false,
                leecher: false
              }
            }
            var peer = peers[peerId]
            if (peer.ip.indexOf(':') >= 0) {
              allPeers[peerId].ipv6 = true
            } else {
              allPeers[peerId].ipv4 = true
            }
            if (peer.complete) {
              allPeers[peerId].seeder = true
            } else {
              allPeers[peerId].leecher = true
            }
          })
        })

        var isSeederOnly = function (peer) { return peer.seeder && peer.leecher === false }
        var isLeecherOnly = function (peer) { return peer.leecher && peer.seeder === false }
        var isSeederAndLeecher = function (peer) { return peer.seeder && peer.leecher }
        var isIPv4 = function (peer) { return peer.ipv4 }
        var isIPv6 = function (peer) { return peer.ipv6 }

        res.end('<h1>' + infoHashes.length + ' torrents (' + activeTorrents + ' active)</h1>\n' +
          '<h2>Connected Peers: ' + Object.keys(allPeers).length + '</h2>\n' +
          '<h3>Peers Seeding Only: ' + countPeers(isSeederOnly) + '</h3>\n' +
          '<h3>Peers Leeching Only: ' + countPeers(isLeecherOnly) + '</h3>\n' +
          '<h3>Peers Seeding & Leeching: ' + countPeers(isSeederAndLeecher) + '</h3>\n' +
          '<h3>IPv4 Peers: ' + countPeers(isIPv4) + '</h3>\n' +
          '<h3>IPv6 Peers: ' + countPeers(isIPv6) + '</h3>\n')
      }
    })
  }

  var num = !!self.http + !!self.udp4 + !!self.udp6
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

Server.prototype.listen = function (/* port, hostname, onlistening */) {
  var self = this

  if (self._listenCalled || self.listening) throw new Error('server already listening')
  self._listenCalled = true

  var lastArg = arguments[arguments.length - 1]
  if (typeof lastArg === 'function') self.once('listening', lastArg)

  var port = toNumber(arguments[0]) || arguments[0] || 0
  var hostname = typeof arguments[1] !== 'function' ? arguments[1] : undefined

  debug('listen (port: %o hostname: %o)', port, hostname)

  function isObject (obj) {
    return typeof obj === 'object' && obj !== null
  }

  var httpPort = isObject(port) ? (port.http || 0) : port
  var udpPort = isObject(port) ? (port.udp || 0) : port

  // binding to :: only receives IPv4 connections if the bindv6only sysctl is set 0,
  // which is the default on many operating systems
  var httpHostname = isObject(hostname) ? hostname.http : hostname
  var udp4Hostname = isObject(hostname) ? hostname.udp : hostname
  var udp6Hostname = isObject(hostname) ? hostname.udp6 : hostname

  if (self.http) self.http.listen(httpPort, httpHostname)
  if (self.udp4) self.udp4.bind(udpPort, udp4Hostname)
  if (self.udp6) self.udp6.bind(udpPort, udp6Hostname)
}

Server.prototype.close = function (cb) {
  var self = this
  if (!cb) cb = noop
  debug('close')

  self.listening = false
  self.destroyed = true

  if (self.udp4) {
    try {
      self.udp4.close()
    } catch (err) {}
  }

  if (self.udp6) {
    try {
      self.udp6.close()
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

Server.prototype.createSwarm = function (infoHash, cb) {
  var self = this
  if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

  process.nextTick(function () {
    var swarm = self.torrents[infoHash] = new Swarm(infoHash, self)
    cb(null, swarm)
  })
}

Server.prototype.getSwarm = function (infoHash, cb) {
  var self = this
  if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

  process.nextTick(function () {
    cb(null, self.torrents[infoHash])
  })
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
    if (self.destroyed) return res.end()

    delete response.action  // only needed for UDP encoding
    res.end(bencode.encode(response))

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr, params)
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
    if (self.destroyed) return

    response.transactionId = params.transactionId
    response.connectionId = params.connectionId

    var buf = makeUdpPacket(response)

    try {
      var udp = (rinfo.family === 'IPv4') ? self.udp4 : self.udp6
      udp.send(buf, 0, buf.length, rinfo.port, rinfo.address)
    } catch (err) {
      self.emit('warning', err)
    }

    if (params.action === common.ACTIONS.ANNOUNCE) {
      self.emit(common.EVENT_NAMES[params.event], params.addr, params)
    }
  })
}

Server.prototype.onWebSocketConnection = function (socket, opts) {
  var self = this
  if (!opts) opts = {}
  opts.trustProxy = opts.trustProxy || self._trustProxy

  socket.peerId = null // as hex
  socket.infoHashes = [] // swarms that this socket is participating in
  socket.onSend = function (err) {
    self._onWebSocketSend(socket, err)
  }

  socket.onMessageBound = function (params) {
    self._onWebSocketRequest(socket, opts, params)
  }
  socket.on('message', socket.onMessageBound)

  socket.onErrorBound = function (err) {
    self._onWebSocketError(socket, err)
  }
  socket.on('error', socket.onErrorBound)

  socket.onCloseBound = function () {
    self._onWebSocketClose(socket)
  }
  socket.on('close', socket.onCloseBound)
}

Server.prototype._onWebSocketRequest = function (socket, opts, params) {
  var self = this

  try {
    params = parseWebSocketRequest(socket, opts, params)
  } catch (err) {
    socket.send(JSON.stringify({
      'failure reason': err.message
    }), socket.onSend)

    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', err)
    return
  }

  if (!socket.peerId) socket.peerId = params.peer_id // as hex

  self._onRequest(params, function (err, response) {
    if (self.destroyed) return
    if (err) {
      socket.send(JSON.stringify({
        action: params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape',
        'failure reason': err.message,
        info_hash: common.hexToBinary(params.info_hash)
      }), socket.onSend)

      self.emit('warning', err)
      return
    }

    response.action = params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape'

    var peers
    if (response.action === 'announce') {
      peers = response.peers
      delete response.peers

      if (socket.infoHashes.indexOf(params.info_hash) === -1) {
        socket.infoHashes.push(params.info_hash)
      }

      response.info_hash = common.hexToBinary(params.info_hash)

      // WebSocket tracker should have a shorter interval – default: 2 minutes
      response.interval = Math.ceil(self.intervalMs / 1000 / 5)
    }

    socket.send(JSON.stringify(response), socket.onSend)
    debug('sent response %s to %s', JSON.stringify(response), params.peer_id)

    if (Array.isArray(params.offers)) {
      debug('got %s offers from %s', params.offers.length, params.peer_id)
      debug('got %s peers from swarm %s', peers.length, params.info_hash)
      peers.forEach(function (peer, i) {
        peer.socket.send(JSON.stringify({
          action: 'announce',
          offer: params.offers[i].offer,
          offer_id: params.offers[i].offer_id,
          peer_id: common.hexToBinary(params.peer_id),
          info_hash: common.hexToBinary(params.info_hash)
        }), peer.socket.onSend)
        debug('sent offer to %s from %s', peer.peerId, params.peer_id)
      })
    }

    if (params.answer) {
      debug('got answer %s from %s', JSON.stringify(params.answer), params.peer_id)

      self.getSwarm(params.info_hash, function (err, swarm) {
        if (err) return self.emit('warning', err)
        if (!swarm) {
          return self.emit('warning', new Error('no swarm with that `info_hash`'))
        }
        var toPeer = swarm.peers[params.to_peer_id]
        if (!toPeer) {
          return self.emit('warning', new Error('no peer with that `to_peer_id`'))
        }

        toPeer.socket.send(JSON.stringify({
          action: 'announce',
          answer: params.answer,
          offer_id: params.offer_id,
          peer_id: common.hexToBinary(params.peer_id),
          info_hash: common.hexToBinary(params.info_hash)
        }), toPeer.socket.onSend)
        debug('sent answer to %s from %s', toPeer.peerId, params.peer_id)

        done()
      })
    } else {
      done()
    }

    function done () {
      // emit event once the announce is fully "processed"
      if (params.action === common.ACTIONS.ANNOUNCE) {
        self.emit(common.EVENT_NAMES[params.event], params.peer_id, params)
      }
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

  self.getSwarm(params.info_hash, function (err, swarm) {
    if (err) return cb(err)
    if (swarm) {
      announce(swarm)
    } else {
      createSwarm()
    }
  })

  function createSwarm () {
    if (self._filter) {
      self._filter(params.info_hash, params, function (allowed) {
        if (allowed instanceof Error) {
          cb(allowed)
        } else if (!allowed) {
          cb(new Error('disallowed info_hash'))
        } else {
          self.createSwarm(params.info_hash, function (err, swarm) {
            if (err) return cb(err)
            announce(swarm)
          })
        }
      })
    } else {
      self.createSwarm(params.info_hash, function (err, swarm) {
        if (err) return cb(err)
        announce(swarm)
      })
    }
  }

  function announce (swarm) {
    if (!params.event || params.event === 'empty') params.event = 'update'
    swarm.announce(params, function (err, response) {
      if (err) return cb(err)

      if (!response.action) response.action = common.ACTIONS.ANNOUNCE
      if (!response.interval) response.interval = Math.ceil(self.intervalMs / 1000)

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
            'peer id': common.hexToBinary(peer.peerId),
            ip: peer.ip,
            port: peer.port
          }
        })
      } // else, return full peer objects (used for websocket responses)

      cb(null, response)
    })
  }
}

Server.prototype._onScrape = function (params, cb) {
  var self = this

  if (params.info_hash == null) {
    // if info_hash param is omitted, stats for all torrents are returned
    // TODO: make this configurable!
    params.info_hash = Object.keys(self.torrents)
  }

  series(params.info_hash.map(function (infoHash) {
    return function (cb) {
      self.getSwarm(infoHash, function (err, swarm) {
        if (err) return cb(err)
        if (swarm) {
          swarm.scrape(params, function (err, scrapeInfo) {
            if (err) return cb(err)
            cb(null, {
              infoHash: infoHash,
              complete: (scrapeInfo && scrapeInfo.complete) || 0,
              incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0
            })
          })
        } else {
          cb(null, { infoHash: infoHash, complete: 0, incomplete: 0 })
        }
      })
    }
  }), function (err, results) {
    if (err) return cb(err)

    var response = {
      action: common.ACTIONS.SCRAPE,
      files: {},
      flags: { min_request_interval: Math.ceil(self.intervalMs / 1000) }
    }

    results.forEach(function (result) {
      response.files[common.hexToBinary(result.infoHash)] = {
        complete: result.complete || 0,
        incomplete: result.incomplete || 0,
        downloaded: result.complete || 0 // TODO: this only provides a lower-bound
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
      var scrapeResponse = [
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId)
      ]
      for (var infoHash in params.files) {
        var file = params.files[infoHash]
        scrapeResponse.push(
          common.toUInt32(file.complete),
          common.toUInt32(file.downloaded), // TODO: this only provides a lower-bound
          common.toUInt32(file.incomplete)
        )
      }
      packet = Buffer.concat(scrapeResponse)
      break
    case common.ACTIONS.ERROR:
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        Buffer.from(String(params['failure reason']))
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
  debug('websocket close %s', socket.peerId)

  if (socket.peerId) {
    socket.infoHashes.forEach(function (infoHash) {
      var swarm = self.torrents[infoHash]
      if (swarm) {
        swarm.announce({
          type: 'ws',
          event: 'stopped',
          numwant: 0,
          peer_id: socket.peerId
        }, noop)
      }
    })
  }

  // ignore all future errors
  socket.onSend = noop
  socket.on('error', noop)

  socket.peerId = null
  socket.infoHashes = null

  if (typeof socket.onMessageBound === 'function') {
    socket.removeListener('message', socket.onMessageBound)
  }
  socket.onMessageBound = null

  if (typeof socket.onErrorBound === 'function') {
    socket.removeListener('error', socket.onErrorBound)
  }
  socket.onErrorBound = null

  if (typeof socket.onCloseBound === 'function') {
    socket.removeListener('close', socket.onCloseBound)
  }
  socket.onCloseBound = null
}

Server.prototype._onWebSocketError = function (socket, err) {
  var self = this
  debug('websocket error %s', err.message || err)
  self.emit('warning', err)
  self._onWebSocketClose(socket)
}

function toNumber (x) {
  x = Number(x)
  return x >= 0 ? x : false
}

function noop () {}
