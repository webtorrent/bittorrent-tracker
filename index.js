module.exports = Server

var Buffer = require('safe-buffer').Buffer
var debug = require('debug')('uwt')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var peerid = require('bittorrent-peerid')
var series = require('run-series')
var string2compact = require('string2compact')
var WebSocketServer = require('uws').Server

var common = require('./lib/common')
var Swarm = require('./lib/server/swarm')
var parseWebSocketRequest = require('./lib/server/parse-websocket')

inherits(Server, EventEmitter)

/**
 * WebTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.interval   tell clients to announce on this interval (ms)
 * @param {Number}  opts.trustProxy trust 'x-forwarded-for' and 'x-real-ip' headers from reverse proxy
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

  self.peersCacheLength = opts.peersCacheLength
  self.peersCacheTtl = opts.peersCacheTtl

  self._listenCalled = false
  self.listening = false
  self.destroyed = false
  self.torrents = {}

  self.http = null
  self.ws = null

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

  self.ws = new WebSocketServer({ server: self.http })
  self.ws.on('error', function (err) { self._onError(err) })
  self.ws.on('connection', function (socket) { self.onWebSocketConnection(socket) })

  if (opts.stats !== false) {
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

      function groupByClient () {
        var clients = {}
        for (var key in allPeers) {
          if (allPeers.hasOwnProperty(key)) {
            var peer = allPeers[key]

            if (!clients[peer.client.client]) {
              clients[peer.client.client] = {}
            }
            var client = clients[peer.client.client]
            // If the client is not known show 8 chars from peerId as version
            var version = peer.client.version || new Buffer(peer.peerId, 'hex').toString().substring(0, 8)
            if (!client[version]) {
              client[version] = 0
            }
            client[version]++
          }
        }
        return clients
      }

      function printClients (clients) {
        var html = '<ul>\n'
        for (var name in clients) {
          if (clients.hasOwnProperty(name)) {
            var client = clients[name]
            for (var version in client) {
              if (client.hasOwnProperty(version)) {
                html += '<li><strong>' + name + '</strong> ' + version + ' : ' + client[version] + '</li>\n'
              }
            }
          }
        }
        html += '</ul>'
        return html
      }

      if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
        infoHashes.forEach(function (infoHash) {
          var peers = self.torrents[infoHash].peers
          var keys = peers.keys
          if (keys.length > 0) activeTorrents++

          keys.forEach(function (peerId) {
            // Don't mark the peer as most recently used for stats
            var peer = peers.peek(peerId)
            if (peer == null) return // peers.peek() can evict the peer

            if (!allPeers.hasOwnProperty(peerId)) {
              allPeers[peerId] = {
                ipv4: false,
                ipv6: false,
                seeder: false,
                leecher: false
              }
            }

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

            allPeers[peerId].peerId = peer.peerId
            allPeers[peerId].client = peerid(peer.peerId)
          })
        })

        var isSeederOnly = function (peer) { return peer.seeder && peer.leecher === false }
        var isLeecherOnly = function (peer) { return peer.leecher && peer.seeder === false }
        var isSeederAndLeecher = function (peer) { return peer.seeder && peer.leecher }
        var isIPv4 = function (peer) { return peer.ipv4 }
        var isIPv6 = function (peer) { return peer.ipv6 }

        var stats = {
          torrents: infoHashes.length,
          activeTorrents: activeTorrents,
          peersAll: Object.keys(allPeers).length,
          peersSeederOnly: countPeers(isSeederOnly),
          peersLeecherOnly: countPeers(isLeecherOnly),
          peersSeederAndLeecher: countPeers(isSeederAndLeecher),
          peersIPv4: countPeers(isIPv4),
          peersIPv6: countPeers(isIPv6),
          clients: groupByClient()
        }

        if (req.url === '/stats.json' || req.headers['accept'] === 'application/json') {
          res.write(JSON.stringify(stats))
          res.end()
        } else if (req.url === '/stats') {
          res.end('<h1>' + stats.torrents + ' torrents (' + stats.activeTorrents + ' active)</h1>\n' +
            '<h2>Connected Peers: ' + stats.peersAll + '</h2>\n' +
            '<h3>Peers Seeding Only: ' + stats.peersSeederOnly + '</h3>\n' +
            '<h3>Peers Leeching Only: ' + stats.peersLeecherOnly + '</h3>\n' +
            '<h3>Peers Seeding & Leeching: ' + stats.peersSeederAndLeecher + '</h3>\n' +
            '<h3>IPv4 Peers: ' + stats.peersIPv4 + '</h3>\n' +
            '<h3>IPv6 Peers: ' + stats.peersIPv6 + '</h3>\n' +
            '<h3>Clients:</h3>\n' +
            printClients(stats.clients)
          )
        }
      }
    })
  }

  function onListening () {
    self.listening = true
    debug('listening')
    self.emit('listening')
  }
}

Server.prototype._onError = function (err) {
  var self = this
  self.emit('error', err)
}

Server.prototype.listen = function (/* port, onlistening */) {
  var self = this

  if (self._listenCalled || self.listening) throw new Error('server already listening')
  self._listenCalled = true

  var lastArg = arguments[arguments.length - 1]
  if (typeof lastArg === 'function') self.once('listening', lastArg)

  var port = toNumber(arguments[0]) || arguments[0] || 0

  debug('listen (port: %o)', port)

  function isObject (obj) {
    return typeof obj === 'object' && obj !== null
  }

  var httpPort = isObject(port) ? (port.http || 0) : port

  if (self.http) self.http.listen(httpPort)
}

Server.prototype.close = function (cb) {
  var self = this
  if (!cb) cb = noop
  debug('close')

  self.listening = false
  self.destroyed = true

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

Server.prototype.onWebSocketConnection = function (socket, opts) {
  var self = this
  if (!opts) opts = {}
  opts.trustProxy = opts.trustProxy || self._trustProxy

  socket.headers = socket.upgradeReq.headers
  socket.realIPAddress = opts.trustProxy ? socket.headers['x-forwarded-for'] || socket.headers['x-real-ip'] || socket._socket.remoteAddress : socket._socket.remoteAddress.replace(common.REMOVE_IPV4_MAPPED_IPV6_RE, '') // force ipv4
  socket.port = socket._socket.remotePort

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
        // Mark the destination peer as recently used in cache
        var toPeer = swarm.peers.get(params.to_peer_id)
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
      createSwarmFilter()
    }
  })

  function createSwarm () {
    self.createSwarm(params.info_hash, function (err, swarm) {
      if (err) return cb(err)
      announce(swarm)
    })
  }

  function createSwarmFilter () {
    if (self._filter) {
      self._filter(params.info_hash, params, function (allowed) {
        if (allowed instanceof Error) {
          cb(allowed)
        } else if (!allowed) {
          cb(new Error('disallowed info_hash'))
        } else {
          createSwarm()
        }
      })
    } else {
      createSwarm()
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
        downloaded: result.complete || 0
      }
    })

    cb(null, response)
  })
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

  process.nextTick(function () {
    socket.peerId = null
    socket.infoHashes = null
  })
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
