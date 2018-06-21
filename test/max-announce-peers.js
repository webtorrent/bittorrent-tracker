var Buffer = require('safe-buffer').Buffer
var Client = require('../')
var common = require('./common')
var test = require('tape')

var wrtc

var infoHash = '4cb67059ed6bd08362da625b3ae77f6f4a075705'
var peerId = Buffer.from('01234567890123456789')
var peerId2 = Buffer.from('12345678901234567890')
var peerId3 = Buffer.from('23456789012345678901')

function serverTest (t, serverType, serverFamily) {
  t.plan(4)

  var hostname = serverFamily === 'inet6'
    ? '[::1]'
    : '127.0.0.1'

  var opts = {
    serverType: serverType,
    maxAnnouncePeers: 1
  }

  common.createServer(t, opts, function (server) {
    // Not using announceUrl param from `common.createServer()` since we
    // want to control IPv4 vs IPv6.
    var port = server[serverType].address().port
    var announceUrl = serverType + '://' + hostname + ':' + port + '/announce'

    var client1 = new Client({
      infoHash: infoHash,
      announce: [ announceUrl ],
      peerId: peerId,
      port: 6881,
      wrtc: wrtc
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client1)

    client1.start()

    client1.once('update', function (data) {
      var client2 = new Client({
        infoHash: infoHash,
        announce: [ announceUrl ],
        peerId: peerId2,
        port: 6882,
        wrtc: wrtc
      })
      if (serverType === 'ws') common.mockWebsocketTracker(client2)

      client2.start()

      client2.once('update', function (data) {
        var client3 = new Client({
          infoHash: infoHash,
          announce: [ announceUrl ],
          peerId: peerId3,
          port: 6880,
          wrtc: wrtc
        })
        if (serverType === 'ws') common.mockWebsocketTracker(client3)

        client3.start()

        client3.on('peer', function () {
          t.pass('got one peer (this should only fire once)')

          var num = 3
          function tryCloseServer () {
            num -= 1
            if (num === 0) server.close()
          }

          client1.stop()
          client1.once('update', function () {
            t.pass('got response to stop (client1)')
            client1.destroy()
            tryCloseServer()
          })
          client2.stop()
          client2.once('update', function () {
            t.pass('got response to stop (client2)')
            client2.destroy()
            tryCloseServer()
          })
          client3.stop()
          client3.once('update', function () {
            t.pass('got response to stop (client3)')
            client3.destroy()
            tryCloseServer()
          })
        })
      })
    })
  })
}

test('max announce peers: ipv4 server', function (t) {
  serverTest(t, 'http', 'inet')
})

test('max announce peers: http ipv6 server', function (t) {
  serverTest(t, 'http', 'inet6')
})

test('max announce peers: udp server', function (t) {
  serverTest(t, 'udp', 'inet')
})

// FIXME: Cannot get peer events with websocket tracker
// test('max announce peers: ws server', function (t) {
//   wrtc = electronWebrtc()
//   wrtc.electronDaemon.once('ready', function () {
//     serverTest(t, 'ws', 'inet')
//   })
//   t.once('end', function () {
//     wrtc.close()
//   })
// })
