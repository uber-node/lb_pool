// Copyright 2013 Voxer IP LLC. All rights reserved.

/*global afterEach */

var assert = require("assert"),
    http = require("http"),
    https = require("https"),
    KeepAliveAgent = require("../keep_alive_agent")();

var server_config = {
    hostname: "localhost",
    port: 8000
};
var socket_name = server_config.hostname + ":" + server_config.port;

function make_test_request(agent, callback) {
    http.get({
        hostname: server_config.hostname,
        port: server_config.port,
        path: "/",
        agent: agent
    }, callback);
}

describe("KeepAliveAgent", function () {
    var server;

    beforeEach(function (done) {
        server = http.createServer(function (request, response) {
            response.end("pong");
        });
        server.on("listening", done);
        server.listen(server_config.port);
    });

    afterEach(function () {
        server.close();
        server = null;
    });

    it("constructs an agent with the passed-in options", function () {
        var agent = new KeepAliveAgent.HTTP({ maxSockets: 3 });

        assert.strictEqual(agent.maxSockets, 3, "max sockets option not passed through");
        assert.strictEqual(typeof agent.idle_sockets, "object");
    });

    it("provides a socket to a request", function (done) {
        var agent = new KeepAliveAgent.HTTP();
        http.get({
            hostname: server_config.hostname,
            port: server_config.port,
            path: "/",
            agent: agent
        }, function () {
            // if we get here at all, it worked
            done();
        });
    });

    it("re-uses sockets on repeated requests to the same host:port", function (done) {
        var agent = new KeepAliveAgent.HTTP();
        var get_options = {
            hostname: server_config.hostname,
            port: server_config.port,
            path: "/",
            agent: agent
        };

        var requests_todo = 10;
        var interval_id;

        var request_one = function () {
            http.get(get_options, function () {
                if (--requests_todo === 0) {
                    clearInterval(interval_id);

                    process.nextTick(function () {
                        assert.strictEqual(Array.isArray(agent.idle_sockets[socket_name]), true);
                        assert.strictEqual(agent.idle_sockets[socket_name].length, 1);
                        var socket = agent.idle_sockets[socket_name][0];
                        assert.strictEqual(socket.request_count, 10);
                        done();
                    });
                }
            });
        };

        interval_id = setInterval(request_one, 5);
    });

    it("does not return destroyed sockets to the idle pool", function (done) {
        var agent = new KeepAliveAgent.HTTP();
        make_test_request(agent, function (response) {
            response.connection.destroy();
            process.nextTick(function () {
                assert.strictEqual(agent.idle_sockets[socket_name], undefined);
                done();
            });
        });
    });

    it("does not attempt to use destroyed sockets from the idle list", function () {
        var agent = new KeepAliveAgent.HTTP();

        agent.idle_sockets[socket_name] = [];
        agent.idle_sockets[socket_name].push({ destroyed: true });
        agent.idle_sockets[socket_name].push({ destroyed: true });
        agent.idle_sockets[socket_name].push({ destroyed: true });
        agent.idle_sockets[socket_name].push({ destroyed: true });

        var socket = agent.next_idle_socket(socket_name);
        assert.strictEqual(socket, null);
        assert.strictEqual(agent.idle_sockets[socket_name].length, 0);
    });

    it("reuses a good socket until it is destroyed", function (done) {
        var agent = new KeepAliveAgent.HTTP();

        make_test_request(agent, function () {
            process.nextTick(function () {
                assert.strictEqual(Array.isArray(agent.idle_sockets[socket_name]), true, "expected idle sockets list for " + socket_name + " to be an array");
                assert.strictEqual(agent.idle_sockets[socket_name].length, 1, "expected idle sockets list to contain exactly 1 item");
                var socket = agent.idle_sockets[socket_name][0];
                assert.strictEqual(socket.request_count, 1, "expected socket request count to be 1");

                make_test_request(agent, function (response) {
                    process.nextTick(function () {
                        assert.strictEqual(Array.isArray(agent.idle_sockets[socket_name]), true, "expected idle sockets list for " + socket_name + " to be an array");
                        assert.strictEqual(agent.idle_sockets[socket_name].length, 0, "expected idle sockets list to be empty");
                        done();
                    });
                    response.connection.destroy();
                });
            });
        });
    });

    it("closes the socket after max_reqs_per_socket requests", function (done) {
        var agent = new KeepAliveAgent.HTTP({max_reqs_per_socket: 2});

        make_test_request(agent, function (response) {
            response.on("end", function () {
                process.nextTick(function () {
                    var socket = agent.idle_sockets[socket_name][0];
                    assert.strictEqual(socket.request_count, 1, "socket.request_count should be 1");
                    make_test_request(agent, function (response) {
                        response.on("end", function () {
                            process.nextTick(function () {
                                assert.strictEqual(agent.idle_sockets[socket_name].length, 0, "agent should have no idle sockets");
                                make_test_request(agent, function (response) {
                                    response.on("end", function () {
                                        process.nextTick(function () {
                                            assert.strictEqual(agent.idle_sockets[socket_name][0].request_count, 1);
                                            assert(socket.destroyed);
                                            done();
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

describe("KeepAliveAgent.Secure", function () {
    it("can construct a secure keep-alive agent", function () {
        var secure_agent = new KeepAliveAgent.HTTPS({});
        assert(secure_agent.defaultPort === 443);
    });

    it("basically works", function (done) {
        https.get({
            hostname: "one.voxer.com",
            port: 443,
            path: "/ping",
            agent: new KeepAliveAgent.HTTPS(),
        }, function () {
            done();
        });
    });

    it("reuses sockets for secure connections", function (done) {
        var agent = new KeepAliveAgent.HTTPS();
        var get_options = {
            hostname: "one.voxer.com",
            port: 443,
            path: "/ping",
            agent: agent,
        };
        var socket_name = "one.voxer.com:443";

        https.get(get_options, function () {
            process.nextTick(function () {
                assert.strictEqual(Array.isArray(agent.idle_sockets[socket_name]), true, "expected idle sockets list for " + socket_name + " to be an array");
                assert.strictEqual(agent.idle_sockets[socket_name].length, 1, "expected idle sockets list to contain exactly 1 item");
                var socket = agent.idle_sockets[socket_name][0];
                assert.strictEqual(socket.request_count, 1, "expected socket request count to be 1");

                https.get(get_options, function (response) {
                    process.nextTick(function () {
                        assert.equal(agent.idle_sockets[socket_name].length, 0, "expected zero sockets in our idle queue");
                        done();
                    });
                    response.connection.destroy();
                });
            });
        });
    });

    it("does not attempt to use destroyed sockets from the idle list", function () {
        var agent = new KeepAliveAgent.HTTPS();

        agent.idle_sockets[socket_name] = [];
        agent.idle_sockets[socket_name].push({ pair: { ssl: null } });
        agent.idle_sockets[socket_name].push({ pair: { ssl: null } });
        agent.idle_sockets[socket_name].push({ pair: { ssl: null } });
        agent.idle_sockets[socket_name].push({ pair: { ssl: null } });
        agent.idle_sockets[socket_name].push({ pair: { ssl: null } });

        var socket = agent.next_idle_socket(socket_name);
        assert.equal(socket, null);
        assert.equal(agent.idle_sockets[socket_name].length, 0);
    });
});
