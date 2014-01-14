// Copyright 2013 Voxer IP LLC. All rights reserved.

var Stream = require("stream");

// PoolRequestSet - an object to track server requests and handle retries
//
// pool: a pool of endpoints
// options: {
//     attempts: number of tries
//     maxHangups: number of 'socket hang ups' before giving up (2)
//     timeout: request timeout in ms
//     maxAborts: number of 'aborted' before giving up (2)
//     retryDelay: minimum ms to wait before first retry using exponential backoff (20)
// }
// callback: function (err, response, body) {}

function PoolRequestSet(pool, options, callback) {
    this.options = options || {};
    this.pool = pool;
    this.callback = callback;

    if (this.options.data instanceof Stream || this.options.end === false) {
        this.max_attempts = 1;
    } else {
        this.max_attempts = options.max_attempts || Math.min(pool.options.max_retries + 1, Math.max(pool.length, 2));
    }
    this.attempts_remaining = this.max_attempts;

    this.max_hangups = options.max_hangups || 2;
    this.hangups = 0;

    this.max_aborts = options.max_aborts || 2;
    this.aborts = 0;
    this.duration = null;

    if (!options.retry_delay && options.retry_delay !== 0) {
        options.retry_delay = 20;
    }
    this.delay = options.retry_delay;
}

PoolRequestSet.prototype.handle_response = function (err, response, body) {
    var delay;

    this.attempts_remaining--;

    if (err) {
        delay = Math.round(Math.random() * Math.pow(2, this.max_attempts - this.attempts_remaining) * this.delay);
        err.delay = delay; // stash delay here so "retrying" listeners can understand the delay

        if (err.reason === "socket hang up") {
            this.hangups++;
        } else if (err.reason === "aborted") {
            this.aborts++;
        }

        if (this.attempts_remaining > 0 && err.reason !== "full" && err.reason !== "unhealthy" && this.hangups < this.max_hangups && this.aborts < this.max_aborts) {
            this.pool.on_retry(err);
            if (delay > 0) {
                setTimeout(this.do_request.bind(this), delay);
            } else {
                this.do_request();
            }
            return;
        }
    }
    if (this.callback) {
        this.callback(err, response, body);
        this.callback = null;
    }
};

PoolRequestSet.prototype.do_request = function () {
    var endpoint = this.pool.get_endpoint(this.options),
        self = this;
    return endpoint.request(this.options, function (err, res, body, duration) {
        self.duration = duration;
        self.handle_response(err, res, body);
    });
};

module.exports = function init() {
    return PoolRequestSet;
};
