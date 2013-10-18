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
});
