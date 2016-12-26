#!/usr/bin/env node

var minimist = require('minimist')
var Server = require('../')

var argv = minimist(process.argv.slice(2), {
  alias: {
    h: 'help',
    p: 'port',
    q: 'quiet',
    s: 'silent',
    v: 'version'
  },
  boolean: [
    'help',
    'http',
    'quiet',
    'silent',
    'trust-proxy',
    'udp',
    'version',
    'ws',
    'stats'
  ],
  string: [
    'http-hostname',
    'udp-hostname',
    'udp6-hostname'
  ],
  default: {
    port: 8000,
    stats: true
  }
})

if (argv.version) {
  console.log(require('../package.json').version)
  process.exit(0)
}

if (argv.help) {
  console.log(function () {
  /*
  webtorrent-tracker - Start a webtorrent tracker server

  Usage:
    webtorrent-tracker [OPTIONS]

  If no --http, --udp, or --ws option is supplied, all tracker types will be started.

  Options:
    -p, --port [number]           change the port [default: 8000]
        --trust-proxy             trust 'x-forwarded-for' header from reverse proxy
        --interval                client announce interval (ms) [default: 600000]
        --stats                   enable web-based statistics (default: true)
    -q, --quiet                   only show error output
    -s, --silent                  show no output
    -v, --version                 print the current version

  Please report bugs!  https://github.com/feross/bittorrent-tracker/issues

  */
  }.toString().split(/\n/).slice(2, -2).join('\n'))
  process.exit(0)
}

if (argv.silent) argv.quiet = true

var allFalsy = !argv.http && !argv.udp && !argv.ws

argv.http = allFalsy || argv.http
argv.udp = allFalsy || argv.udp
argv.ws = allFalsy || argv.ws

var server = new Server({
  http: argv.http,
  interval: argv.interval,
  stats: argv.stats,
  trustProxy: argv['trust-proxy'],
  udp: argv.udp,
  ws: argv.ws
})

server.on('error', function (err) {
  if (!argv.silent) console.error('ERROR: ' + err.message)
})
server.on('warning', function (err) {
  if (!argv.quiet) console.log('WARNING: ' + err.message)
})
server.on('update', function (addr) {
  if (!argv.quiet) console.log('update: ' + addr)
})
server.on('complete', function (addr) {
  if (!argv.quiet) console.log('complete: ' + addr)
})
server.on('start', function (addr) {
  if (!argv.quiet) console.log('start: ' + addr)
})
server.on('stop', function (addr) {
  if (!argv.quiet) console.log('stop: ' + addr)
})

var hostname = {
  http: argv['http-hostname'],
  udp4: argv['udp-hostname'],
  udp6: argv['upd6-hostname']
}

server.listen(argv.port, hostname, function () {
  if (server.ws && !argv.quiet) {
    var wsAddr = server.http.address()
    var wsHost = wsAddr.address !== '::' ? wsAddr.address : 'localhost'
    var wsPort = wsAddr.port
    console.log('WebSocket tracker: ws://' + wsHost + ':' + wsPort)
  }
  if (server.http && argv.stats && !argv.quiet) {
    var statsAddr = server.http.address()
    var statsHost = statsAddr.address !== '::' ? statsAddr.address : 'localhost'
    var statsPort = statsAddr.port
    console.log('Tracker stats: http://' + statsHost + ':' + statsPort + '/stats')
  }
})
