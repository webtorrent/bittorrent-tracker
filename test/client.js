var Client = require('../')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId1 = Buffer.from('01234567890123456789')
var peerId2 = Buffer.from('12345678901234567890')
var peerId3 = Buffer.from('23456789012345678901')
var port = 6881

function testClientStart (t, serverType) {
  t.plan(4)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.stop()

      client.once('update', function () {
        t.pass('got response to stop')
        server.close()
        client.destroy()
      })
    })

    client.start()
  })
}

test('http: client.start()', function (t) {
  testClientStart(t, 'http')
})

test('udp: client.start()', function (t) {
  testClientStart(t, 'udp')
})

test('ws: client.start()', function (t) {
  testClientStart(t, 'ws')
})

function testClientStop (t, serverType) {
  t.plan(4)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    client.once('update', function () {
      t.pass('client received response to "start" message')

      client.stop()

      client.once('update', function (data) {
        // receive one final update after calling stop
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        server.close()
        client.destroy()
      })
    })
  })
}

test('http: client.stop()', function (t) {
  testClientStop(t, 'http')
})

test('udp: client.stop()', function (t) {
  testClientStop(t, 'udp')
})

test('ws: client.stop()', function (t) {
  testClientStop(t, 'ws')
})

function testClientStopDestroy (t, serverType) {
  t.plan(2)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    client.once('update', function () {
      t.pass('client received response to "start" message')

      client.stop()

      client.on('update', function () { t.fail('client should not receive update after destroy is called') })

      // Call destroy() in the same tick as stop(), but the message should still
      // be received by the server, though obviously the client won't receive the
      // response.
      client.destroy()

      server.once('stop', function (peer, params) {
        t.pass('server received "stop" message')
        setTimeout(function () {
          // give the websocket server time to finish in progress (stream) messages
          // to peers
          server.close()
        }, 100)
      })
    })
  })
}

test('http: client.stop(); client.destroy()', function (t) {
  testClientStopDestroy(t, 'http')
})

test('udp: client.stop(); client.destroy()', function (t) {
  testClientStopDestroy(t, 'udp')
})

test('ws: client.stop(); client.destroy()', function (t) {
  testClientStopDestroy(t, 'ws')
})

function testClientUpdate (t, serverType) {
  t.plan(4)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.setInterval(500)

    client.start()

    client.once('update', function () {
      client.setInterval(500)

      // after interval, we should get another update
      client.once('update', function (data) {
        // received an update!
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')
        client.stop()

        client.once('update', function () {
          t.pass('got response to stop')
          server.close()
          client.destroy()
        })
      })
    })
  })
}

test('http: client.update()', function (t) {
  testClientUpdate(t, 'http')
})

test('udp: client.update()', function (t) {
  testClientUpdate(t, 'udp')
})

test('ws: client.update()', function (t) {
  testClientUpdate(t, 'ws')
})

function testClientScrape (t, serverType) {
  t.plan(4)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')

      server.close()
      client.destroy()
    })

    client.scrape()
  })
}

test('http: client.scrape()', function (t) {
  testClientScrape(t, 'http')
})

test('udp: client.scrape()', function (t) {
  testClientScrape(t, 'udp')
})

test('ws: client.scrape()', function (t) {
  testClientScrape(t, 'ws')
})

function testClientAnnounceWithParams (t, serverType) {
  t.plan(5)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    server.on('start', function (peer, params) {
      t.equal(params.testParam, 'this is a test')
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.stop()

      client.once('update', function () {
        t.pass('got response to stop')
        server.close()
        client.destroy()
      })
    })

    client.start({
      testParam: 'this is a test'
    })
  })
}

test('http: client.announce() with params', function (t) {
  testClientAnnounceWithParams(t, 'http')
})

test('ws: client.announce() with params', function (t) {
  testClientAnnounceWithParams(t, 'ws')
})

function testClientGetAnnounceOpts (t, serverType) {
  t.plan(5)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      getAnnounceOpts: function () {
        return {
          testParam: 'this is a test'
        }
      },
      wrtc: {}
    })

    server.on('start', function (peer, params) {
      t.equal(params.testParam, 'this is a test')
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')

      client.stop()

      client.once('update', function () {
        t.pass('got response to stop')
        server.close()
        client.destroy()
      })
    })

    client.start()
  })
}

test('http: client `opts.getAnnounceOpts`', function (t) {
  testClientGetAnnounceOpts(t, 'http')
})

test('ws: client `opts.getAnnounceOpts`', function (t) {
  testClientGetAnnounceOpts(t, 'ws')
})

function testClientAnnounceWithNumWant (t, serverType) {
  t.plan(4)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client1 = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: [announceUrl],
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client1)
    client1.on('error', function (err) { t.error(err) })
    client1.on('warning', function (err) { t.error(err) })

    client1.start()
    client1.once('update', function () {
      var client2 = new Client({
        infoHash: fixtures.leaves.parsedTorrent.infoHash,
        announce: announceUrl,
        peerId: peerId2,
        port: port + 1,
        wrtc: {}
      })

      if (serverType === 'ws') common.mockWebsocketTracker(client2)
      client2.on('error', function (err) { t.error(err) })
      client2.on('warning', function (err) { t.error(err) })

      client2.start()
      client2.once('update', function () {
        var client3 = new Client({
          infoHash: fixtures.leaves.parsedTorrent.infoHash,
          announce: announceUrl,
          peerId: peerId3,
          port: port + 2,
          wrtc: {}
        })

        if (serverType === 'ws') common.mockWebsocketTracker(client3)
        client3.on('error', function (err) { t.error(err) })
        client3.on('warning', function (err) { t.error(err) })

        client3.start({ numwant: 1 })
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

test('http: client announce with numwant', function (t) {
  testClientAnnounceWithNumWant(t, 'http')
})

test('udp: client announce with numwant', function (t) {
  testClientAnnounceWithNumWant(t, 'udp')
})

test('http: userAgent', function (t) {
  t.plan(2)

  common.createServer(t, 'http', function (server, announceUrl) {
    // Confirm that user-agent header is set
    server.http.on('request', function (req, res) {
      t.ok(req.headers['user-agent'].indexOf('WebTorrent') !== -1)
    })

    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      userAgent: 'WebTorrent/0.98.0 (https://webtorrent.io)',
      wrtc: {}
    })

    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function (data) {
      t.equal(data.announce, announceUrl)

      server.close()
      client.destroy()
    })

    client.start()
  })
})

function testSupportedTracker (t, serverType) {
  t.plan(1)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    client.once('update', function (data) {
      t.pass('tracker is valid')

      server.close()
      client.destroy()
    })
  })
}

test('http: valid tracker port', function (t) {
  testSupportedTracker(t, 'http')
})

test('udp: valid tracker port', function (t) {
  testSupportedTracker(t, 'udp')
})

test('ws: valid tracker port', function (t) {
  testSupportedTracker(t, 'ws')
})

function testUnsupportedTracker (t, announceUrl) {
  t.plan(1)

  var client = new Client({
    infoHash: fixtures.leaves.parsedTorrent.infoHash,
    announce: announceUrl,
    peerId: peerId1,
    port: port,
    wrtc: {}
  })

  client.on('error', function (err) { t.error(err) })
  client.on('warning', function (err) {
    t.ok(err.message.includes('tracker'), 'got warning')

    client.destroy()
  })
}

test('unsupported tracker protocol', function (t) {
  testUnsupportedTracker(t, 'badprotocol://127.0.0.1:8080/announce')
})

test('http: invalid tracker port', function (t) {
  testUnsupportedTracker(t, 'http://127.0.0.1:69691337/announce')
})

test('udp: invalid tracker port', function (t) {
  testUnsupportedTracker(t, 'udp://127.0.0.1:69691337')
})

test('ws: invalid tracker port', function (t) {
  testUnsupportedTracker(t, 'ws://127.0.0.1:69691337')
})
