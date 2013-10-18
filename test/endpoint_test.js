// Copyright 2013 Voxer IP LLC. All rights reserved.

var assert = require("assert");
var http = require("http");
var https = require("https");

var noop = function () {};

var RV = {};
var PoolEndpoint;

RV.PoolPinger = require("../pool_pinger")(RV);
RV.KeepAliveAgent = require("../keep_alive_agent")(RV);
RV.PoolEndpoint = require("../pool_endpoint")(RV);
RV.PoolEndpointRequest = require("../pool_endpoint_request")(RV);
PoolEndpoint = RV.PoolEndpoint;

describe("PoolEndpoint", function () {
    it("passes nothing to the Agent constructor when no agentOptions are given", function () {
        var e = new PoolEndpoint(http, "127.0.0.1", 6969, { bogus: true });
        assert.equal(e.agent.options.bogus, undefined);
    });

    it("passes agentOptions to the underlying Agent (no keep-alive)", function () {
        var e = new PoolEndpoint(http, "127.0.0.1", 6969, { agentOptions: { cert: "foo", key: "bar"}});
        assert.equal(e.agent.options.cert, "foo");
        assert.equal(e.agent.options.key, "bar");
    });

    it("passes agentOptions to the underlying Agent (keep-alive)", function () {
        var e = new PoolEndpoint(http, "127.0.0.1", 6969, {keepAlive: true, agentOptions: { cert: "foo", key: "bar"}});
        assert.equal(e.agent.options.cert, "foo");
        assert.equal(e.agent.options.key, "bar");
    });

    it("passes agentOptions to the underlying Agent (keep-alive secure)", function () {
        var e = new PoolEndpoint(https, "127.0.0.1", 6969, {keepAlive: true, agentOptions: { cert: "foo", key: "bar"}});
        assert.equal(e.agent.options.cert, "foo");
        assert.equal(e.agent.options.key, "bar");
    });

    describe("request()", function () {
        it("sends Content-Length when data is a string", function (done) {
            var port = 6970;
            var s = http.createServer(function (req, res) {
                assert.equal(req.headers["content-length"], 4);
                res.end("foo");
                s.close();
                done();
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", port);
                e.request({path: "/foo", method: "PUT", data: "ƒoo"}, noop);
            });
            s.listen(port);
        });

        it("sends Content-Length when data is a buffer", function (done) {
            var s = http.createServer(function (req, res) {
                assert.equal(req.headers["content-length"], 4);
                res.end("foo");
                s.close();
                done();
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969);
                e.request({path: "/foo", method: "PUT", data: new Buffer("ƒoo")}, noop);
            });
            s.listen(6969);
        });

        it("times out and returns an error when the server fails to respond in time", function (done) {
            var s = http.createServer(function (req, res) {
                setTimeout(function () {
                    res.end("foo");
                }, 30);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var error;
                e.request({path: "/foo", method: "GET"}, function (err, response, body) {
                    error = err;
                    assert.strictEqual(error.reason, "socket hang up");
                    assert.strictEqual(/request timed out$/.test(error.message), true);
                    assert.strictEqual(response, undefined);
                    assert.strictEqual(body, undefined);
                });
                setTimeout(function () {
                    s.close();
                    done();
                }, 40);
            });
            s.listen(6969);
        });

        it("times out and returns an error when the server response hasn't sent any data within the timeout", function (done) {
            this.timeout(0);
            var s = http.createServer(function (req, res) {
                res.writeHead(200);

                setTimeout(function () {
                    res.write("foo");
                }, 10);

                setTimeout(function () {
                    res.write("bar");
                }, 40);

            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 15, resolution: 10});
                var error;
                e.request({path: "/foo", method: "GET"}, function (err, response, body) {
                    error = err;
                    assert.strictEqual(response, undefined);
                    assert.strictEqual(body, undefined);
                });

                setTimeout(function () {
                    s.close();
                    assert.equal(error.reason, "aborted");
                    assert.equal(/response timed out$/.test(error.message), true);
                    done();
                }, 60);
            });
            s.listen(6969);
        });

        it("emits a timeout event on timeout", function (done) {
            var s = http.createServer(function (req, res) {
                setTimeout(function () {
                    res.end("foo");
                }, 30);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var fin = false;
                e.on("timeout", function () {
                    fin = true;
                });
                e.request({path: "/foo", method: "GET"}, noop);

                setTimeout(function () {
                    s.close();
                    assert.equal(fin, true);
                    done();
                }, 60);
            });
            s.listen(6969);
        });

        it("removes the request from this.requests on timeout", function (done) {
            var s = http.createServer(function (req, res) {
                setTimeout(function () {
                    res.end("foo");
                }, 30);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {keepAlive: true, timeout: 20, resolution: 10});
                var fin = false;
                e.on("timeout", function () {
                    fin = true;
                });
                e.request({path: "/foo", method: "GET"}, noop);
                e.request({path: "/foo", method: "GET"}, noop);
                e.request({path: "/foo", method: "GET"}, noop);

                setTimeout(function () {
                    assert.equal(fin, true);
                    assert.equal(Object.keys(e.requests).length, 0);
                    s.close();
                    done();
                }, 100);
            });
            s.listen(6969);
        });

        it("removes the request from this.requests on error", function (done) {
            var s = http.createServer(function (req, res) {
                setTimeout(function () {
                    res.end("foo");
                }, 30);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var error;
                e.request({path: "/foo", method: "GET"}, function (err, response, body) {
                    error = err;
                    assert.strictEqual(response, undefined);
                    assert.strictEqual(body, undefined);
                });

                setTimeout(function () {
                    s.close();
                    assert.equal(error.reason, "socket hang up");
                    assert.equal(Object.keys(e.requests).length, 0);
                    done();
                }, 50);
            });
            s.listen(6969);
        });

        it("removes the request from this.requests on aborted", function (done) {
            var s = http.createServer(function (req, res) {
                res.writeHead(200);
                res.write("foo");
                setTimeout(function () {
                    req.connection.destroy();
                }, 10);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var error;
                e.request({path: "/foo", method: "GET"}, function (err, response, body) {
                    error = err;
                    assert.strictEqual(response, undefined);
                    assert.strictEqual(body, undefined);
                });

                setTimeout(function () {
                    s.close();
                    assert.equal(error.reason, "aborted");
                    assert.equal(Object.keys(e.requests).length, 0);
                    done();
                }, 50);
            });
            s.listen(6969);
        });

        it("removes the request from this.requests on success", function (done) {
            var s = http.createServer(function (req, res) {
                setTimeout(function () {
                    res.end("foo");
                }, 10);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var error;
                e.request({path: "/foo", method: "GET"}, function (err, response, body) {
                    error = err;
                    assert.strictEqual(response.statusCode, 200);
                    assert.strictEqual(body, "foo");
                });

                setTimeout(function () {
                    s.close();
                    assert.equal(error, null);
                    assert.equal(Object.keys(e.requests).length, 0);
                    done();
                }, 50);
            });
            s.listen(6969);
        });

        it("returns the whole body to the callback", function (done) {
            var s = http.createServer(function (req, res) {
                res.write("foo");
                setTimeout(function () {
                    res.end("bar");
                }, 10);
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10});
                var body;
                e.request({path: "/foo", method: "GET"}, function (err, response, b) {
                    body = b;
                });

                setTimeout(function () {
                    s.close();
                    assert.equal(body, "foobar");
                    done();
                }, 50);
            });
            s.listen(6969);
        });

        it("buffers the response when callback has 3 arguments and options.stream is not true", function (done) {
            var s = http.createServer(function (req, res) {
                res.end("foo");
            });
            s.on("listening", function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {timeout: 20, resolution: 10, max_pending: 1});
                e.request({path: "/ping", method: "GET"}, function (err, response, body) {
                    assert.equal(response.statusCode, 200);
                    assert.equal(response.complete, true);
                    assert.equal(body, "foo");
                    s.close();
                    done();
                });
            });
            s.listen(6969);
        });
    });

    describe("update_pending()", function () {
        it("maintains the correct pending count when requestCount 'overflows'", function () {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969);
            e.successes = (Math.pow(2, 52) / 2) - 250;
            e.failures = (Math.pow(2, 52) / 2) - 251;
            e.filtered = 1;
            e.request_count = Math.pow(2, 52);
            e.update_pending();
            assert.equal(e.pending, 500);
            assert.equal(e.request_count, 500);
        });

        it("maintains the correct requestRate when requestCount 'overflows'", function () {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969);
            e.pending = 500;
            e.request_rate = 500;
            e.request_count = Math.pow(2, 52);
            e.requests_last_check = e.request_count - 500;
            e.reset_counters();
            assert.equal(e.request_count - e.requests_last_check, e.request_rate);
        });
    });

    describe("resetCounters()", function () {
        it("sets successes, failures and filtered to 0", function () {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969);
            e.successes = (Math.pow(2, 52) / 2) - 250;
            e.failures = (Math.pow(2, 52) / 2) - 251;
            e.filtered = 1;
            e.request_count = Math.pow(2, 52);
            e.reset_counters();
            assert.equal(e.successes, 0);
            assert.equal(e.failures, 0);
            assert.equal(e.filtered, 0);
        });

        it("sets requestCount = pending", function () {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969);
            e.pending = 500;
            e.request_rate = 400;
            e.request_count = Math.pow(2, 52);
            e.reset_counters();
            assert.equal(e.request_count, 500);
        });

        it("sets requestsLastCheck = requestRate - pending", function () {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969);
            e.pending = 500;
            e.request_rate = 600;
            e.reset_counters();
            assert.equal(e.requests_last_check, 100);
        });
    });

    describe("ready()", function () {
        it("returns true when it is healthy and connected > pending with keepAlive on",
            function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {keepAlive: true});
                e.pending = 1;
                e.agent.sockets[e.name] = [1, 2];
                assert(e.ready());
            }
        );

        it("returns false when it is healthy and connected = pending with keepAlive on",
            function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969, {keepAlive: true});
                e.pending = 1;
                e.agent.sockets[e.name] = [1];
                assert(!e.ready());
            }
        );

        it("returns true when it is healthy and pending = 0 with keepAlive off",
            function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969);
                e.pending = 0;
                assert(e.ready());
            }
        );

        it("returns false when it is healthy and pending > 0 with keepAlive off",
            function () {
                var e = new PoolEndpoint(http, "127.0.0.1", 6969);
                e.pending = 1;
                assert(!e.ready());
            }
        );
    });

    describe("set_healthy()", function () {

        it("calls pinger.start if transitioning from healthy to unhealthy", function (done) {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969, {ping: "/ping"});
            var count = 0;
            e.pinger.start = function () {
                if (count === 0) {
                    done();
                }
                count++;
            };
            e.set_healthy(false);
        });

        it("emits 'health' once when changing state from healthy to unhealthy", function (done) {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969, {ping: "/ping"});
            e.emit = function (name) {
                assert.equal(name, "health");
                done();
            };
            e.set_healthy(false);
        });

        it("emits 'health' when changing state from unhealthy to healthy", function (done) {
            var e = new PoolEndpoint(http, "127.0.0.1", 6969, {ping: "/ping"});
            var count = 0;
            e.emit = function (name) {
                assert.equal(name, "health");
                if (count === 0) {
                    done();
                }
                count++;
            };
            e.healthy = false;
            e.set_healthy(true);
        });
    });
});
