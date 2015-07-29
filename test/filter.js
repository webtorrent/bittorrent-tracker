var Client = require('../')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var Server = require('../').Server
var test = require('tape')

var bitlove = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedBitlove = parseTorrent(bitlove)

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var parsedLeaves = parseTorrent(leaves)

var peerId = new Buffer('01234567890123456789')

function testFilterOption (t, serverType) {
  t.plan(8)
  var opts = serverType === 'http' ? { udp: false, ws: false } : { http: false, ws: false }
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      cb(infoHash !== parsedBitlove.infoHash)
    })
  }
  var server = new Server(opts)

  server.on('error', function (err) {
    t.error(err)
  })

  server.listen(0, function () {
    var port = server[serverType].address().port
    var announceUrl = serverType === 'http'
      ? 'http://127.0.0.1:' + port + '/announce'
      : 'udp://127.0.0.1:' + port

    parsedBitlove.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, port, parsedBitlove)

    client.on('error', function (err) {
      t.error(err)
    })

    client.once('warning', function (err) {
      t.ok(/disallowed info_hash/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, port, parsedLeaves)

        client.on('error', function (err) {
          t.error(err)
        })
        client.on('warning', function (err) {
          t.error(err)
        })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () {
            t.pass('client destroyed')
          })
          server.close(function () {
            t.pass('server closed')
          })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

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

function testFilterCustomError (t, serverType) {
  t.plan(8)
  var opts = serverType === 'http' ? { udp: false, ws: false } : { http: false, ws: false }
  opts.filter = function (infoHash, params, cb) {
    process.nextTick(function () {
      if (infoHash === parsedBitlove.infoHash) cb(new Error('bitlove blocked'))
      else cb(true)
    })
  }
  var server = new Server(opts)

  server.on('error', function (err) {
    t.error(err)
  })

  server.listen(0, function () {
    var port = server[serverType].address().port
    var announceUrl = serverType === 'http'
      ? 'http://127.0.0.1:' + port + '/announce'
      : 'udp://127.0.0.1:' + port

    parsedBitlove.announce = [ announceUrl ]
    parsedLeaves.announce = [ announceUrl ]

    var client = new Client(peerId, port, parsedBitlove)

    client.on('error', function (err) {
      t.error(err)
    })

    client.once('warning', function (err) {
      t.ok(/bitlove blocked/.test(err.message), 'got client warning')

      client.destroy(function () {
        t.pass('client destroyed')
        client = new Client(peerId, port, parsedLeaves)

        client.on('error', function (err) {
          t.error(err)
        })
        client.on('warning', function (err) {
          t.error(err)
        })

        client.on('update', function () {
          t.pass('got announce')
          client.destroy(function () {
            t.pass('client destroyed')
          })
          server.close(function () {
            t.pass('server closed')
          })
        })

        server.on('start', function () {
          t.equal(Object.keys(server.torrents).length, 1)
        })

        client.start()
      })
    })

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
