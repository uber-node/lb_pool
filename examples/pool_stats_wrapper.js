// Copyright (c) 2013 Voxer IP LLC. All rights reserved.

// Voxer specific logging and metrics around the generic poolee library

var RV;
var inherits = require("util").inherits;
var log, warn, error, histogram, counter;
var Pool = require("./lb_pool")(RV);

function PooleeStatsWrapper(http, nodes, options) {
    var self = this;

    options = options || {};
    if (!options.hasOwnProperty("keep_alive")) {
        options.keep_alive = true;
    }
    Pool.call(this, http, nodes, options);

    this.interval_timer = setInterval(function () {
        self.emit_stats();
    }, options.stat_interval || 60000);

    this.on("retrying", function (err) {
        var path = err.attempt.options.path;
        log(this.name + " retry", "path=" + path + " reason=" + err.message);
        counter("LB_Pool>retry|" + this.name + "|" + err.reason.replace(/\W/g, "_"));
    });

    this.on("health", function (status) {
        log(this.name + " health", "status=" + status);
    });

    this.on("timeout", function (uri, state) {
        log(this.name + " timeout", "uri=" + uri + " state=" + state);
        counter("LB_Pool>timeout>" + this.name + "|" + state);
    });

    this.on("timing", function (duration, request_options) {
        var path = request_options.path.split("?")[0];
        histogram("LB_Pool>timing>" + this.name + "|" + (options.no_metric_path ? request_options.method : path), duration);
        if (request_options.reused) {
            counter("LB_Pool>sockets>reused|" + this.name);
        } else {
            counter("LB_Pool>sockets>created|" + this.name);
        }
        if (!request_options.success) {
            histogram("LB_Pool>failed>" + this.name, duration);
            log(this.name + " request failed", "host=" + request_options.host + " path=" + request_options.path + " duration=" + duration);
        }
        if (duration > 200) { // TODO - magic number alert
            log("timing_stats", "method=" + request_options.method + " path=" + request_options.path + " endpoint=" + request_options.host + ":" + request_options.port + " duration=" + duration);
        }
    });
}
inherits(PooleeStatsWrapper, Pool);

PooleeStatsWrapper.prototype.emit_stats = function () {
    var all_stats = this.stats(), endpoint, i;
    var total_pending = 0, total_sockets = 0, total_unhealthy = 0;

    for (i = 0; i < all_stats.length; i++) {
        endpoint = all_stats[i];
        total_pending += endpoint.pending;
        total_sockets += endpoint.socket_request_counts.length;
        if (! endpoint.healthy) {
            total_unhealthy++;
        }
    }
    histogram("LB_Pool>stats>pending_total|" + this.name, total_pending);
    histogram("LB_Pool>stats>sockets_total|" + this.name, total_sockets);
    histogram("LB_Pool>stats>unhealthy_total|" + this.name, total_unhealthy);
};

module.exports = function init(new_RV) {
    RV = new_RV;

    var metrics = require("./metrics_client");
    histogram = metrics.histogram;
    counter = metrics.counter;

    var logger = require("./logger");
    log = logger.log;
    warn = logger.warn;
    error = logger.error;

	return PooleeStatsWrapper;
};
