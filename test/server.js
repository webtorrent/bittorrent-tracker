var Client = require('../').Client
var portfinder = require('portfinder')
var Server = require('../').Server
var test = require('tape')

var peerId = new Buffer('12345678901234567890')
var infoHash = new Buffer('4cb67059ed6bd08362da625b3ae77f6f4a075705', 'hex')
var torrentLength = 50000

test('server', function (t) {
  t.plan(12)

  var server = new Server() // { interval: 50000, compactOnly: false }

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('start', function () {
    t.pass('got start message')
  })
  server.on('complete', function () {})
  server.on('update', function () {})
  server.on('stop', function () {})

  server.on('listening', function () {
    t.pass('server listening')
  })

  // server.torrents //
  // server.torrents[infoHash] //
  // server.torrents[infoHash].complete //
  // server.torrents[infoHash].incomplete //
  // server.torrents[infoHash].peers //

  portfinder.getPort(function (err, port) {
    t.error(err, 'found free port')
    server.listen(port)

    var announceUrl = 'http://127.0.0.1:' + port + '/announce'

    var client = new Client(peerId, 6881, {
      infoHash: infoHash,
      length: torrentLength,
      announce: [ announceUrl ]
    })

    client.start()

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.complete, 0)
      t.equal(data.incomplete, 1)

      client.complete()

      client.once('update', function (data) {
        t.equal(data.announce, announceUrl)
        t.equal(data.complete, 1)
        t.equal(data.incomplete, 0)

        client.stop()

        client.once('update', function (data) {
          t.equal(data.announce, announceUrl)
          t.equal(data.complete, 0)
          t.equal(data.incomplete, 0)

          server.close()
        })
      })
    })
  })
})
