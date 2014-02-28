// Copyright 2013 Voxer IP LLC. All rights reserved.

var GO, // Global Object
    http = require("http"),
    inherits = require("util").inherits,
    EventEmitter = require("events").EventEmitter;

var MAX_COUNT = Math.pow(2, 52); // if we need more than 51 bits, wrap around at 4,503,599,627,370,495.

// PoolEndpoint - a backend that requests can be sent to
// http: either require("http") or require("https")
// ip: host ip
// port: host port
// options: {
//   ping: ping path (no ping checks)
//   ping_timeout: in ms (5000)
//   max_sockets: max concurrent open sockets (5)
//   timeout: default request timeout in ms (60000)
//   resolution: how often timeouts are checked in ms (1000)
//   keep_alive: use an alternate Agent that does keep-alive properly (boolean) default false
//   agent_ptions: {} an object for passing options directly to the Http Agent
// }
function PoolEndpoint(protocol, ip, port, options) {
    options = options || {};

    this.http = protocol;
    this.healthy = true;

    this.ip = ip;
    this.address = ip;
    this.port = port;
    this.name = this.ip + ":" + this.port;

    this.keep_alive = options.keep_alive || options.keepAlive;
    this.agent_options = options.agent_options || options.agentOptions;

    if (this.keep_alive) {
        if (protocol === http) {
            this.agent = new GO.KeepAliveAgent.HTTP(this.agent_options);
        } else {
            this.agent = new GO.KeepAliveAgent.HTTPS(this.agent_options);
        }
    } else {
        this.agent = new protocol.Agent(this.agent_options);
    }

    this.agent.maxSockets = options.max_sockets || options.maxSockets || 5;

    this.requests = {};
    this.request_count = 0;
    this.requests_last_check = 0;
    this.request_rate = 0;
    this.pending = 0;
    this.successes = 0;
    this.failures = 0;
    this.filtered = 0;

    this.timeout = (options.timeout === 0) ? 0 : options.timeout || (60 * 1000);
    this.resolution = (options.resolution === 0) ? 0 : options.resolution || 1000;
    if (this.resolution > 0 && this.timeout > 0) {
        var self = this;
        this.timeout_interval = setInterval(function () {
            self.check_timeouts();
        }, this.resolution);
    }

    // note that the pinger doesn't start by default, but in the future we might want to add an option for checking an endpoint before ever using it
    this.ping_path = options.ping;
    this.ping_timeout = options.ping_timeout || 5000;
    this.pinger = new GO.PoolPinger(this);
}
inherits(PoolEndpoint, EventEmitter);

PoolEndpoint.prototype.close = function () {
    clearInterval(this.timeout_interval);
};

// options: {
//   timeout: request timeout in ms (this.timeout)
//   encoding: response body encoding (utf8)
//   data: string or buffer
// }
PoolEndpoint.prototype.request = function (options, callback) {
    var has_retry = !!options.retry_filter,
        req = new GO.PoolEndpointRequest(this, options, callback);

    this.update_pending();
    this.requests[req.id] = req;
    req.start();

    // If you want to retry, you can't stream.
    if (has_retry) {
        return;
    }
    return req;
};

PoolEndpoint.prototype.ready = function () {
    if (! this.healthy) {
        return false; // unhealthy endpoints are never ready
    }
    if (this.keep_alive) {
        // if we are doing keep_alive and we have more sockets than active requests, we are ready
        if (this.agent.sockets[this.name] && this.agent.sockets[this.name].length > this.pending) {
            return true;
        } else {
            return false;
        }
    }
    // we are ready if we currently have nothing to do
    return this.pending === 0;
};

PoolEndpoint.prototype.stats = function () {
    var socket_keys = Object.keys(this.agent.sockets);
    var request_counts = [];
    for (var i = 0; i < socket_keys.length; i++) {
        var name = socket_keys[i];
        var s = this.agent.sockets[name] || [];
        for (var j = 0; j < s.length; j++) {
            request_counts.push(s[j]._request_count || 1);
        }
    }
    return {
        name: this.name,
        request_count: this.request_count,
        request_rate: this.request_rate,
        pending: this.pending,
        successes: this.successes,
        failures: this.failures,
        filtered: this.filtered,
        healthy: this.healthy,
        socket_request_counts: request_counts
    };
};

PoolEndpoint.prototype.check_timeouts = function () {
    var now = Date.now(); // only run Date.now() once per check interval
    var request_keys = Object.keys(this.requests);
    for (var i = 0; i < request_keys.length; i++) {
        var request = this.requests[request_keys[i]];
        var expire_time = now - request.options.timeout;
        if (request.last_touched <= expire_time) {
            if (request.options.path !== this.ping_path) {
                this.emit("timeout", request);
            }
            request.timed_out = true;
            request.out_request.abort();
        }
    }
    this.request_rate = this.request_count - this.requests_last_check;
    this.requests_last_check = this.request_count;
};

PoolEndpoint.prototype.reset_counters = function () {
    this.requests_last_check = this.request_rate - this.pending;
    this.request_count = this.pending;
    this.successes = 0;
    this.failures = 0;
    this.filtered = 0;
};

PoolEndpoint.prototype.update_pending = function () {
    this.pending = this.request_count - (this.successes + this.failures + this.filtered);
    if (this.request_count === MAX_COUNT) {
        this.reset_counters();
    }
};

PoolEndpoint.prototype.complete = function (err, request, response, body) {
    this.delete_request(request.id);
    this.update_pending();
    request.done(err, response, body);
};

PoolEndpoint.prototype.request_succeeded = function (request, response, body) {
    this.successes++;
    this.complete(null, request, response, body);
};

PoolEndpoint.prototype.request_failed = function (err, request) {
    this.failures++;
    if (!request.destroyed) {
        this.set_healthy(false);
    }
    this.complete(err, request);
};

PoolEndpoint.prototype.filter_rejected = function (err, request) {
    this.filtered++;
    this.complete(err, request);
};

PoolEndpoint.prototype.busyness = function () {
    return this.pending;
};

PoolEndpoint.prototype.set_healthy = function (new_state) {
    if (! this.ping_path) {
        return; // an endpoint with no pingPath can never be made unhealthy
    }
    if (! new_state) {
        this.pinger.start();
    }
    if (this.healthy !== new_state) {
        this.healthy = new_state;
        this.emit("health", this);
    }
};

PoolEndpoint.prototype.setHealthy = PoolEndpoint.prototype.set_healthy;

PoolEndpoint.prototype.delete_request = function (id) {
	delete this.requests[id];
};

module.exports = function init(new_global) {
    GO = new_global;

	return PoolEndpoint;
};
