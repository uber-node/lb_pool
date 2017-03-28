// Copyright 2013 Voxer IP LLC. All rights reserved.

var GO, // GO is global object, for passing to a REPL or finding in a core dump
    EventEmitter = require("events").EventEmitter,
    Stream = require("stream"),
    inherits = require("util").inherits;

//  Pool - manages a set of equivalent endpoints and distributes requests among them
//
// http: which endpoint HTTP module to use, either http.js or https.js
// endpoints: array of strings formatted like "ip:port"
// options: {
//    max_pending: number of pending requests allowed (1000)
//    max_sockets: number of sockets per Endpoint (5)
//    ping: ping path (default = no ping checks)
//    ping_timeout: number (milliseconds) default 2000
//    retry_filter: function (response) { return true to reject response and retry }
//    retry_delay: number (milliseconds) default 20
//    keep_alive: use an alternate Agent that does keep-alive properly (boolean) default false
//    name: string (optional)
//    max_retries: number (default = 5)
//    agent_options: {} an object for passing options directly to the HTTP(S) Agent
// }
function Pool(http, endpoints, options) {
    if (!http || !http.request || !http.Agent) {
        throw new Error("invalid http module");
    }
    if (! Array.isArray(endpoints)) {
        throw new Error("endpoints must be an array");
    }
    this.http = http;

    options = options || {};
    options.retry_filter = options.retry_filter || options.retryFilter;
    options.retry_delay = options.retry_delay || options.retryDelay;
    options.ping = options.ping || options.path;
    if (typeof options.max_retries === "number") {
        options.max_retries = options.max_retries;
    } else if (typeof options.maxRetries === "number") {
        options.max_retries = options.maxRetries;
    } else {
        options.max_retries = 5;
    }

    // retry_delay can be 0, which is useful but also falsy so we check for 0 explicitly
    if (!options.retry_delay && options.retry_delay !== 0) {
        options.retry_delay = 20;
    }

    this.name = options.name;
    this.options = options;
    this.max_pending = options.max_pending || options.maxPending || 1000;
    this.max_pool_size = options.max_pool_size || options.maxPoolSize;
    this.endpoints = [];
    this.endpoints_by_name = {};

    // clone
    this.all_hostports = endpoints.slice();

    if (this.max_pool_size !== undefined && this.max_pool_size !== null &&
        (typeof this.max_pool_size !== 'number' || this.max_pool_size < 1)) {
        throw new Error('max_pool_size invalid');
    }

    var selectedEndpoints = endpoints;

    if (this.max_pool_size < endpoints.length) {
        // simple resevoir sampling algorithm
        selectedEndpoints = new Array(this.max_pool_size);
        for (var j = 0; j < endpoints.length; j++) {
            if (j < this.max_pool_size) {
                selectedEndpoints[j] = endpoints[j];
            } else {
                // random replacement with decreasing probablity
                var r = Math.random() * (j + 1);
                if (r < this.max_pool_size) {
                    selectedEndpoints[r] = endpoints[j];
                }
            }
        }
    }

    this.length = 0;
    for (var i = 0; i < selectedEndpoints.length; i++) {
        this.add_pool_endpoint(selectedEndpoints[i]);
    }

    if (this.endpoints.length === 0) {
        throw new Error("no valid endpoints");
    }

    // this special endpoint is returned when the pool is overloaded
    this.overloaded_endpoint = new GO.PoolEndpoint({Agent: Object}, null, null, {timeout: 0});
    this.overloaded_endpoint.special_endpoint = "overloaded";
    this.overloaded_endpoint.healthy = false;
    this.overloaded_endpoint.request = function (options, callback) {
        var err = new Error("too many pending requests");
        err.reason = "full";
        err.delay = true;
        err.attempt = { options: options };
        process.nextTick(function () {
            callback(err);
        });
    };

    // this special endpoint is returned when there are no healthy endpoints
    this.unhealthy_endpoint = new GO.PoolEndpoint({Agent: Object}, null, null, {timeout: 0});
    this.unhealthy_endpoint.special_endpoint = "unhealthy";
    this.unhealthy_endpoint.healthy = false;
    this.unhealthy_endpoint.request = function (options, callback) {
        var err = new Error("no healthy endpoints");
        err.reason = "unhealthy";
        err.delay = true;
        err.attempt = { options: options };
        process.nextTick(function () {
            callback(err);
        });
    };
}
inherits(Pool, EventEmitter);

Pool.prototype.endpoint_health_changed = function endpoint_health_changed(endpoint) {
    this.emit("health", endpoint.name + " health: " + endpoint.healthy);
};

Pool.prototype.endpoint_timed_out = function endpoint_timed_out(request) {
    this.emit("timeout", request);
};

// returns an array of healthy Endpoints
Pool.prototype.healthy_endpoints = function health_endpoints() {
    var healthy = [],
        len = this.endpoints.length;

    for (var i = 0; i < len; i++) {
        var n = this.endpoints[i];
        if (n.healthy) {
            healthy.push(n);
        }
    }
    return healthy;
};

Pool.prototype.on_retry = function on_retry(err) {
    this.emit("retrying", err);
};

// options: {
//   path: string
//   method: ["POST", "GET", "PUT", "DELETE", "HEAD"] (GET)
//   retryFilter: function (response) { return true to reject response and retry }
//   attempts: number (optional, default = endpoints.length)
//   retryDelay: number (milliseconds) default Pool.retry_delay
//   timeout: request timeout in ms
//   encoding: response body encoding (utf8)
// }
// data: string or buffer
//
// callback:
// function(err, res, body) {}
// function(err, res) {}

// for convenience, we allow an option string to be the "path" option
Pool.prototype.init_req_options = function init_req_options(options) {
    if (! options) {
        return {};
    }
    if (typeof options === "string") {
        return { path: options };
    }
    return options;
};

Pool.prototype.request = function request(options, data, callback) {
    var self = this;

    options = this.init_req_options(options);

    // data is optional
    if (!options.data && (typeof data === "string" || Buffer.isBuffer(data) || data instanceof Stream)) {
        options.data = data;
    } else if (typeof data === "function") {
        callback = data;
    }

    if (typeof callback !== "function") {
        throw new Error("a callback is required");
    }

    options.method = options.method || "GET";

    options.retry_delay = options.retry_delay || options.retryDelay;
    if (!options.retry_delay && options.retry_delay !== 0) {
        options.retry_delay = this.options.retry_delay;
    }

    options.retry_filter = options.retry_filter || options.retryFilter;
    if (!options.retry_filter) {
        options.retry_filter = this.options.retry_filter;
    }

    var req_set = new GO.PoolRequestSet(this, options, function (err, res, body) {
        options.success = !err;
        if (res && res.socket && res.socket.request_count && res.socket.request_count > 1) {
            options.reused = true;
        } else {
            options.reused = false;
        }
        self.emit("timing", req_set.duration, options);
        self.emit("response", err, req_set, res);
        callback(err, res, body);
    });
    return req_set.do_request();
};

Pool.prototype.get = Pool.prototype.request;

Pool.prototype.put = function put(options, data, callback) {
    options = this.init_req_options(options); // note that this will call init_req_options twice, which is fine
    options.method = "PUT";
    return this.request(options, data, callback);
};

Pool.prototype.post = function post(options, data, callback) {
    options = this.init_req_options(options);
    options.method = "POST";
    return this.request(options, data, callback);
};

Pool.prototype.del = function del(options, callback) {
    options = this.init_req_options(options);
    options.method = "DELETE";
    return this.request(options, callback);
};

Pool.prototype.stats = function stats() {
    var stats = [];
    var len = this.endpoints.length;
    for (var i = 0; i < len; i++) {
        var endpoint = this.endpoints[i];
        stats.push(endpoint.stats());
    }
    return stats;
};

// endpoint selection strategy:
//   start at a random point in the list of all endpoints
//   walk through and use the first endpoint we find that is ready()
//   if none are ready, then check max_pending limits
//   walk the list of healthy endpoints, returning the first endpoint with below average pending
Pool.prototype.get_endpoint = function get_endpoint(options) {
    var endpoints_len = this.endpoints.length;
    var min_pending_level = Infinity, min_pending_endpoint = null;
    var total_pending = 0;
    var endpoint_pos = Math.floor(Math.random() * endpoints_len);
    var i, endpoint;

    options = options || {};
    if (options.endpoint) {
        endpoint = this.endpoints_by_name[options.endpoint];
        if (!endpoint) {
            return this.unhealthy_endpoint;
        }
        if (endpoint.pending >= this.max_pending) {
            return this.overloaded_endpoint;
        }
        // Note that if this endpoint is unhealthy, this request may fail, or it may work and then set node healthy.
        // Either way, if user requested a specific endpoint, they need that one, even if it's broken.
        return endpoint;
    }

    for (i = 0; i < endpoints_len; i++) {
        endpoint_pos = (endpoint_pos + 1) % endpoints_len;
        endpoint = this.endpoints[endpoint_pos];
        if (endpoint.ready()) {
            return endpoint; // idle keepalive socket
        } else if (endpoint.healthy && endpoint.pending < min_pending_level) {
            min_pending_level = endpoint.pending;
            min_pending_endpoint = endpoint;
        }
        total_pending += endpoint.pending;
    }

    // fail request immediately if the pool is too busy
    if (total_pending >= this.max_pending && !options.override_pending) {
        return this.overloaded_endpoint;
    }

    if (min_pending_endpoint) {
        return min_pending_endpoint;
    }

    // if we made it this far, none of the endpoints were healthy
    return this.unhealthy_endpoint;
};
Pool.prototype.get_node = Pool.prototype.get_endpoint;
Pool.prototype.getNode = Pool.prototype.get_endpoint;

Pool.prototype.pending = function pending() {
    var count = 0;
    var endpoints = this.endpoints;
    for (var i = 0; i < endpoints.length; i++) {
        count += endpoints[i].pending;
    }
    return count;
};

Pool.prototype.rate = function rate() {
    var count = 0;
    var endpoints = this.endpoints;
    for (var i = 0; i < endpoints.length; i++) {
        count += endpoints[i].request_rate;
    }
    return count;
};

Pool.prototype.request_count = function request_count() {
    var count = 0;
    var endpoints = this.endpoints;
    for (var i = 0; i < endpoints.length; i++) {
        count += endpoints[i].request_count;
    }
    return count;
};

Pool.prototype.close = function close() {
    var endpoints = this.endpoints;
    for (var i = 0; i < endpoints.length; i++) {
        endpoints[i].close();
    }
};

Pool.prototype.valid_host_port = function valid_host_port(host_port) {
    var ip_port = host_port.split(":");
    var ip = ip_port[0];
    var port = +ip_port[1];
    if (port > 0 && port < 65536) {
        return ip_port;
    }
    return null;
};

// Dynamic membership
Pool.prototype.add_endpoint = function add_endpoint(host_port) {
    var ip_port = this.valid_host_port(host_port);
    if (!ip_port) {
        return null;
    }

    var hasHostPort = this.all_hostports.indexOf(host_port) >= 0;
    if (!hasHostPort) {
        this.all_hostports.push(host_port);
    }

    var maxSizeIsRelevant = this.max_pool_size &&
        this.max_pool_size < this.all_hostports.length;

    // if using maxSize, probabilistically add the new host port to the
    // active pool endpoints
    if (maxSizeIsRelevant) {
        var r = Math.random() * this.all_hostports.length;
        // note: the + 1 is a significant bias correction for adding then removing
        if (r < this.max_pool_size + 1) {
            this.add_pool_endpoint(host_port);
            this.adjust_pool_size();
        }
        return null;
    }

    this.add_pool_endpoint(host_port);
};

Pool.prototype.add_pool_endpoint = function add_pool_endpoint(host_port, ip_port) {
    ip_port = ip_port || this.valid_host_port(host_port);
    if (!ip_port) {
        return;
    }

    // check already added
    if (this.endpoints_by_name[host_port]) {
        return;
    }
    var ip = ip_port[0];
    var port = +ip_port[1];
    var endpoint = new GO.PoolEndpoint(this.http, ip, port, this.options);
    endpoint.on("health", this.endpoint_health_changed.bind(this));
    endpoint.on("timeout", this.endpoint_timed_out.bind(this));
    this.endpoints.push(endpoint);
    this.length++;
    this.endpoints_by_name[host_port] = endpoint;
};

Pool.prototype.remove_endpoint = function rm_endpoint(host_port) {
    for (var j = 0; j < this.all_hostports.length; j++) {
        if (this.all_hostports[j] === host_port) {
            this.all_hostports.splice(j, 1);
        }
    }

    this.remove_pool_endpoint(host_port);
    this.adjust_pool_size();
};

Pool.prototype.remove_pool_endpoint = function rm_pool_endpoint(host_port) {
    var endpoint = this.endpoints_by_name[host_port];
    if (!endpoint) { return; }

    delete this.endpoints_by_name[host_port];
    endpoint.close();
    this.length--;
    var endpoints = this.endpoints;
    for (var i = 0; i < endpoints.length; i++) {
        if (endpoints[i] === endpoint) {
            endpoints.splice(i, 1);
            return;
        }
    }
};

// adjusts the pool size within max_pool_size boundary if necessary
// after we add/remove a discrete element from the pool, this adjustment must
// carefully select a random element to remove/add so that connections are distributed
// evenly across the cluster
Pool.prototype.adjust_pool_size = function adjust_pool_size() {
    // length can only be out of sync with all hostports if there's a max_pool_size
    if (!this.max_pool_size) {
        return;
    }
    var expected_size = Math.min(this.max_pool_size, this.all_hostports.length);

    if (expected_size === this.length) {
        return;
    }

    while (this.length !== expected_size) {
        var idx;
        if (this.length < expected_size) {
            // add a random host from the all host_ports
            var unused = this.unused_hostports();
            idx = Math.floor(Math.random() * unused.length);
            var randHostPort = unused[idx];
            if (!this.endpoints_by_name[randHostPort]) {
                this.add_pool_endpoint(randHostPort);
            }
        } else if (this.length > expected_size) {
            idx = Math.floor(Math.random() * this.length);
            var randEndpoint = this.endpoints[idx];
            this.remove_pool_endpoint(randEndpoint.ip + ':' + randEndpoint.port);
        }
    }
};

Pool.prototype.unused_hostports = function unused_hostports() {
    var unused = new Array(this.all_hostports.length - this.length);
    var i = 0;

    for (var j = 0; j < this.all_hostports.length; j++) {
        var hostport = this.all_hostports[j];
        if (!this.endpoints_by_name[hostport]) {
            unused[i] = hostport;
            i++;
        }
    }
    return unused;
};

module.exports = function init(new_GO) {
    GO = new_GO;
    return Pool;
};
