module.exports = WebSocketTracker

var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var extend = require('xtend')
var hat = require('hat')
var inherits = require('inherits')
var Peer = require('simple-peer')
var Socket = require('simple-websocket')

var common = require('../common')
var Tracker = require('./tracker')

// Use a socket pool, so tracker clients share WebSocket objects for the same server.
// In practice, WebSockets are pretty slow to establish, so this gives a nice performance
// boost, and saves browser resources.
var socketPool = {}

var RECONNECT_VARIANCE = 30 * 1000
var RECONNECT_MINIMUM = 5 * 1000
var OFFER_TIMEOUT = 50 * 1000

inherits(WebSocketTracker, Tracker)

function WebSocketTracker (client, announceUrl, opts) {
  var self = this
  Tracker.call(self, client, announceUrl)
  debug('new websocket tracker %s', announceUrl)

  self.peers = {} // peers (offer id -> peer)
  self.socket = null
  self.reconnecting = false

  self._openSocket()
}

WebSocketTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000 // 30 seconds

WebSocketTracker.prototype.announce = function (opts) {
  var self = this
  if (self.destroyed || self.reconnecting) return
  if (!self.socket.connected) {
    return self.socket.once('connect', self.announce.bind(self, opts))
  }

  // Limit the number of offers that are generated, since it can be slow
  var numwant = Math.min(opts.numwant, 10)

  self._generateOffers(numwant, function (offers) {
    var params = extend(opts, {
      numwant: numwant,
      info_hash: self.client._infoHashBinary,
      peer_id: self.client._peerIdBinary,
      offers: offers
    })
    if (self._trackerId) params.trackerid = self._trackerId

    self._send(params)
  })
}

WebSocketTracker.prototype.scrape = function (opts) {
  var self = this
  if (self.destroyed || self.reconnecting) return
  self._onSocketError(new Error('scrape not supported ' + self.announceUrl))
}

WebSocketTracker.prototype.destroy = function (onclose) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true
  clearInterval(self.interval)

  delete socketPool[self.announceUrl]

  self.socket.removeListener('connect', self._onSocketConnectBound)
  self.socket.removeListener('data', self._onSocketDataBound)
  self.socket.removeListener('close', self._onSocketCloseBound)
  self.socket.removeListener('error', self._onSocketErrorBound)

  self._onSocketConnectBound = null
  self._onSocketErrorBound = null
  self._onSocketDataBound = null
  self._onSocketCloseBound = null

  self.socket.on('error', noop) // ignore all future errors
  try {
    self.socket.destroy(onclose)
  } catch (err) {
    if (onclose) onclose()
  }

  self.socket = null
}

WebSocketTracker.prototype._openSocket = function () {
  var self = this
  self.destroyed = false

  self._onSocketConnectBound = self._onSocketConnect.bind(self)
  self._onSocketErrorBound = self._onSocketError.bind(self)
  self._onSocketDataBound = self._onSocketData.bind(self)
  self._onSocketCloseBound = self._onSocketClose.bind(self)

  self.socket = socketPool[self.announceUrl]
  if (!self.socket) {
    self.socket = socketPool[self.announceUrl] = new Socket(self.announceUrl)
    self.socket.on('connect', self._onSocketConnectBound)
  }

  self.socket.on('data', self._onSocketDataBound)
  self.socket.on('close', self._onSocketCloseBound)
  self.socket.on('error', self._onSocketErrorBound)
}

WebSocketTracker.prototype._onSocketConnect = function () {
  var self = this
  if (self.destroyed) return

  if (self.reconnecting) {
    self.reconnecting = false
    self.announce(self.client._defaultAnnounceOpts())
  }
}

WebSocketTracker.prototype._onSocketData = function (data) {
  var self = this
  if (self.destroyed) return

  try {
    data = JSON.parse(data)
  } catch (err) {
    self.client.emit('warning', new Error('Invalid tracker response'))
    return
  }

  if (data.info_hash !== self.client._infoHashBinary) {
    debug(
      'ignoring websocket data from %s for %s (looking for %s: reused socket)',
      self.announceUrl, common.binaryToHex(data.info_hash), self.client.infoHash
    )
    return
  }

  if (data.peer_id && data.peer_id === self.client._peerIdBinary) {
    // ignore offers/answers from this client
    return
  }

  debug(
    'received %s from %s for %s',
    JSON.stringify(data), self.announceUrl, self.client.infoHash
  )

  var failure = data['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = data['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

  var interval = data.interval || data['min interval']
  if (interval) self.setInterval(interval * 1000)

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  if (data.complete != null) {
    self.client.emit('update', {
      announce: self.announceUrl,
      complete: data.complete,
      incomplete: data.incomplete
    })
  }

  var peer
  if (data.offer && data.peer_id) {
    debug('creating peer (from remote offer)')
    peer = new Peer({
      trickle: false,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    })
    peer.id = common.binaryToHex(data.peer_id)
    peer.once('signal', function (answer) {
      var params = {
        info_hash: self.client._infoHashBinary,
        peer_id: self.client._peerIdBinary,
        to_peer_id: data.peer_id,
        answer: answer,
        offer_id: data.offer_id
      }
      if (self._trackerId) params.trackerid = self._trackerId
      self._send(params)
    })
    peer.signal(data.offer)
    self.client.emit('peer', peer)
  }

  if (data.answer && data.peer_id) {
    var offerId = common.binaryToHex(data.offer_id)
    peer = self.peers[offerId]
    if (peer) {
      peer.id = common.binaryToHex(data.peer_id)
      peer.signal(data.answer)
      self.client.emit('peer', peer)

      clearTimeout(peer.trackerTimeout)
      peer.trackerTimeout = null
      delete self.peers[offerId]
    } else {
      debug('got unexpected answer: ' + JSON.stringify(data.answer))
    }
  }
}

WebSocketTracker.prototype._onSocketClose = function () {
  var self = this
  if (self.destroyed) return
  self.destroy()
  self._startReconnectTimer()
}

WebSocketTracker.prototype._onSocketError = function (err) {
  var self = this
  if (self.destroyed) return
  self.destroy()
  // errors will often happen if a tracker is offline, so don't treat it as fatal
  self.client.emit('warning', err)
  self._startReconnectTimer()
}

WebSocketTracker.prototype._startReconnectTimer = function () {
  var self = this
  var ms = Math.floor(Math.random() * RECONNECT_VARIANCE) + RECONNECT_MINIMUM

  self.reconnecting = true
  var reconnectTimer = setTimeout(function () {
    self._openSocket()
  }, ms)
  if (reconnectTimer.unref) reconnectTimer.unref()

  debug('reconnecting socket in %s ms', ms)
}

WebSocketTracker.prototype._send = function (params) {
  var self = this
  if (self.destroyed) return

  var message = JSON.stringify(params)
  debug('send %s', message)
  self.socket.send(message)
}

WebSocketTracker.prototype._generateOffers = function (numwant, cb) {
  var self = this
  var offers = []
  debug('generating %s offers', numwant)

  for (var i = 0; i < numwant; ++i) {
    generateOffer()
  }

  function generateOffer () {
    var offerId = hat(160)
    debug('creating peer (from _generateOffers)')
    var peer = self.peers[offerId] = new Peer({
      initiator: true,
      trickle: false,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    })
    peer.once('signal', function (offer) {
      offers.push({
        offer: offer,
        offer_id: common.hexToBinary(offerId)
      })
      checkDone()
    })
    peer.trackerTimeout = setTimeout(function () {
      debug('tracker timeout: destroying peer')
      peer.trackerTimeout = null
      delete self.peers[offerId]
      peer.destroy()
    }, OFFER_TIMEOUT)
  }

  function checkDone () {
    if (offers.length === numwant) {
      debug('generated %s offers', numwant)
      cb(offers)
    }
  }
}

function noop () {}
