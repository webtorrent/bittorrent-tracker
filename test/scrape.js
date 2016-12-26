var Buffer = require('safe-buffer').Buffer
var Client = require('bittorrent-tracker')
var common = require('./common')
var commonTest = require('./common')
var fixtures = require('webtorrent-fixtures')
var test = require('tape')

var peerId = Buffer.from('01234567890123456789')

function testSingle (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    var client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId: peerId,
      port: 6881,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.scrape()

    client.on('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      client.destroy()
      server.close(function () {
        t.end()
      })
    })
  })
}

test('ws: single info_hash scrape', function (t) {
  testSingle(t, 'ws')
})

function clientScrapeStatic (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    var client = Client.scrape({
      announce: announceUrl,
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      wrtc: {}
    }, function (err, data) {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(function () {
        t.end()
      })
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client)
  })
}

test('ws: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'ws')
})

// Ensure the callback function gets called when an invalid url is passed
function clientScrapeStaticInvalid (t, serverType) {
  var announceUrl = serverType + '://invalid.lol'
  if (serverType === 'http') announceUrl += '/announce'

  var client = Client.scrape({
    announce: announceUrl,
    infoHash: fixtures.leaves.parsedTorrent.infoHash,
    wrtc: {}
  }, function (err, data) {
    t.ok(err instanceof Error)
    t.end()
  })
  if (serverType === 'ws') common.mockWebsocketTracker(client)
}

test('ws: scrape using Client.scrape static method (invalid url)', function (t) {
  clientScrapeStaticInvalid(t, 'ws')
})
