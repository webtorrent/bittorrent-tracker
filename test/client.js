var Buffer = require('safe-buffer').Buffer
var Client = require('bittorrent-tracker')
var common = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId1 = Buffer.from('01234567890123456789')
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

    common.mockWebsocketTracker(client)
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

test('ws: client.start()', function (t) {
  testClientStart(t, 'ws')
})

function testClientStop (t, serverType) {
  t.plan(3)

  common.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId1,
      port: port,
      wrtc: {}
    })

    common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    setTimeout(function () {
      client.stop()

      client.once('update', function (data) {
        // receive one final update after calling stop
        t.equal(data.announce, announceUrl)
        t.equal(typeof data.complete, 'number')
        t.equal(typeof data.incomplete, 'number')

        server.close()
        client.destroy()
      })
    }, 1000)
  })
}

test('ws: client.stop()', function (t) {
  testClientStop(t, 'ws')
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

    client.setInterval(2000)

    client.start()

    client.once('update', function () {
      client.setInterval(2000)

      // after interval (2s), we should get another update
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

test('ws: client `opts.getAnnounceOpts`', function (t) {
  testClientGetAnnounceOpts(t, 'ws')
})
