// Copyright 2013 Voxer IP LLC. All rights reserved.

var assert = require("assert");
var http = require("http");
var Pool = require("../lb_pool")({});

describe("Pool request()", function () {
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

    it("allows specified requests to skip the max_pending check", function (done) {
        var port = 6969;
        var pool = new Pool(http, ["127.0.0.1:" + port], { ping: "/ping", max_pending: 1 });
        var server;

        function on_listening() {
            var completed = 0;
            [1, 2, 3, 4].forEach(function (num) {
                pool.get({
                    path: "/foo/" + num,
                    override_pending: true
                }, null, function (err, res, body) {
                    assert.ifError(err);
                    assert.strictEqual(body, "OK " + num);
                    completed++;
                    if (completed === 4) {
                        server.close();
                        done();
                    }
                });
            });
        }

        function on_request(req, res) {
            var num = require("url").parse(req.url).pathname.split("/")[2];
            res.end("OK " + num);
        }

        server = http.createServer(on_request);
        server.listen(port);
        server.on("listening", on_listening);
    });

    it("reuses open sockets when making requests", function (done) {
        var ports = [6960, 6961, 6962, 6963, 6964];

        var endpoint_list = ports.map(function hostPort(p) {
            return "127.0.0.1:" + p;
        });

        var pool = new Pool(http, endpoint_list, {
            ping: "/ping",
            keep_alive: true,
            max_pending: 300,
            max_sockets: 2
        });
        var servers = [];
        var listen_count = 0;

        function send_requests() {
            var completed = 0;
            var total = 10;
            var seenRemotes = [];

            send_a_request();

            function send_a_request() {
                var req = pool.get({
                    path: "/foo/" + completed
                }, null, function (err, res, body) {
                    var addr = res.socket.address();

                    if (seenRemotes.indexOf(addr.port) === -1) {
                        seenRemotes.push(addr.port);
                    }

                    assert.ifError(err);
                    assert.strictEqual(body, "OK " + completed);

                    completed++;
                    if (completed === total) {
                        finish();
                    } else {
                        send_a_request();
                    }
                });

                var endpoint = req.endpoint;

                if (completed === 0) {
                    assert.equal(endpoint.ready(), false);
                    assert.equal(endpoint.stats().socket_count, 1);
                } else {
                    assert.equal(endpoint.ready(), true);
                    assert.equal(endpoint.stats().socket_count, 2);
                }
            }

            function finish() {
                assert.strictEqual(seenRemotes.length, 2);

                servers.forEach(function closeIt(s) {
                    s.close();
                })
                done();
            }
        }

        function on_request(req, res) {
            var num = require("url").parse(req.url).pathname.split("/")[2];
            res.end("OK " + num);
        }

        function on_listening() {
            listen_count++;
            if (listen_count === ports.length) {
                send_requests();
            }
        }

        ports.forEach(function (port) {
            var server = http.createServer(on_request);
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

    it("fails if options.endpoint doesn't match anything", function (done) {
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
                endpoint: "127.0.0.1:9999",
                retry_delay: 100,
                max_attempts: 5,
                max_hangups: 4
            }, null, function (err) {
                assert(err);
                servers.forEach(function (server) { server.close(); });
                done();
            });
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
