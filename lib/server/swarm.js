module.exports = Swarm

var debug = require('debug')('bittorrent-tracker')
var randomIterate = require('random-iterate')

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.createSwarm() and Server.getSwarm()
function Swarm (infoHash, server) {
  this.peers = {}
  this.complete = 0
  this.incomplete = 0
}

Swarm.prototype.announce = function (params, cb) {
  var self = this
  var id = params.type === 'ws' ? params.peer_id : params.addr
  var peer = self.peers[id]

  if (params.event === 'started') {
    self._onAnnounceStarted(params, peer)
  } else if (params.event === 'stopped') {
    self._onAnnounceStopped(params, peer)
  } else if (params.event === 'completed') {
    self._onAnnounceCompleted(params, peer)
  } else if (params.event === 'update') {
    self._onAnnounceUpdate(params, peer)
  } else {
    cb(new Error('invalid event'))
    return
  }
  cb(null, {
    complete: self.complete,
    incomplete: self.incomplete,
    peers: self._getPeers(params.numwant, params.peer_id, !!params.socket)
  })
}

Swarm.prototype.scrape = function (params, cb) {
  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete
  })
}

Swarm.prototype._onAnnounceStarted = function (params, peer) {
  if (peer) {
    debug('unexpected `started` event from peer that is already in swarm')
    return this._onAnnounceUpdate(params, peer) // treat as an update
  }

  if (params.left === 0) this.complete += 1
  else this.incomplete += 1
  var id = params.type === 'ws' ? params.peer_id : params.addr
  peer = this.peers[id] = {
    type: params.type,
    complete: params.left === 0,
    peerId: params.peer_id, // as hex
    ip: params.ip,
    port: params.port,
    socket: params.socket // only websocket
  }
}

Swarm.prototype._onAnnounceStopped = function (params, peer) {
  if (!peer) {
    debug('unexpected `stopped` event from peer that is not in swarm')
    return // do nothing
  }

  if (peer.complete) this.complete -= 1
  else this.incomplete -= 1
  var id = params.type === 'ws' ? params.peer_id : params.addr
  delete this.peers[id]
}

Swarm.prototype._onAnnounceCompleted = function (params, peer) {
  if (!peer) {
    debug('unexpected `completed` event from peer that is not in swarm')
    return this._onAnnounceStarted(params, peer) // treat as a start
  }
  if (peer.complete) {
    debug('unexpected `completed` event from peer that is already marked as completed')
    return // do nothing
  }

  this.complete += 1
  this.incomplete -= 1
  peer.complete = true
}

Swarm.prototype._onAnnounceUpdate = function (params, peer) {
  if (!peer) {
    debug('unexpected `update` event from peer that is not in swarm')
    return this._onAnnounceStarted(params, peer) // treat as a start
  }

  if (!peer.complete && params.left === 0) {
    this.complete += 1
    this.incomplete -= 1
    peer.complete = true
  }
}

Swarm.prototype._getPeers = function (numwant, ownPeerId, isWebRTC) {
  var peers = []
  var ite = randomIterate(Object.keys(this.peers))
  var peerId
  while ((peerId = ite()) && peers.length < numwant) {
    var peer = this.peers[peerId]
    if (isWebRTC && peer.peerId === ownPeerId) continue // don't send peer to itself
    if ((isWebRTC && peer.type !== 'ws') || (!isWebRTC && peer.type === 'ws')) continue // send proper peer type
    peers.push(peer)
  }
  return peers
}
