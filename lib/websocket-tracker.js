// TODO: cleanup unused Peers when tracker doesn't respond with matches

module.exports = WebSocketTracker

var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var Peer = require('simple-peer')
var Socket = require('simple-websocket')

var common = require('./common')

// Use a socket pool, so tracker clients share WebSocket objects for the same server.
// In practice, WebSockets are pretty slow to establish, so this gives a nice performance
// boost, and saves browser resources.
var socketPool = {}

var RECONNECT_VARIANCE = 30 * 1000
var RECONNECT_MINIMUM = 5 * 1000

inherits(WebSocketTracker, EventEmitter)

function WebSocketTracker (client, announceUrl, opts) {
  var self = this
  EventEmitter.call(self)
  debug('new websocket tracker %s', announceUrl)

  self.client = client
  self.destroyed = false

  self._opts = opts

  if (announceUrl[announceUrl.length - 1] === '/') {
    announceUrl = announceUrl.substring(0, announceUrl.length - 1)
  }
  self._announceUrl = announceUrl

  self._peers = {} // peers (offer id -> peer)
  self._socket = null
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  self._openSocket()
}

WebSocketTracker.prototype.announce = function (opts) {
  var self = this
  if (self.destroyed) return
  if (!self._socket.connected) {
    return self._socket.once('connect', self.announce.bind(self, opts))
  }

  // TODO: Limit number of offers (temporarily)
  // TODO: remove this when we cleanup old RTCPeerConnections cleanly
  var numwant = Math.min(opts.numwant, 10)

  self._generateOffers(numwant, function (offers) {
    var params = {
      numwant: numwant,
      uploaded: opts.uploaded || 0,
      downloaded: opts.downloaded,
      event: opts.event,
      info_hash: self.client._infoHashBinary,
      peer_id: self.client._peerIdBinary,
      offers: offers
    }
    if (self._trackerId) params.trackerid = self._trackerId

    self._send(params)
  })
}

WebSocketTracker.prototype.scrape = function (opts) {
  var self = this
  if (self.destroyed) return
  self._onSocketError(new Error('scrape not supported ' + self._announceUrl))
}

// TODO: Improve this interface
WebSocketTracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    // HACK
    var update = self.announce.bind(self, self.client._defaultAnnounceOpts())
    self._interval = setInterval(update, self._intervalMs)
  }
}

WebSocketTracker.prototype.destroy = function (onclose) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true

  self._socket.removeListener('data', self._onSocketDataBound)
  self._socket.removeListener('close', self._onSocketCloseBound)
  self._socket.removeListener('error', self._onSocketErrorBound)

  self._onSocketErrorBound = null
  self._onSocketDataBound = null
  self._onSocketCloseBound = null

  self._socket.on('error', noop) // ignore all future errors
  try {
    self._socket.destroy(onclose)
  } catch (err) {
    if (onclose) onclose()
  }

  self._socket = null
}

WebSocketTracker.prototype._openSocket = function () {
  var self = this
  self._onSocketErrorBound = self._onSocketError.bind(self)
  self._onSocketDataBound = self._onSocketData.bind(self)
  self._onSocketCloseBound = self._onSocketClose.bind(self)

  self._socket = socketPool[self._announceUrl]
  if (!self._socket) {
    self._socket = socketPool[self._announceUrl] = new Socket(self._announceUrl)
  }

  self._socket.on('data', self._onSocketDataBound)
  self._socket.on('close', self._onSocketCloseBound)
  self._socket.on('error', self._onSocketErrorBound)
}

WebSocketTracker.prototype._onSocketData = function (data) {
  var self = this
  if (self.destroyed) return

  if (!(typeof data === 'object' && data !== null)) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  if (data.info_hash !== self.client._infoHashBinary) {
    debug(
      'ignoring websocket data from %s for %s (looking for %s: reused socket)',
      self._announceUrl, common.binaryToHex(data.info_hash), self.client._infoHashHex
    )
    return
  }

  if (data.peer_id && data.peer_id === self.client._peerIdBinary) {
    // ignore offers/answers from this client
    return
  }

  debug(
    'received %s from %s for %s',
    JSON.stringify(data), self._announceUrl, self.client._infoHashHex
  )

  var failure = data['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = data['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

  var interval = data.interval || data['min interval']
  if (interval && !self._opts.interval && self._intervalMs !== 0) {
    // use the interval the tracker recommends, UNLESS the user manually specifies an
    // interval they want to use
    self.setInterval(interval * 1000)
  }

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  if (data.complete) {
    self.client.emit('update', {
      announce: self._announceUrl,
      complete: data.complete,
      incomplete: data.incomplete
    })
  }

  var peer
  if (data.offer && data.peer_id) {
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
    peer = self._peers[common.binaryToHex(data.offer_id)]
    if (peer) {
      peer.id = common.binaryToHex(data.peer_id)
      peer.signal(data.answer)
      self.client.emit('peer', peer)
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

  var reconnectTimer = setTimeout(function () {
    self.destroyed = false
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
  self._socket.send(message)
}

WebSocketTracker.prototype._generateOffers = function (numwant, cb) {
  var self = this
  var offers = []
  debug('generating %s offers', numwant)

  // TODO: cleanup dead peers and peers that never get a return offer, from self._peers
  for (var i = 0; i < numwant; ++i) {
    generateOffer()
  }

  function generateOffer () {
    var offerId = hat(160)
    var peer = self._peers[offerId] = new Peer({
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
  }

  function checkDone () {
    if (offers.length === numwant) {
      debug('generated %s offers', numwant)
      cb(offers)
    }
  }
}

function noop () {}
