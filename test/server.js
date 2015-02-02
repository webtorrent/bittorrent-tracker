var Client = require('../')
var Server = require('../').Server
var test = require('tape')

var infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
var peerId = new Buffer('01234567890123456789')
var peerId2 = new Buffer('12345678901234567890')
var torrentLength = 50000

function serverTest (t, serverType, serverFamily) {
  t.plan(26)

  var opts = serverType === 'http' ? { udp: false } : { http: false }
  var server = new Server(opts)
  var serverAddr = serverFamily === 'inet6' ? '[::1]' : '127.0.0.1'
  var clientAddr = serverFamily === 'inet6' ? '[::1]' : '127.0.0.1'
  var clientIp = serverFamily === 'inet6' ? '::1' : '127.0.0.1'

  server.on('error', function (err) {
    t.fail(err.message)
  })

  server.on('warning', function (err) {
    t.fail(err.message)
  })

  server.on('listening', function () {
    t.pass('server listening')
  })

  server.listen(0, function () {
    var port = server[serverType].address().port
    var announceUrl = serverType + '://' + serverAddr + ':' + port + '/announce'

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
      t.equal(server.getSwarm(infoHash).complete, 0)
      t.equal(server.getSwarm(infoHash).incomplete, 1)
      t.equal(Object.keys(server.getSwarm(infoHash).peers).length, 1)
      t.deepEqual(server.getSwarm(infoHash).peers[clientAddr + ':6881'], {
        ip: clientIp,
        port: 6881,
        peerId: peerId.toString('hex'),
        complete: false
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
            t.equal(addr, clientAddr + ':6881')

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

                server.close(function () {
                  t.pass('server closed')
                })
              })
            })
          })
        })
      })
    })
  })
}

test('http ipv4 server', function (t) {
  serverTest(t, 'http', 'inet')
})

test('http ipv6 server', function (t) {
  serverTest(t, 'http', 'inet6')
})

test('udp server', function (t) {
  serverTest(t, 'udp', 'inet')
})
