var Buffer = require('safe-buffer').Buffer
var Client = require('../')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)

  var opts = { serverType: serverType } // this is test-suite-only option
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      cb(infoHash !== fixtures.alice.parsedTorrent.infoHash)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId: peerId,
          port: 6881,
          wrtc: {}
        })
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
      if (infoHash === fixtures.alice.parsedTorrent.infoHash) cb(new Error('alice blocked'))
      else cb(true)
    })
  }

  common.createServer(t, opts, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.alice.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId, port: 6881,
      wrtc: {}
    })

    client.on('error', function (err) { t.error(err) })
    if (serverType === 'ws') common.mockWebsocketTracker(client)

    client.once('warning', function (err) {
      t.ok(/alice blocked/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId: peerId,
          port: 6881,
          wrtc: {}
        })
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
      t.ok(/alice blocked/.test(err.message), 'got server warning')
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
