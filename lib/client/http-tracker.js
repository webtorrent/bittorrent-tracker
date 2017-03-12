module.exports = HTTPTracker

var arrayRemove = require('unordered-array-remove')
var bencode = require('bencode')
var compact2string = require('compact2string')
var debug = require('debug')('bittorrent-tracker:http-tracker')
var extend = require('xtend')
var get = require('simple-get')
var inherits = require('inherits')

var common = require('../common')
var Tracker = require('./tracker')

var HTTP_SCRAPE_SUPPORT = /\/(announce)[^/]*$/

inherits(HTTPTracker, Tracker)

/**
 * HTTP torrent tracker client (for an individual tracker)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         options object
 */
function HTTPTracker (client, announceUrl, opts) {
  var self = this
  Tracker.call(self, client, announceUrl)
  debug('new http tracker %s', announceUrl)

  // Determine scrape url (if http tracker supports it)
  self.scrapeUrl = null

  var match = self.announceUrl.match(HTTP_SCRAPE_SUPPORT)
  if (match) {
    var pre = self.announceUrl.slice(0, match.index)
    var post = self.announceUrl.slice(match.index + 9)
    self.scrapeUrl = pre + '/scrape' + post
  }

  self.cleanupFns = []
  self.maybeDestroyCleanup = null
}

HTTPTracker.prototype.DEFAULT_ANNOUNCE_INTERVAL = 30 * 60 * 1000 // 30 minutes

HTTPTracker.prototype.announce = function (opts) {
  var self = this
  if (self.destroyed) return

  var params = extend(opts, {
    compact: (opts.compact == null) ? 1 : opts.compact,
    info_hash: self.client._infoHashBinary,
    peer_id: self.client._peerIdBinary,
    port: self.client._port
  })
  if (self._trackerId) params.trackerid = self._trackerId

  self._request(self.announceUrl, params, function (err, data) {
    if (err) return self.client.emit('warning', err)
    self._onAnnounceResponse(data)
  })
}

HTTPTracker.prototype.scrape = function (opts) {
  var self = this
  if (self.destroyed) return

  if (!self.scrapeUrl) {
    self.client.emit('error', new Error('scrape not supported ' + self.announceUrl))
    return
  }

  var infoHashes = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
    ? opts.infoHash.map(function (infoHash) {
      return infoHash.toString('binary')
    })
    : (opts.infoHash && opts.infoHash.toString('binary')) || self.client._infoHashBinary
  var params = {
    info_hash: infoHashes
  }
  self._request(self.scrapeUrl, params, function (err, data) {
    if (err) return self.client.emit('warning', err)
    self._onScrapeResponse(data)
  })
}

HTTPTracker.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return cb(null)
  self.destroyed = true
  clearInterval(self.interval)

  // If there are no pending requests, destroy immediately.
  if (self.cleanupFns.length === 0) return destroyCleanup()

  // Otherwise, wait a short time for pending requests to complete, then force
  // destroy them.
  var timeout = setTimeout(destroyCleanup, common.DESTROY_TIMEOUT)

  // But, if all pending requests complete before the timeout fires, do cleanup
  // right away.
  self.maybeDestroyCleanup = function () {
    if (self.cleanupFns.length === 0) destroyCleanup()
  }

  function destroyCleanup () {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    self.maybeDestroyCleanup = null
    self.cleanupFns.slice(0).forEach(function (cleanup) {
      cleanup()
    })
    self.cleanupFns = []
    cb(null)
  }
}

HTTPTracker.prototype._request = function (requestUrl, params, cb) {
  var self = this
  var u = requestUrl + (requestUrl.indexOf('?') === -1 ? '?' : '&') +
    common.querystringStringify(params)

  self.cleanupFns.push(cleanup)

  var request = get.concat({
    url: u,
    timeout: common.REQUEST_TIMEOUT,
    headers: {
      'user-agent': self.client._userAgent || ''
    }
  }, onResponse)

  function cleanup () {
    if (request) {
      arrayRemove(self.cleanupFns, self.cleanupFns.indexOf(cleanup))
      request.abort()
      request = null
    }
    if (self.maybeDestroyCleanup) self.maybeDestroyCleanup()
  }

  function onResponse (err, res, data) {
    cleanup()
    if (self.destroyed) return

    if (err) return cb(err)
    if (res.statusCode !== 200) {
      return cb(new Error('Non-200 response code ' +
        res.statusCode + ' from ' + self.announceUrl))
    }
    if (!data || data.length === 0) {
      return cb(new Error('Invalid tracker response from' +
        self.announceUrl))
    }

    try {
      data = bencode.decode(data)
    } catch (err) {
      return cb(new Error('Error decoding tracker response: ' + err.message))
    }
    var failure = data['failure reason']
    if (failure) {
      debug('failure from ' + requestUrl + ' (' + failure + ')')
      return cb(new Error(failure))
    }

    var warning = data['warning message']
    if (warning) {
      debug('warning from ' + requestUrl + ' (' + warning + ')')
      self.client.emit('warning', new Error(warning))
    }

    debug('response from ' + requestUrl)

    cb(null, data)
  }
}

HTTPTracker.prototype._onAnnounceResponse = function (data) {
  var self = this

  var interval = data.interval || data['min interval']
  if (interval) self.setInterval(interval * 1000)

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  var response = Object.assign({}, data, {
    announce: self.announceUrl,
    infoHash: common.binaryToHex(data.info_hash)
  })
  self.client.emit('update', response)

  var addrs
  if (Buffer.isBuffer(data.peers)) {
    // tracker returned compact response
    try {
      addrs = compact2string.multi(data.peers)
    } catch (err) {
      return self.client.emit('warning', err)
    }
    addrs.forEach(function (addr) {
      self.client.emit('peer', addr)
    })
  } else if (Array.isArray(data.peers)) {
    // tracker returned normal response
    data.peers.forEach(function (peer) {
      self.client.emit('peer', peer.ip + ':' + peer.port)
    })
  }

  if (Buffer.isBuffer(data.peers6)) {
    // tracker returned compact response
    try {
      addrs = compact2string.multi6(data.peers6)
    } catch (err) {
      return self.client.emit('warning', err)
    }
    addrs.forEach(function (addr) {
      self.client.emit('peer', addr)
    })
  } else if (Array.isArray(data.peers6)) {
    // tracker returned normal response
    data.peers6.forEach(function (peer) {
      var ip = /^\[/.test(peer.ip) || !/:/.test(peer.ip)
        ? peer.ip /* ipv6 w/ brackets or domain name */
        : '[' + peer.ip + ']' /* ipv6 without brackets */
      self.client.emit('peer', ip + ':' + peer.port)
    })
  }
}

HTTPTracker.prototype._onScrapeResponse = function (data) {
  var self = this
  // NOTE: the unofficial spec says to use the 'files' key, 'host' has been
  // seen in practice
  data = data.files || data.host || {}

  var keys = Object.keys(data)
  if (keys.length === 0) {
    self.client.emit('warning', new Error('invalid scrape response'))
    return
  }

  keys.forEach(function (infoHash) {
    // TODO: optionally handle data.flags.min_request_interval
    // (separate from announce interval)
    var response = Object.assign(data[infoHash], {
      announce: self.announceUrl,
      infoHash: common.binaryToHex(infoHash)
    })
    self.client.emit('scrape', response)
  })
}
