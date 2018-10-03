const debug = require('debug')('bittorrent-tracker:websocket-tracker')
const Peer = require('simple-peer')
const randombytes = require('randombytes')
const Socket = require('simple-websocket')

const common = require('../common')
const Tracker = require('./tracker')

// Use a socket pool, so tracker clients share WebSocket objects for the same server.
// In practice, WebSockets are pretty slow to establish, so this gives a nice performance
// boost, and saves browser resources.
const socketPool = {}

const RECONNECT_MINIMUM = 15 * 1000
const RECONNECT_MAXIMUM = 30 * 60 * 1000
const RECONNECT_VARIANCE = 30 * 1000
const OFFER_TIMEOUT = 50 * 1000

class WebSocketTracker extends Tracker {
  constructor (client, announceUrl, opts) {
    super(client, announceUrl)
    const self = this
    debug('new websocket tracker %s', announceUrl)

    self.peers = {} // peers (offer id -> peer)
    self.socket = null

    self.reconnecting = false
    self.retries = 0
    self.reconnectTimer = null

    // Simple boolean flag to track whether the socket has received data from
    // the websocket server since the last time socket.send() was called.
    self.expectingResponse = false

    self._openSocket()
  }

  announce (opts) {
    const self = this
    if (self.destroyed || self.reconnecting) return
    if (!self.socket.connected) {
      self.socket.once('connect', () => {
        self.announce(opts)
      })
      return
    }

    const params = Object.assign({}, opts, {
      action: 'announce',
      info_hash: self.client._infoHashBinary,
      peer_id: self.client._peerIdBinary
    })
    if (self._trackerId) params.trackerid = self._trackerId

    if (opts.event === 'stopped' || opts.event === 'completed') {
      // Don't include offers with 'stopped' or 'completed' event
      self._send(params)
    } else {
      // Limit the number of offers that are generated, since it can be slow
      const numwant = Math.min(opts.numwant, 10)

      self._generateOffers(numwant, offers => {
        params.numwant = numwant
        params.offers = offers
        self._send(params)
      })
    }
  }

  scrape (opts) {
    const self = this
    if (self.destroyed || self.reconnecting) return
    if (!self.socket.connected) {
      self.socket.once('connect', () => {
        self.scrape(opts)
      })
      return
    }

    const infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
      ? opts.infoHash.map(infoHash => {
        return infoHash.toString('binary')
      })
      : (opts.infoHash && opts.infoHash.toString('binary')) || self.client._infoHashBinary
    const params = {
      action: 'scrape',
      info_hash: infoHashes
    }

    self._send(params)
  }

  destroy (cb) {
    const self = this
    if (!cb) cb = noop
    if (self.destroyed) return cb(null)

    self.destroyed = true

    clearInterval(self.interval)
    clearTimeout(self.reconnectTimer)

    // Destroy peers
    for (const peerId in self.peers) {
      const peer = self.peers[peerId]
      clearTimeout(peer.trackerTimeout)
      peer.destroy()
    }
    self.peers = null

    if (self.socket) {
      self.socket.removeListener('connect', self._onSocketConnectBound)
      self.socket.removeListener('data', self._onSocketDataBound)
      self.socket.removeListener('close', self._onSocketCloseBound)
      self.socket.removeListener('error', self._onSocketErrorBound)
      self.socket = null
    }

    self._onSocketConnectBound = null
    self._onSocketErrorBound = null
    self._onSocketDataBound = null
    self._onSocketCloseBound = null

    if (socketPool[self.announceUrl]) {
      socketPool[self.announceUrl].consumers -= 1
    }

    // Other instances are using the socket, so there's nothing left to do here
    if (socketPool[self.announceUrl].consumers > 0) return cb()

    let socket = socketPool[self.announceUrl]
    delete socketPool[self.announceUrl]
    socket.on('error', noop) // ignore all future errors
    socket.once('close', cb)

    // If there is no data response expected, destroy immediately.
    if (!self.expectingResponse) return destroyCleanup()

    // Otherwise, wait a short time for potential responses to come in from the
    // server, then force close the socket.
    var timeout = setTimeout(destroyCleanup, common.DESTROY_TIMEOUT)

    // But, if a response comes from the server before the timeout fires, do cleanup
    // right away.
    socket.once('data', destroyCleanup)

    function destroyCleanup () {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      socket.removeListener('data', destroyCleanup)
      socket.destroy()
      socket = null
    }
  }

  _openSocket () {
    const self = this
    self.destroyed = false

    if (!self.peers) self.peers = {}

    self._onSocketConnectBound = () => {
      self._onSocketConnect()
    }
    self._onSocketErrorBound = err => {
      self._onSocketError(err)
    }
    self._onSocketDataBound = data => {
      self._onSocketData(data)
    }
    self._onSocketCloseBound = () => {
      self._onSocketClose()
    }

    self.socket = socketPool[self.announceUrl]
    if (self.socket) {
      socketPool[self.announceUrl].consumers += 1
    } else {
      self.socket = socketPool[self.announceUrl] = new Socket(self.announceUrl)
      self.socket.consumers = 1
      self.socket.once('connect', self._onSocketConnectBound)
    }

    self.socket.on('data', self._onSocketDataBound)
    self.socket.once('close', self._onSocketCloseBound)
    self.socket.once('error', self._onSocketErrorBound)
  }

  _onSocketConnect () {
    const self = this
    if (self.destroyed) return

    if (self.reconnecting) {
      self.reconnecting = false
      self.retries = 0
      self.announce(self.client._defaultAnnounceOpts())
    }
  }

  _onSocketData (data) {
    const self = this
    if (self.destroyed) return

    self.expectingResponse = false

    try {
      data = JSON.parse(data)
    } catch (err) {
      self.client.emit('warning', new Error('Invalid tracker response'))
      return
    }

    if (data.action === 'announce') {
      self._onAnnounceResponse(data)
    } else if (data.action === 'scrape') {
      self._onScrapeResponse(data)
    } else {
      self._onSocketError(new Error(`invalid action in WS response: ${data.action}`))
    }
  }

  _onAnnounceResponse (data) {
    const self = this

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

    const failure = data['failure reason']
    if (failure) return self.client.emit('warning', new Error(failure))

    const warning = data['warning message']
    if (warning) self.client.emit('warning', new Error(warning))

    const interval = data.interval || data['min interval']
    if (interval) self.setInterval(interval * 1000)

    const trackerId = data['tracker id']
    if (trackerId) {
      // If absent, do not discard previous trackerId value
      self._trackerId = trackerId
    }

    if (data.complete != null) {
      const response = Object.assign({}, data, {
        announce: self.announceUrl,
        infoHash: common.binaryToHex(data.info_hash)
      })
      self.client.emit('update', response)
    }

    let peer
    if (data.offer && data.peer_id) {
      debug('creating peer (from remote offer)')
      peer = self._createPeer()
      peer.id = common.binaryToHex(data.peer_id)
      peer.once('signal', answer => {
        const params = {
          action: 'announce',
          info_hash: self.client._infoHashBinary,
          peer_id: self.client._peerIdBinary,
          to_peer_id: data.peer_id,
          answer,
          offer_id: data.offer_id
        }
        if (self._trackerId) params.trackerid = self._trackerId
        self._send(params)
      })
      peer.signal(data.offer)
      self.client.emit('peer', peer)
    }

    if (data.answer && data.peer_id) {
      const offerId = common.binaryToHex(data.offer_id)
      peer = self.peers[offerId]
      if (peer) {
        peer.id = common.binaryToHex(data.peer_id)
        peer.signal(data.answer)
        self.client.emit('peer', peer)

        clearTimeout(peer.trackerTimeout)
        peer.trackerTimeout = null
        delete self.peers[offerId]
      } else {
        debug(`got unexpected answer: ${JSON.stringify(data.answer)}`)
      }
    }
  }

  _onScrapeResponse (data) {
    const self = this
    data = data.files || {}

    const keys = Object.keys(data)
    if (keys.length === 0) {
      self.client.emit('warning', new Error('invalid scrape response'))
      return
    }

    keys.forEach(infoHash => {
      // TODO: optionally handle data.flags.min_request_interval
      // (separate from announce interval)
      const response = Object.assign(data[infoHash], {
        announce: self.announceUrl,
        infoHash: common.binaryToHex(infoHash)
      })
      self.client.emit('scrape', response)
    })
  }

  _onSocketClose () {
    const self = this
    if (self.destroyed) return
    self.destroy()
    self._startReconnectTimer()
  }

  _onSocketError (err) {
    const self = this
    if (self.destroyed) return
    self.destroy()
    // errors will often happen if a tracker is offline, so don't treat it as fatal
    self.client.emit('warning', err)
    self._startReconnectTimer()
  }

  _startReconnectTimer () {
    const self = this
    const ms = Math.floor(Math.random() * RECONNECT_VARIANCE) + Math.min(Math.pow(2, self.retries) * RECONNECT_MINIMUM, RECONNECT_MAXIMUM)

    self.reconnecting = true
    clearTimeout(self.reconnectTimer)
    self.reconnectTimer = setTimeout(() => {
      self.retries++
      self._openSocket()
    }, ms)
    if (self.reconnectTimer.unref) self.reconnectTimer.unref()

    debug('reconnecting socket in %s ms', ms)
  }

  _send (params) {
    const self = this
    if (self.destroyed) return
    self.expectingResponse = true
    const message = JSON.stringify(params)
    debug('send %s', message)
    self.socket.send(message)
  }

  _generateOffers (numwant, cb) {
    const self = this
    const offers = []
    debug('generating %s offers', numwant)

    for (let i = 0; i < numwant; ++i) {
      generateOffer()
    }
    checkDone()

    function generateOffer () {
      const offerId = randombytes(20).toString('hex')
      debug('creating peer (from _generateOffers)')
      const peer = self.peers[offerId] = self._createPeer({ initiator: true })
      peer.once('signal', offer => {
        offers.push({
          offer,
          offer_id: common.hexToBinary(offerId)
        })
        checkDone()
      })
      peer.trackerTimeout = setTimeout(() => {
        debug('tracker timeout: destroying peer')
        peer.trackerTimeout = null
        delete self.peers[offerId]
        peer.destroy()
      }, OFFER_TIMEOUT)
      if (peer.trackerTimeout.unref) peer.trackerTimeout.unref()
    }

    function checkDone () {
      if (offers.length === numwant) {
        debug('generated %s offers', numwant)
        cb(offers)
      }
    }
  }

  _createPeer (opts) {
    const self = this

    opts = Object.assign({
      trickle: false,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    }, opts)

    const peer = new Peer(opts)

    peer.once('error', onError)
    peer.once('connect', onConnect)

    return peer

    // Handle peer 'error' events that are fired *before* the peer is emitted in
    // a 'peer' event.
    function onError (err) {
      self.client.emit('warning', new Error(`Connection error: ${err.message}`))
      peer.destroy()
    }

    // Once the peer is emitted in a 'peer' event, then it's the consumer's
    // responsibility to listen for errors, so the listeners are removed here.
    function onConnect () {
      peer.removeListener('error', onError)
      peer.removeListener('connect', onConnect)
    }
  }
}

WebSocketTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 1000 // 30 seconds
// Normally this shouldn't be accessed but is occasionally useful
WebSocketTracker._socketPool = socketPool

function noop () {}

module.exports = WebSocketTracker
