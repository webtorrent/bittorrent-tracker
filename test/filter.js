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
  t.plan(6)
  var opts = serverType === 'http' ? { udp: false } : { http: false }
  opts.filter = function (infoHash) {
    return infoHash !== parsedBitlove.infoHash
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

      client.destroy()
      client = new Client(peerId, port, parsedLeaves)

      client.on('error', function (err) {
        t.error(err)
      })
      client.on('warning', function (err) {
        t.error(err)
      })

      client.on('update', function () {
        t.pass('got announce')
        client.destroy()
        server.close(function () {
          t.pass('server closed')
        })
      })

      server.on('start', function () {
        t.equal(Object.keys(server.torrents).length, 1)
      })

      client.start()
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
