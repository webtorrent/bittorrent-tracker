var Client = require('../')
var common = require('./common')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var path = require('path')
var test = require('tape')

var bitlove = fs.readFileSync(path.join(__dirname, 'torrents/bitlove-intro.torrent'))
var parsedBitlove = parseTorrent(bitlove)

var leaves = fs.readFileSync(path.join(__dirname, 'torrents/leaves.torrent'))
var parsedLeaves = parseTorrent(leaves)

var peerId = new Buffer('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      cb(infoHash !== parsedBitlove.infoHash)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    parsedBitlove.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, 6881, parsedBitlove, { wrtc: {} })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, 6881, parsedLeaves, { wrtc: {} })
        if (serverType === 'ws') common.mockWebsocketTracker(client)

        client.on('error', function (err) { t.error(err) })
        client.on('warning', function (err) { t.error(err) })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () { t.pass('client destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client.start()
  })
}

test('http: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'http')
})

test('udp: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'udp')
})

test('ws: filter option blocks tracker from tracking torrent', function (t) {
  testFilterOption(t, 'ws')
})

function testFilterCustomError (t, serverType) {
  t.plan(8)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      if (infoHash === parsedBitlove.infoHash) cb(new Error('bitlove blocked'))
      else cb(true)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    parsedBitlove.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, 6881, parsedBitlove, { wrtc: {} })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/bitlove blocked/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, 6881, parsedLeaves, { wrtc: {} })
        if (serverType === 'ws') common.mockWebsocketTracker(client)

        client.on('error', function (err) { t.error(err) })
        client.on('warning', function (err) { t.error(err) })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () { t.pass('client destroyed') })
          server.close(function () { t.pass('server closed') })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

    server.removeAllListeners('warning')
    server.once('warning', function (err) {
      t.ok(/bitlove blocked/.test(err.message), 'got server warning')
      t.equal(Object.keys(server.torrents).length, 0)
    })

    client.start()
  })
}

test('http: filter option with custom error', function (t) {
  testFilterCustomError(t, 'http')
})

test('udp: filter option filter option with custom error', function (t) {
  testFilterCustomError(t, 'udp')
})

test('ws: filter option filter option with custom error', function (t) {
  testFilterCustomError(t, 'ws')
})
