const EventEmitter = require('events')

class Tracker extends EventEmitter {
  constructor (client, announceUrl) {
    super()

    const self = this
    self.client = client
    self.announceUrl = announceUrl

    self.interval = null
    self.destroyed = false
  }

  setInterval (intervalMs) {
    const self = this
    if (intervalMs == null) intervalMs = self.DEFAULT_ANNOUNCE_INTERVAL

    clearInterval(self.interval)

    if (intervalMs) {
      self.interval = setInterval(() => {
        self.announce(self.client._defaultAnnounceOpts())
      }, intervalMs)
      if (self.interval.unref) self.interval.unref()
    }
  }
}

module.exports = Tracker
