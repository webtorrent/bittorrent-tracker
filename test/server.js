var Client = require('../').Client
var portfinder = require('portfinder')
var Server = require('../').Server
var test = require('tape')

// TODO: add tests to verify that the correct downloaded/left/uploaded numbers are
// being sent

var infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
var peerId = '01234567890123456789'
var peerId2 = '12345678901234567890'
var torrentLength = 50000

test('server', function (t) {
  t.plan(26)

  var server = new Server() // { interval: 50000, compactOnly: false }

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('complete', function () {})
  server.on('update', function () {})
  server.on('stop', function () {})

  server.on('listening', function () {
    t.pass('server listening')
  })

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

    server.once('start', function () {
      t.pass('got start message from client1')
    })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.complete, 0)
      t.equal(data.incomplete, 1)

      t.equal(Object.keys(server.torrents).length, 1)
      t.equal(server.torrents[infoHash].complete, 0)
      t.equal(server.torrents[infoHash].incomplete, 1)
      t.equal(Object.keys(server.torrents[infoHash].peers).length, 1)
      t.deepEqual(server.torrents[infoHash].peers['127.0.0.1:6881'], {
        ip: '127.0.0.1',
        port: 6881,
        peerId: peerId
      })

      client.complete()

      client.once('update', function (data) {
        t.equal(data.announce, announceUrl)
        t.equal(data.complete, 1)
        t.equal(data.incomplete, 0)

        client.scrape()

        client.once('scrape', function (data) {
          t.equal(data.announce, announceUrl)
          t.equal(typeof data.complete, 'number')
          t.equal(typeof data.incomplete, 'number')
          t.equal(typeof data.downloaded, 'number')

          var client2 = new Client(peerId2, 6882, {
            infoHash: infoHash,
            length: torrentLength,
            announce: [ announceUrl ]
          })

          client2.start()

          server.once('start', function () {
            t.pass('got start message from client2')
          })

          client2.once('peer', function (addr) {
            t.equal(addr, '127.0.0.1:6881')

            client2.stop()
            client2.once('update', function (data) {
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
    })
  })
})
