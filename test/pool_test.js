// Copyright 2013 Voxer IP LLC. All rights reserved.

var assert = require("assert");

var noop = function () {};

function FakeEndpointRequest(endpoint, options, callback) {
    this.endpoint = endpoint;
    this.options = options;
    this.done = this.callback = callback;

    this.id = endpoint.request_count++;
}

FakeEndpointRequest.prototype.start = function () {};

var success_body = "success body";

function start_with_success() {
    this.endpoint.request_succeeded(this, { statusCode: 200 }, success_body);
}
function start_with_success_reuse() {
    this.endpoint.request_succeeded(this, { statusCode: 200, socket: { request_count: 2 } }, success_body);
}
function start_with_fail() {
    this.endpoint.request_failed({
        message: "failed request",
        reason: "unreasonably failed"
    }, this);
}

var http = {
    request: noop,
    Agent: noop
};
var GO = {};

var Pool;

GO.PoolEndpoint = require("../pool_endpoint")(GO);
GO.PoolRequestSet = require("../pool_request_set")(GO);
GO.PoolEndpointRequest = FakeEndpointRequest;
GO.KeepAliveAgent = require("../keep_alive_agent")(GO);
GO.PoolPinger = require("../pool_pinger")(GO);
Pool = require("../pool")(GO);

describe("Pool", function () {
    it("throws an Error if constructed with no endpoints", function () {
        assert.throws(function () {
            return new Pool();
        });
    });

    it("throws an Error when the node list is invalid", function () {
        assert.throws(function () {
            return new Pool(http, ["foo_bar"]);
        });
    });

    it("throws an Error when http is invalid", function () {
        assert.throws(function () {
            return new Pool({}, ["127.0.0.1:8080"]);
        });
    });

    it("sets this.length to this.endpoints.length", function () {
        var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
        assert.equal(p.length, 3);
    });

    it("sets limits endpoints to max_pool_size option", function () {
        var endpoints = [
            "127.0.0.1:8080",
            "127.0.0.1:8081",
            "127.0.0.1:8082",
            "127.0.0.1:8083",
            "127.0.0.1:8084",
            "127.0.0.1:8085",
            "127.0.0.1:8086"
        ];
        var p = new Pool(http, endpoints, {max_pool_size: 2});
        assert.equal(p.length, 2);
    });

    it("selecting endpoints from max_pool_size should be random", function () {
        var endpoints = [
            "127.0.0.1:8080",
            "127.0.0.1:8081",
            "127.0.0.1:8082",
            "127.0.0.1:8083",
            "127.0.0.1:8084",
            "127.0.0.1:8085",
            "127.0.0.1:8086"
        ];

        var pools = [
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2}),
            new Pool(http, endpoints, {max_pool_size: 2})
        ];

        var seenEndpoints = {};
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            var endpointsByName = Object.keys(p.endpoints_by_name);
            for (var j = 0; j < endpointsByName.length; j++) {
                var hostPort = endpointsByName[j];
                if (!seenEndpoints[hostPort]) {
                    seenEndpoints[hostPort] = 1;
                } else {
                    seenEndpoints[hostPort]++;
                }
            }
        }

        // Should see at least 75% of endpoints picked.
        var numberOfEndpoints = Object.keys(seenEndpoints).length;
        assert.ok(numberOfEndpoints >= 5)
    });

    it("throws an Error when options.max_pool_size is invalid", function () {
        assert.throws(function () {
            return new Pool({}, ["127.0.0.1:8080"], {max_pool_size: -1});
        });
    });

    describe("add/remove endpoints", function () {
        var endpoints = [
            "127.0.0.1:8080",
            "127.0.0.1:8081",
            "127.0.0.1:8082"
        ];

        it("adds endpoint", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            p.add_endpoint("127.0.0.1:8086")
            assert.equal(p.length, 4);
        });

        it("filters invalid port", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            p.add_endpoint("127.0.0.1:999999");
            assert.equal(p.length, 3);
        });

        it("filters invalid hostport no sep", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            p.add_endpoint("localhost999999");
            assert.equal(p.length, 3);
        });


        it("adds endpoints according to  max_pool_size", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep, {max_pool_size: 2});
            assert.equal(p.length, 2);

            for (var i = 0; i < 20; i++) {
                var port = 8090 + i;
                p.add_endpoint("127.0.0.1:" + port);
            }
            assert.equal(p.length, 2);
        });

        it("adds endpoints with larger max_pool_size", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep, {max_pool_size: 20});
            assert.equal(p.length, ep.length);

            for (var i = 0; i < 20; i++) {
                var port = 8090 + i;
                p.add_endpoint("127.0.0.1:" + port);
                var expSize = Math.min(20, i + 1 + ep.length);
                assert.equal(p.length, expSize);
            }
        });

        it("removes endpoints", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8080")
            assert.equal(p.length, 2);
        })

        it("removing non-existant endpoint is no-op", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8089")
            assert.equal(p.length, 3);
        })

        it("removes endpoints with max_pool_size set", function () {
            var ep = endpoints.slice(0);
            ep.push("127.0.0.1:8083")
            ep.push("127.0.0.1:8084")
            var p = new Pool(http, ep, {maxPoolSize: 3});
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);
            p.add_endpoint("127.0.0.1:8085");
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);
            assert.equal(p.all_hostports.length, 6);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8085")
            assert.equal(p.all_hostports.length, 5);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8084")
            assert.equal(p.all_hostports.length, 4);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8083")
            assert.equal(p.all_hostports.length, 3);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8082")
            assert.equal(p.all_hostports.length, 2);
            assert.equal(p.length, 2);
            p.remove_endpoint("127.0.0.1:8081")
            assert.equal(p.all_hostports.length, 1);
            assert.equal(p.length, 1);
        })

        it("removes endpoints works with max_size > all_hostports", function () {
            var ep = endpoints.slice(0);
            ep.push("127.0.0.1:8083")
            ep.push("127.0.0.1:8084")
            var p = new Pool(http, ep, {maxPoolSize: 20});
            assert.equal(Object.keys(p.endpoints_by_name).length, 5);
            p.add_endpoint("127.0.0.1:8085");
            assert.equal(Object.keys(p.endpoints_by_name).length, 6);
            assert.equal(p.all_hostports.length, 6);
            assert.equal(p.length, 6);
            p.remove_endpoint("127.0.0.1:8085")
            assert.equal(p.all_hostports.length, 5);
            assert.equal(p.length, 5);
            p.remove_endpoint("127.0.0.1:8084")
            assert.equal(p.all_hostports.length, 4);
            assert.equal(p.length, 4);
            p.remove_endpoint("127.0.0.1:8083")
            assert.equal(p.all_hostports.length, 3);
            assert.equal(p.length, 3);
            p.remove_endpoint("127.0.0.1:8082")
            assert.equal(p.all_hostports.length, 2);
            assert.equal(p.length, 2);
            p.remove_endpoint("127.0.0.1:8081")
            assert.equal(p.all_hostports.length, 1);
            assert.equal(p.length, 1);
        })
    });

    describe("adjust_pool_size", function () {
        var endpoints = [
            "127.0.0.1:8080",
            "127.0.0.1:8081",
            "127.0.0.1:8082",
            "127.0.0.1:8083",
            "127.0.0.1:8084"
        ];

        it("adjust is no-op if max_pool_size not set", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep);
            assert.equal(p.length, 5);
            assert.equal(p.all_hostports.length, 5);
            p.adjust_pool_size();
            assert.equal(p.length, 5);
            assert.equal(p.all_hostports.length, 5);
        });

        it("adjust removes pool endpoints if there are too many", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep, {maxPoolSize: 3});
            assert.equal(p.all_hostports.length, 5);
            assert.equal(p.length, 3);
            assert.equal(p.endpoints.length, 3);
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);

            for (var i = 0; i < endpoints.length; i++) {
                p.add_pool_endpoint(endpoints[i]);
            }
            assert.equal(p.length, 5);
            assert.equal(p.endpoints.length, 5);
            assert.equal(Object.keys(p.endpoints_by_name).length, 5);

            p.adjust_pool_size();

            assert.equal(p.length, 3);
            assert.equal(p.endpoints.length, 3);
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);
        });

        it("adjust adds pool endpoints if there are too few", function () {
            var ep = endpoints.slice(0);
            var p = new Pool(http, ep, {maxPoolSize: 3});
            assert.equal(p.all_hostports.length, 5);
            assert.equal(p.length, 3);
            assert.equal(p.endpoints.length, 3);
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);

            for (var i = 0; i < endpoints.length; i++) {
                p.remove_pool_endpoint(endpoints[i]);
            }
            assert.equal(p.length, 0);
            assert.equal(p.endpoints.length, 0);
            assert.equal(Object.keys(p.endpoints_by_name).length, 0);

            p.adjust_pool_size();

            assert.equal(p.length, 3);
            assert.equal(p.endpoints.length, 3);
            assert.equal(Object.keys(p.endpoints_by_name).length, 3);
        });
    })


    describe("healthy_endpoints()", function () {
        it("filters out unhealthy endpoints from the result", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            p.endpoints[0].healthy = false;
            assert.equal(true, p.healthy_endpoints().every(function (n) {
                return n.healthy;
            }));
        });
    });

    describe("get_endpoint()", function () {
        it("returns the 'overloaded' endpoint when total_pending > max_pending", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"], { max_pending: 30 });
            p.endpoints.forEach(function (n) { n.pending = 10; });
            assert.equal(p.get_endpoint().special_endpoint, "overloaded");
        });

        it("returns the 'unhealthy' endpoint when no endpoints are healthy", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            p.endpoints.forEach(function (n) { n.healthy = false; });
            assert.equal(p.get_endpoint().special_endpoint, "unhealthy");
        });

        it("returns a 'ready' endpoint when one is available", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            var n = p.endpoints[0];
            n.ready = function () { return true; };
            n.test_flag = true;
            p.endpoints[1].ready = function () { return false; };
            p.endpoints[2].ready = function () { return false; };
            assert.equal(p.get_endpoint().test_flag, true);
        });

        it("returns a healthy endpoint when at least one is 'ready'", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            p.endpoints[0].healthy = false;
            p.endpoints[1].healthy = false;
            p.endpoints[2].healthy = true;
            assert(p.get_endpoint().healthy);
        });
    });

    describe("unhealthy_endpoint", function () {
        it("returns a 'unhealthy' error on request", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            p.unhealthy_endpoint.request({}, function (err) {
                assert.equal(err.reason, "unhealthy");
            });
        });

        it("is not healthy", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            assert.equal(false, p.unhealthy_endpoint.healthy);
        });
    });

    describe("overloaded_endpoint", function () {
        it("returns a 'full' error on request", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            p.overloaded_endpoint.request({}, function (err) {
                assert.equal(err.reason, "full");
            });
        });

        it("is not healthy", function () {
            var p = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            assert.equal(false, p.overloaded_endpoint.healthy);
        });
    });

    describe("request()", function () {
        it("calls callback with response on success", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.request({}, null, function (err, res, body) {
                assert.equal(body, success_body);
                done();
            });
        });

        it("calls callback with error on failure", function (done) {
            FakeEndpointRequest.prototype.start = start_with_fail;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.request({}, null, function (err, res, body) {
                assert.strictEqual(err.message, "failed request");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
        });

        it("emits timing on success", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function () {
                done();
            });
            pool.request({}, null, noop);
        });

        it("emits timing on failure", function (done) {
            FakeEndpointRequest.prototype.start = start_with_fail;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function () {
                done();
            });
            pool.request({}, null, noop);
        });

        it("sets the reused field of options to true when the socket is reused", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success_reuse;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert(options.reused);
                done();
            });
            pool.request({}, null, noop);
        });

        it("sets the reused field of options to false when the socket isn't reused", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.reused, false);
                done();
            });
            pool.request({}, null, noop);
        });

        it("allows the data parameter to be optional", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.request({}, function (err, res, body) {
                assert.equal(res.statusCode, 200);
                assert.equal(body, success_body);
                done();
            });
        });

        it("allows the options parameter to be a path string", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.path, "/foo");
                done();
            });
            pool.request("/foo", function (err, res, body) {
                assert.equal(res.statusCode, 200);
                assert.equal(body, success_body);
            });
        });

        it("defaults method to GET", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.method, "GET");
                done();
            });
            pool.request("/foo", function (err, res, body) {
                assert.equal(res.statusCode, 200);
                assert.equal(body, success_body);
            });
        });

        it("causes pool to emit response event", function (done) {
            var doneCounter = 0;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);

            function doneOne() {
                if (++doneCounter === 2) {
                    done();
                }
            }

            function assertResponse(assertions) {
                pool.once("response", function (err, poolReq, res) {
                    assertions(err, poolReq, res);
                    assert.ok(poolReq);
                    assert.equal(poolReq.options.path, "/foo");
                    doneOne();
                });
            }

            function requestFoo() {
                pool.request("/foo", function() {});
            }

            // Without error
            FakeEndpointRequest.prototype.start = start_with_success;
            assertResponse(function(err, poolReq, res) {
                assert.ifError(err);
                assert.ok(res);
            });
            requestFoo();

            // With error
            FakeEndpointRequest.prototype.start = start_with_fail;
            assertResponse(function(err, poolReq, res) {
                assert.ok(err);
                assert.equal(res, undefined);
            });
            requestFoo();
        });
    });

    describe("get()", function () {
        it("is an alias to request()", function (done) {
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            assert.equal(pool.get, pool.request);
            done();
        });
    });

    describe("put()", function () {
        it("sets the options.method to PUT", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.method, "PUT");
            });
            pool.put("/foo", "bar", function (err, res, body) {
                assert.strictEqual(err, null);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(body, success_body);
                done();
            });
        });
    });

    describe("post()", function () {
        it("sets the options.method to POST", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.method, "POST");
            });
            pool.post("/foo", "bar", function (err, res, body) {
                assert.strictEqual(err, null);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(body, success_body);
                done();
            });
        });
    });

    describe("del()", function () {
        it("sets the options.method to del", function (done) {
            FakeEndpointRequest.prototype.start = start_with_success;
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081", "127.0.0.1:8082"]);
            pool.on("timing", function (interval, options) {
                assert.equal(options.method, "DELETE");
            });
            pool.del("/foo", function (err, res, body) {
                assert.strictEqual(err, null);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(body, success_body);
                done();
            });
        });
    });

    describe("remove_endpoint()", function () {
        it("fails future requests", function (done) {
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081"]);
            pool.remove_endpoint("127.0.0.1:8081");
            pool.get({endpoint: "127.0.0.1:8081", path: "/"}, function (err, res) {
                assert(err);
                assert(!res);
                done();
            });
        });
    });

    describe("close()", function () {
        it("does not fail", function (done) {
            var pool = new Pool(http, ["127.0.0.1:8080", "127.0.0.1:8081"]);
            pool.close();
            done();
        });
    });
});
