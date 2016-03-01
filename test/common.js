var Server = require('../').Server

exports.createServer = function (t, opts, cb) {
  if (typeof opts === 'string') opts = { serverType: opts }

  opts.http = (opts.serverType === 'http')
  opts.udp = (opts.serverType === 'udp')
  opts.ws = (opts.serverType === 'ws')

  var server = new Server(opts)

  server.on('error', function (err) { t.error(err) })
  server.on('warning', function (err) { t.error(err) })

  server.listen(0, function () {
    var port = server[opts.serverType].address().port
    var announceUrl
    if (opts.serverType === 'http') {
      announceUrl = 'http://127.0.0.1:' + port + '/announce'
    } else if (opts.serverType === 'udp') {
      announceUrl = 'udp://127.0.0.1:' + port
    } else if (opts.serverType === 'ws') {
      announceUrl = 'ws://127.0.0.1:' + port
    }

    cb(server, announceUrl)
  })
}

exports.mockWebsocketTracker = function (client) {
  client._trackers[0]._generateOffers = function (numwant, cb) {
    var offers = []
    for (var i = 0; i < numwant; i++) {
      offers.push({ fake_offer: 'fake_offer_' + i })
    }
    process.nextTick(function () {
      cb(offers)
    })
  }
}
