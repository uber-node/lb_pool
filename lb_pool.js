// Copyright 2013 Voxer IP LLC. All rights reserved.

var RV;

module.exports = function init(new_RV) {
    RV = new_RV || {};

    RV.KeepAliveAgent = require("./keep_alive_agent")(RV);
    RV.PoolPinger = require("./pool_pinger")(RV);
    RV.PoolEndpoint = require("./pool_endpoint")(RV);
    RV.PoolEndpointRequest = require("./pool_endpoint_request")(RV);
    RV.PoolRequestSet = require("./pool_request_set")(RV);

    return require("./pool")(RV);
};
