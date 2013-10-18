// Copyright 2013 Voxer IP LLC. All rights reserved.

var GO;

function PoolPinger(pool_endpoint) {
    this.pool_endpoint = pool_endpoint;
    this.running = false;
    this.attempts = 0;
    this.ping_timeout = pool_endpoint.ping_timeout;
    this.out_req = null;
    this.req_timer = null;
}

PoolPinger.prototype.start = function () {
    if (! this.pool_endpoint.ping_path) {
        return;
    }

    if (! this.running) {
        this.running = true;
        this.attempts = 0;
        this.ping();
    }
};

PoolPinger.prototype.ping = function () {
    if (this.req_timer) {
        clearTimeout(this.req_timer);
    }
    if (this.attempts > 0) {
        setTimeout(this.make_request.bind(this), this.backoff());
    } else {
        this.make_request();
    }
};

// Make a request to the ping_path using bare node and no agent. This way we won't create a new socket on the
// real agent and thus make a newly revived node be prefered.
PoolPinger.prototype.make_request = function () {
    var self = this;

    this.req_timer = setTimeout(function () {
        self.on_timeout();
    }, this.ping_timeout);

    this.out_req = this.pool_endpoint.http.get({
        host: this.pool_endpoint.ip,
        port: this.pool_endpoint.port,
        agent: false,
        path: this.pool_endpoint.ping_path
    });
    this.out_req.on("response", function (res) {
        self.on_response(res);
    });
    this.out_req.on("error", function () {
        self.attempts++;
        self.ping();
    });
};

PoolPinger.prototype.on_response = function (res) {
    if (res.statusCode === 200) {
        clearTimeout(this.req_timer);
        this.pool_endpoint.set_healthy(true);
        this.running = false;
    } else {
        this.attempts++;
        this.ping();
    }
};

PoolPinger.prototype.on_timeout = function () {
    this.req_timer = null;
    this.out_req.abort();
    // calling abort() will run the "error" listener which will retry
};

// Add some fun random variance to the delay until we get to 20 seconds, then keep retrying at 20.
PoolPinger.prototype.backoff = function () {
    return Math.min(Math.floor(Math.random() * Math.pow(2, this.attempts) + 10), 20000);
};

module.exports = function init(new_GO) {
    GO = new_GO;

    return PoolPinger;
};
