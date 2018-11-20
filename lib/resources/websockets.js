"use strict"
Object.defineProperty(exports, "__esModule", { value: true })
const events = require("events")
const WebSocket = require("ws")
const polygon = require('./polygonNats')

// Listeners
// A client can listen on any of the following events, states, or errors
// Connection states. Each of these will also emit EVENT.STATE_CHANGE
var STATE
(function (STATE) {
  STATE["AUTHENTICATING"] = "authenticating"
  STATE["CONNECTED"] = "connected"
  STATE["CONNECTING"] = "connecting"
  STATE["DISCONNECTED"] = "disconnected"
  STATE["WAITING_TO_CONNECT"] = "waiting to connect"
  STATE["WAITING_TO_RECONNECT"] = "waiting to reconnect"
})(STATE = exports.STATE || (exports.STATE = {}))
// Client events
var EVENT
(function (EVENT) {
  EVENT["CLIENT_ERROR"] = "client error"
  EVENT["STATE_CHANGE"] = "state change"

  EVENT["AUTHORIZED"] = "authorized"
  EVENT["UNAUTHORIZED"] = "unauthorized"
  EVENT["ORDER_UPDATE"] = "trade_updates"
  EVENT["ACCOUNT_UPDATE"] = "account_updates"
  EVENT["STOCK_TRADES"] = "stock_trades"
  EVENT["STOCK_QUOTES"] = "stock_quotes"
  EVENT["STOCK_AGG_SEC"] = "stock_agg_sec"
  EVENT["STOCK_AGG_MIN"] = "stock_agg_min"
})(EVENT = exports.EVENT || (exports.EVENT = {}))
// Connection errors Each of these will also emit EVENT.ERROR
var ERROR
(function (ERROR) {
  ERROR["BAD_KEY_OR_SECRET"] = "bad key id or secret"
  ERROR["CONNECTION_REFUSED"] = "connection refused"
  ERROR["MISSING_API_KEY"] = "missing api key"
  ERROR["MISSING_SECRET_KEY"] = "missing secret key"
  ERROR["UNKNOWN"] = "unknown error"
})(ERROR = exports.ERROR || (exports.ERROR = {}))
const backoffIncrement = 0.5

/**
 * StreamClient manages a connection to Cryptowatch websocket api
 */
class AlpacaStreamClient extends events.EventEmitter {
  // Default to defaultOptions
  // These will be overwritten by the opts object passed to the constructor
  static setConfiguration(baseUrl, keyId, secretKey) {
    AlpacaStreamClient.defaultOptions = {
      url: baseUrl,
      apiKey: keyId,
      secretKey: secretKey
    }
  }
  constructor(opts = {}) {
    super()
    this.defaultOptions = {
      // The stream url to connect to
      url: "",
      apiKey: "",
      secretKey: "",
      // A list of subscriptions to subscribe to on connection
      subscriptions: [],
      // Whether the library should reconnect automatically
      reconnect: true,
      // Reconnection backoff: if true, then the reconnection time will be initially
      // reconnectTimeout, then will double with each unsuccessful connection attempt.
      // It will not exceed maxReconnectTimeout
      backoff: true,
      // Initial reconnect timeout (seconds) a minimum of 1 will be used if backoff=false
      reconnectTimeout: 0,
      // The maximum amount of time between reconnect tries (applies to backoff)
      maxReconnectTimeout: 30,
      // If true, client outputs detailed log messages
      verbose: false
    }
    // Set minimum reconnectTimeout of 1s if backoff=false
    if (!opts.backoff && opts.reconnectTimeout < 1) {
      opts.reconnectTimeout = 1
    }
    // Merge supplied options with defaults
    this.session = Object.assign(this.defaultOptions, opts)
    if (this.session.url.length === 0) {
      this.session.url = AlpacaStreamClient.defaultOptions.url
    }
    if (this.session.apiKey.length === 0) {
      this.session.apiKey = AlpacaStreamClient.defaultOptions.apiKey
    }
    if (this.session.secretKey.length === 0) {
      this.session.secretKey = AlpacaStreamClient.defaultOptions.secretKey
    }

    this.session.url = this.session.url.replace("http", "ws") + "/stream"
    if (this.session.apiKey.length === 0) {
      throw new Error(ERROR.MISSING_API_KEY)
    }
    if (this.session.secretKey.length === 0) {
      throw new Error(ERROR.MISSING_SECRET_KEY)
    }
    // Keep track of subscriptions in case we need to reconnect after the client
    // has called subscribe()
    this.subscriptionState = {}
    this.session.subscriptions.forEach(x => {
      this.subscriptionState[x] = true
    })
    this.currentState = STATE.WAITING_TO_CONNECT
    // Register internal event handlers
    // Log and emit every state change
    Object.keys(STATE).forEach(s => {
      this.on(STATE[s], () => {
        this.currentState = STATE[s]
        this.log("info", `state change: ${STATE[s]}`)
        this.emit(EVENT.STATE_CHANGE, STATE[s])
      })
    })
    // Log and emit every error
    Object.keys(ERROR).forEach(e => {
      this.on(ERROR[e], () => {
        this.log("error", ERROR[e])
        this.emit(EVENT.CLIENT_ERROR, ERROR[e])
      })
    })
  }
  connect() {
    // Reset reconnectDisabled since the user called connect() again
    this.reconnectDisabled = false
    this.emit(STATE.CONNECTING)
    this.conn = new WebSocket(this.session.url)
    this.conn.once("open", () => {
      this.authenticate()
    })
    this.conn.on("message", (data) => this.handleMessage(data))
    this.conn.once("error", err => {
      this.emit(ERROR.CONNECTION_REFUSED)
    })
    this.conn.once("close", () => {
      this.emit(STATE.DISCONNECTED)
      if (this.session.reconnect && !this.reconnectDisabled) {
        this.reconnect()
      }
    })
  }
  _ensure_nats() {
    if (this.polygon) {
      return
    }
    let keyId = this.session.apiKey
    if (this.session.url.indexOf('staging') > 0) {
      keyId = `${keyId}-staging`
    }
    this.polygon = new polygon.PolygonNats(keyId)
    this.polygon.on('*', function (subject, data) {
      this.handlePolygonMessage(subject, data)
    })
    this.polygon.connect()
  }
  subscribe(keys) {
    let wsChannels = []
    let natsChannels = []
    keys.forEach(key => {
      const nats = ['Q.', 'T.', 'A.', 'AM.']
      let found = nats.filter((channel) => key.startsWith(channel))
      if (found.length > 0) {
        natsChannels.push(key)
      } else {
        wsChannels.push(key)
      }
    })
    if (wsChannels.length > 0) {
      const subMsg = {
        action: 'listen',
        data: {
          streams: wsChannels
        }
      }
      this.send(JSON.stringify(subMsg))
    }
    if (natsChannels.length > 0) {
      this._ensure_nats()
      this.polygon.subscribe(natsChannels)
    }
    keys.forEach(x => {
      this.subscriptionState[x] = true
    })
  }
  unsubscribe(keys) {
    keys.forEach(x => {
      delete this.subscriptionState[x]
    })
    remains = Object.keys(this.subscriptionState)
    const subMsg = {
      action: 'listen',
      data: {
        streams: remains
      }
    }
    if (remains.length > 0) {
      this.send(JSON.stringify(subMsg))
    }
  }
  subscriptions() {
    return Object.keys(this.subscriptionState)
  }
  onConnect(fn) {
    this.on(STATE.CONNECTED, () => fn())
  }
  onDisconnect(fn) {
    this.on(STATE.DISCONNECTED, () => fn())
  }
  onStateChange(fn) {
    this.on(EVENT.STATE_CHANGE, newState => fn(newState))
  }
  onError(fn) {
    this.on(EVENT.CLIENT_ERROR, err => fn(err))
  }
  onOrderUpdate(fn) {
    this.on(EVENT.ORDER_UPDATE, orderUpdate => fn(orderUpdate))
  }
  onAccountUpdate(fn) {
    this.on(EVENT.ACCOUNT_UPDATE, accountUpdate => fn(accountUpdate))
  }
  onStockTrades(fn) {
    this.on(EVENT.STOCK_TRADES, function(subject, data) {fn(subject, data)})
  }
  onStockQuotes(fn) {
    this.on(EVENT.STOCK_QUOTES, function(subject, data) {fn(subject, data)})
  }
  onStockAggSec(fn) {
    this.on(EVENT.STOCK_AGG_SEC, function(subject, data) {fn(subject, data)})
  }
  onStockAggMin(fn) {
    this.on(EVENT.STOCK_AGG_MIN, function(subject, data) {fn(subject, data)})
  }
  send(data) {
    this.conn.send(data)
  }
  disconnect() {
    this.reconnectDisabled = true
    this.conn.close()
    if (this.polygon) {
      this.polygon.close()
    }
  }
  state() {
    return this.currentState
  }
  get(key) {
    return this.session[key]
  }
  reconnect() {
    setTimeout(() => {
      if (this.session.backoff) {
        this.session.reconnectTimeout += backoffIncrement
        if (this.session.reconnectTimeout > this.session.maxReconnectTimeout) {
          this.session.reconnectTimeout = this.session.maxReconnectTimeout
        }
      }
      this.connect()
    }, this.session.reconnectTimeout * 1000)
    this.emit(STATE.WAITING_TO_RECONNECT, this.session.reconnectTimeout)
  }
  authenticate() {
    this.emit(STATE.AUTHENTICATING)

    const authMsg = {
      action: 'authenticate',
      data: {
        key_id: this.session.apiKey,
        secret_key: this.session.secretKey
      }
    }
    this.send(JSON.stringify(authMsg))
  }

  handleMessage(data) {
    // Heartbeat
    const bytes = new Uint8Array(data)
    if (bytes.length === 1 && bytes[0] === 1) {
      return
    }
    let message = JSON.parse(data)
    switch (message.stream) {
      case "authorization":
        this.authResultHandler(message.data.status)
        break
      case "listening":
        this.log(`listening to the streams: ${message.data.streams}`)
        break
      case "trade_updates":
        this.emit(EVENT.ORDER_UPDATE, message.data)
        break
      case "account_updates":
        this.emit(EVENT.ACCOUNT_UPDATE, message.data)
        break
      default:
        this.emit(ERROR.PROTOBUF)
    }
  }
  handlePolygonMessage(subject, data) {
    const channelName = subject.split('.')[0]
    switch (channelName) {
      case "Q":
        this.emit(EVENT.STOCK_QUOTES, subject, data)
        break
      case "T":
        this.emit(EVENT.STOCK_TRADES, subject, data)
        break
      case "A":
        this.emit(EVENT.STOCK_AGG_SEC, subject, data)
        break
      case "AM":
        this.emit(EVENT.STOCK_AGG_MIN, subject, data)
        break
    }
  }
  authResultHandler(authResult) {
    switch (authResult) {
      case 'authorized':
        this.emit(STATE.CONNECTED)
        break
      case 'unauthorized':
        this.emit(ERROR.BAD_KEY_OR_SECRET)
        this.disconnect()
        break
      default:
        break
    }
  }
  log(level, ...msg) {
    if (this.session.verbose) {
      console[level](...msg)
    }
  }
}
exports.AlpacaStreamClient = AlpacaStreamClient
