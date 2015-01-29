var Server = require('../').Server

exports.createServer = function (t, serverType, cb) {
  var opts = serverType === 'http' ? { udp: false } : { http: false }
  var server = new Server(opts)

  server.on('error', function (err) {
    t.error(err)
  })

  server.on('warning', function (err) {
    t.error(err)
  })

  server.listen(0, function () {
    var port = server[serverType].address().port
    var announceUrl = serverType === 'http'
      ? 'http://127.0.0.1:' + port + '/announce'
      : 'udp://127.0.0.1:' + port

    cb(server, announceUrl)
  })
}
