// Copyright 2013 Voxer IP LLC. All rights reserved.

var assert = require("assert");
var http = require("http");
var Pool = require("../lb_pool")({});

describe("Pool reqeust()", function () {
    it("passes options all the way to the endpoint request", function (done) {
        var pool = new Pool(http, ["127.0.0.1:6969"]);
        var s = http.createServer(function (req, res) {
            res.end("foo");
            s.close();
        });
        s.on("listening", function () {
            pool.request({
                path: "/foo",
                method: "GET",
                ca: "bar.ca"
            }, null, function () {
                done();
            });
            var req = pool.get_node().requests[0];
            assert.equal(req.options.ca, "bar.ca");
        });
        s.listen(6969);
    });

    it("retries failed requests on another node", function (done) {
        var req_count = 0;
        var listen_count = 0;
        var ports = [6960, 6961, 6962, 6963, 6964, 6965];
        var servers = [];
        var endpoint_list = ports.map(function (port) { return "127.0.0.1:" + port; });
        var pool = new Pool(http, endpoint_list, { ping: "/ping" });
        var failed_port;
        function next() {
            pool.get({
                path: "/foo",
                retry_delay: 0
            }, null, function (err, res, body) {
                assert.strictEqual(body, "OK");
                servers.forEach(function (server) { server.close(); });
                done();
            });
        }
        function on_request(port, req, res) {
            if (req.url === "/ping") {
                assert.strictEqual(port, failed_port);
                return req.socket.destroy();
            }
            req_count++;
            if (req_count < 2) {
                failed_port = port;
                req.socket.destroy();
            } else {
                assert.notStrictEqual(port, failed_port);
                res.end("OK");
            }
        }
        function on_listening() {
            listen_count++;
            if (listen_count === ports.length) {
                next();
            }
        }
        ports.forEach(function (port) {
            var server = http.createServer(on_request.bind(this, port));
            server.listen(port);
            server.on("listening", on_listening);
            servers.push(server);
        });
    });

    it("uses a specific endpoint if options.endpoint is set, even on retries", function (done) {
        var req_count = 0;
        var listen_count = 0;
        var ports = [6960, 6961, 6962, 6963, 6964, 6965];
        var servers = [];
        var endpoint_list = ports.map(function (port) { return "127.0.0.1:" + port; });
        var pool = new Pool(http, endpoint_list, { ping: "/ping" });
        var failed_port;
        function next() {
            pool.get({
                path: "/foo",
                endpoint: "127.0.0.1:6963",
                retry_delay: 100,
                max_attempts: 5,
                max_hangups: 4
            }, null, function (err, res, body) {
                assert.strictEqual(body, "OK");
                servers.forEach(function (server) { server.close(); });
                done();
            });
        }
        function on_request(port, req, res) {
            if (req.url === "/ping") {
                return res.end("pong");
            }
            req_count++;
            if (req_count < 4) {
                failed_port = port;
                req.socket.destroy();
            } else {
                assert.strictEqual(port, failed_port);
                res.end("OK");
            }
        }
        function on_listening() {
            listen_count++;
            if (listen_count === ports.length) {
                next();
            }
        }
        ports.forEach(function (port) {
            var server = http.createServer(on_request.bind(this, port));
            server.listen(port);
            server.on("listening", on_listening);
            servers.push(server);
        });
    });

    it("throws if options.endpoint doesn't match anything", function (done) {
        var req_count = 0;
        var listen_count = 0;
        var ports = [6960, 6961, 6962, 6963, 6964, 6965];
        var servers = [];
        var endpoint_list = ports.map(function (port) { return "127.0.0.1:" + port; });
        var pool = new Pool(http, endpoint_list, { ping: "/ping" });
        var failed_port;
        function next() {
            assert.throws(function () {
                pool.get({
                    path: "/foo",
                    endpoint: "127.0.0.1:9999",
                    retry_delay: 100,
                    max_attempts: 5,
                    max_hangups: 4
                }, null, function () {});
            });
            servers.forEach(function (server) { server.close(); });
            done();
        }
        function on_request(port, req, res) {
            if (req.url === "/ping") {
                assert.strictEqual(port, failed_port);
                return res.end("pong");
            }
            req_count++;
            if (req_count < 4) {
                failed_port = port;
                req.socket.destroy();
            } else {
                assert.strictEqual(port, failed_port);
                res.end("OK");
            }
        }
        function on_listening() {
            listen_count++;
            if (listen_count === ports.length) {
                next();
            }
        }
        ports.forEach(function (port) {
            var server = http.createServer(on_request.bind(this, port));
            server.listen(port);
            server.on("listening", on_listening);
            servers.push(server);
        });
        pool.on("retrying", function (err) {
            console.log("retrying in " + err.delay + "ms");
        });
    });

    it("detects revived nodes with pinger", function (done) {
        var retry_count = 0;
        var listen_count = 0;
        var ports = [6960, 6961, 6962, 6963, 6964, 6965];
        var servers = [];
        var endpoint_list = ports.map(function (port) { return "127.0.0.1:" + port; });
        var pool = new Pool(http, endpoint_list, { ping: "/ping" });
        function next() {
            pool.get({
                path: "/foo",
                retry_delay: 100,
                max_aborts: 4
            }, null, function (err, res, body) {
                assert.strictEqual(body, "OK");
                servers.forEach(function (server) { server.close(); });
                done();
            });
        }
        function on_request(port, req, res) {
            if (req.url === "/ping") {
                return res.end("pong");
            }
            res.end("OK");
        }
        function on_listening() {
            listen_count++;
        }
        pool.on("retrying", function () {
            retry_count++;
            if (retry_count === 1) {
                ports.forEach(function (port) {
                    var server = http.createServer(on_request.bind(this, port));
                    server.listen(port);
                    server.on("listening", on_listening);
                    servers.push(server);
                });
            }
        });
        next();
    });
});
