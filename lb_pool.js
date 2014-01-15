// Copyright 2013 Voxer IP LLC. All rights reserved.

var GO; // global object for attaching to a REPL and finding in core dumps

module.exports = function init(new_GO) {
    GO = new_GO || {};

    GO.KeepAliveAgent = require("./keep_alive_agent")(GO);
    GO.PoolPinger = require("./pool_pinger")(GO);
    GO.PoolEndpoint = require("./pool_endpoint")(GO);
    GO.PoolEndpointRequest = require("./pool_endpoint_request")(GO);
    GO.PoolRequestSet = require("./pool_request_set")(GO);

    return require("./pool")(GO);
};
