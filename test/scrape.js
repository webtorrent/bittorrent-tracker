var bencode = require('bencode')
var Client = require('../')
var commonLib = require('../lib/common')
var commonTest = require('./common')
var fs = require('fs')
var get = require('simple-get')
var parseTorrent = require('parse-torrent')
var Server = require('../').Server
var test = require('tape')

function hexToBinary (str) {
  return new Buffer(str, 'hex').toString('binary')
}

var infoHash1 = 'aaa67059ed6bd08362da625b3ae77f6f4a075aaa'
var binaryInfoHash1 = hexToBinary(infoHash1)
var infoHash2 = 'bbb67059ed6bd08362da625b3ae77f6f4a075bbb'
var binaryInfoHash2 = hexToBinary(infoHash2)

var bitlove = fs.readFileSync(__dirname + '/torrents/bitlove-intro.torrent')
var parsedBitlove = parseTorrent(bitlove)
var binaryBitlove = hexToBinary(parsedBitlove.infoHash)

var peerId = new Buffer('01234567890123456789')

function testSingle (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    Client.scrape(announceUrl, infoHash1, function (err, data) {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: single info_hash scrape', function (t) {
  testSingle(t, 'http')
})

test('udp: single info_hash scrape', function (t) {
  testSingle(t, 'udp')
})

function clientScrapeStatic (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    Client.scrape(announceUrl, infoHash1, function (err, data) {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'http')
})

test('udp: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'udp')
})

// TODO: test client for multiple scrape for UDP trackers

test('server: multiple info_hash scrape', function (t) {
  var server = new Server({ udp: false })
  server.on('error', function (err) {
    t.error(err)
  })
  server.on('warning', function (err) {
    t.error(err)
  })

  server.listen(0, function () {
    var port = server.http.address().port
    var scrapeUrl = 'http://127.0.0.1:' + port + '/scrape'
    var url = scrapeUrl + '?' + commonLib.querystringStringify({
      info_hash: [ binaryInfoHash1, binaryInfoHash2 ]
    })
    get.concat(url, function (err, data, res) {
      if (err) throw err
      t.equal(res.statusCode, 200)

      data = bencode.decode(data)
      t.ok(data.files)
      t.equal(Object.keys(data.files).length, 2)

      t.ok(data.files[binaryInfoHash1])
      t.equal(typeof data.files[binaryInfoHash1].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].downloaded, 'number')

      t.ok(data.files[binaryInfoHash2])
      t.equal(typeof data.files[binaryInfoHash2].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].downloaded, 'number')

      server.close(function () {
        t.end()
      })
    })
  })
})

test('server: all info_hash scrape', function (t) {
  var server = new Server({ udp: false })
  server.on('error', function (err) {
    t.error(err)
  })
  server.on('warning', function (err) {
    t.error(err)
  })

  server.listen(0, function () {
    var port = server.http.address().port
    var announceUrl = 'http://127.0.0.1:' + port + '/announce'
    var scrapeUrl = 'http://127.0.0.1:' + port + '/scrape'

    parsedBitlove.announce = [ announceUrl ]

    // announce a torrent to the tracker
    var client = new Client(peerId, port, parsedBitlove)
    client.on('error', function (err) {
      t.error(err)
    })
    client.start()

    server.once('start', function () {
      // now do a scrape of everything by omitting the info_hash param
      get.concat(scrapeUrl, function (err, data, res) {
        if (err) throw err

        t.equal(res.statusCode, 200)
        data = bencode.decode(data)
        t.ok(data.files)
        t.equal(Object.keys(data.files).length, 1)

        t.ok(data.files[binaryBitlove])
        t.equal(typeof data.files[binaryBitlove].complete, 'number')
        t.equal(typeof data.files[binaryBitlove].incomplete, 'number')
        t.equal(typeof data.files[binaryBitlove].downloaded, 'number')

        client.stop()
        server.close(function () {
          t.end()
        })
      })
    })
  })
})
