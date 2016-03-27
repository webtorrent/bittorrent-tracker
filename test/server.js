var Client = require('../')
var common = require('./common')
var test = require('tape')
var wrtc = require('electron-webrtc')()

var wrtcReady = false
wrtc.electronDaemon.once('ready', function () {
  wrtcReady = true
})

var infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
var peerId = new Buffer('01234567890123456789')
var peerId2 = new Buffer('12345678901234567890')
var torrentLength = 50000

function serverTest (t, serverType, serverFamily) {
  t.plan(30)

  var hostname = serverFamily === 'inet6'
    ? '[::1]'
    : '127.0.0.1'
  var clientIp = serverFamily === 'inet6'
    ? '::1'
    : '127.0.0.1'

  common.createServer(t, serverType, function (server) {
    var port = server[serverType].address().port
    var announceUrl = serverType + '://' + hostname + ':' + port + '/announce'

    var client1 = new Client(peerId, 6881, {
      infoHash: infoHash,
      length: torrentLength,
      announce: [ announceUrl ]
    }, { wrtc: wrtc })

    client1.start()

    server.once('start', function () {
      t.pass('got start message from client1')
    })

    client1.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.complete, 0)
      t.equal(data.incomplete, 1)

      server.getSwarm(infoHash, function (err, swarm) {
        t.error(err)

        t.equal(Object.keys(server.torrents).length, 1)
        t.equal(swarm.complete, 0)
        t.equal(swarm.incomplete, 1)
        t.equal(Object.keys(swarm.peers).length, 1)

        var id = serverType === 'ws'
          ? peerId.toString('hex')
          : hostname + ':6881'

        t.equal(swarm.peers[id].type, serverType)
        t.equal(swarm.peers[id].ip, clientIp)
        t.equal(swarm.peers[id].peerId, peerId.toString('hex'))
        t.equal(swarm.peers[id].complete, false)
        if (serverType === 'ws') {
          t.equal(typeof swarm.peers[id].port, 'number')
          t.ok(swarm.peers[id].socket)
        } else {
          t.equal(swarm.peers[id].port, 6881)
          t.notOk(swarm.peers[id].socket)
        }

        client1.complete()

        client1.once('update', function (data) {
          t.equal(data.announce, announceUrl)
          t.equal(data.complete, 1)
          t.equal(data.incomplete, 0)

          client1.scrape()

          client1.once('scrape', function (data) {
            t.equal(data.announce, announceUrl)
            t.equal(typeof data.complete, 'number')
            t.equal(typeof data.incomplete, 'number')
            t.equal(typeof data.downloaded, 'number')

            var client2 = new Client(peerId2, 6882, {
              infoHash: infoHash,
              length: torrentLength,
              announce: [ announceUrl ]
            }, { wrtc: wrtc })

            client2.start()

            server.once('start', function () {
              t.pass('got start message from client2')
            })

            client2.once('peer', function (addr) {
              t.ok(addr === hostname + ':6881' || addr === hostname + ':6882' || addr.id === peerId.toString('hex'))

              client2.stop()
              client2.once('update', function (data) {
                t.equal(data.announce, announceUrl)
                t.equal(data.complete, 1)
                t.equal(data.incomplete, 0)
                client2.destroy()

                client1.stop()
                client1.once('update', function (data) {
                  t.equal(data.announce, announceUrl)
                  t.equal(data.complete, 0)
                  t.equal(data.incomplete, 0)

                  client1.destroy(function () {
                    server.close()
                    if (serverType === 'ws') wrtc.close()
                  })
                })
              })
            })
          })
        })
      })
    })
  })
}

test('websocket server', function (t) {
  if (wrtcReady) {
    runTest()
  } else {
    wrtc.electronDaemon.once('ready', runTest)
  }
  function runTest () {
    serverTest(t, 'ws', 'inet')
  }
})

test('http ipv4 server', function (t) {
  serverTest(t, 'http', 'inet')
})

test('http ipv6 server', function (t) {
  serverTest(t, 'http', 'inet6')
})

test('udp server', function (t) {
  serverTest(t, 'udp', 'inet')
})
