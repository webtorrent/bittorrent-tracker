var bencode = require('bencode')
var Client = require('../')
var common = require('../lib/common')
var concat = require('concat-stream')
var fs = require('fs')
var http = require('http')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var querystring = require('querystring')
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

test('server: single info_hash scrape', function (t) {
  var server = new Server({ udp: false })
  server.on('error', function (err) {
    t.error(err)
  })
  server.on('warning', function (err) {
    t.error(err)
  })

  portfinder.getPort(function (err, port) {
    t.error(err)
    server.listen(port)
    var scrapeUrl = 'http://127.0.0.1:' + port + '/scrape'

    server.once('listening', function () {
      var url = scrapeUrl + '?' + common.querystringStringify({
        info_hash: binaryInfoHash1
      })
      http.get(url, function (res) {
        t.equal(res.statusCode, 200)
        res.pipe(concat(function (data) {
          data = bencode.decode(data)
          t.ok(data.files)
          t.equal(Object.keys(data.files).length, 1)
          t.ok(data.files[binaryInfoHash1])
          t.equal(typeof data.files[binaryInfoHash1].complete, 'number')
          t.equal(typeof data.files[binaryInfoHash1].incomplete, 'number')
          t.equal(typeof data.files[binaryInfoHash1].downloaded, 'number')

          server.close(function () {
            t.end()
          })
        }))
      }).on('error', function (e) {
        t.error(err)
      })
    })
  })
})

test('server: multiple info_hash scrape', function (t) {
  var server = new Server({ udp: false })
  server.on('error', function (err) {
    t.error(err)
  })
  server.on('warning', function (err) {
    t.error(err)
  })

  portfinder.getPort(function (err, port) {
    t.error(err)
    server.listen(port)
    var scrapeUrl = 'http://127.0.0.1:' + port + '/scrape'

    server.once('listening', function () {
      var url = scrapeUrl + '?' + common.querystringStringify({
        info_hash: [ binaryInfoHash1, binaryInfoHash2 ]
      })
      http.get(url, function (res) {
        t.equal(res.statusCode, 200)
        res.pipe(concat(function (data) {
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
        }))
      }).on('error', function (e) {
        t.error(err)
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

  portfinder.getPort(function (err, port) {
    t.error(err)
    server.listen(port)
    var announceUrl = 'http://127.0.0.1:' + port + '/announce'
    var scrapeUrl = 'http://127.0.0.1:' + port + '/scrape'

    parsedBitlove.announce = [ announceUrl ]

    server.once('listening', function () {

      // announce a torrent to the tracker
      var client = new Client(peerId, port, parsedBitlove)
      client.on('error', function (err) {
        t.error(err)
      })
      client.start()

      server.once('start', function (data) {

        // now do a scrape of everything by omitting the info_hash param
        http.get(scrapeUrl, function (res) {

          t.equal(res.statusCode, 200)
          res.pipe(concat(function (data) {
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
          }))
        }).on('error', function (e) {
          t.error(err)
        })
      })
    })
  })
})
