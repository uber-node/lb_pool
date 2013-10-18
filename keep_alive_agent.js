// Copyright 2013 Voxer IP LLC. All rights reserved.

var http = require("http"),
    https = require("https"),
    inherits = require("util").inherits;

function KeepAliveAgent(options) {
    options = options || {};
    http.Agent.call(this, options);

    this.max_reqs_per_socket = options.max_reqs_per_socket || 1000;

    // Keys are host:port names, values are lists of sockets.
    this.idle_sockets = {};

    // Replace the 'free' listener set up by the default node Agent above.
    this.removeAllListeners("free");

    var self = this;
    this.on("free", function (socket, host, port, local_address) {
        self.on_free(socket, host, port, local_address);
    });
}
inherits(KeepAliveAgent, http.Agent);

KeepAliveAgent.prototype.build_name_key = function (host, port, local_address) {
    var name = host + ":" + port;
    if (local_address) {
        name += ":" + local_address;
    }
    return name;
};

// socket reuse strategy:
//    after a request is finished, decide whether to preserve this socket
//    if socket is "usable", meaning node didn't mark it as destroyed,
//    check for max request_count, and destroy as necessary
KeepAliveAgent.prototype.on_free = function (socket, host, port, local_address) {
    var name = this.build_name_key(host, port, local_address);

    if (this.is_socket_usable(socket)) {
        socket.request_count = socket.request_count ? socket.request_count + 1 : 1;

        if (socket.request_count >= this.max_reqs_per_socket) {
            socket.destroy();
        } else {
            if (!this.idle_sockets[name]) {
                this.idle_sockets[name] = [];
            }
            this.idle_sockets[name].push(socket);
        }
    }

    // If we had any pending requests for this name, send the next one off now.
    if (this.requests[name] && this.requests[name].length) {
        var next_request = this.requests[name].shift();

        if (!this.requests[name].length) {
            delete this.requests[name];
        }

        this.addRequest(next_request, host, port, local_address);
    }
};

// addRequest is called by from node in http.js. We intercept this and re-use a socket if we've got one available.
KeepAliveAgent.prototype.addRequest = function (request, host, port, local_address) {
    var name = this.build_name_key(host, port, local_address);
    var socket = this.next_idle_socket(name);

    if (socket) {
        request.onSocket(socket);
    } else {
        http.Agent.prototype.addRequest.call(this, request, host, port, local_address);
    }
};

KeepAliveAgent.prototype.next_idle_socket = function (name) {
    if (!this.idle_sockets[name]) {
        return null;
    }

    var socket;
    while ((socket = this.idle_sockets[name].shift()) !== undefined) {
        // Check that this socket is still healthy after sitting around on the shelf.
        if (this.is_socket_usable(socket)) {
            return socket;
        }
    }
    return null;
};

KeepAliveAgent.prototype.is_socket_usable = function (socket) {
    return !socket.destroyed;
};

// removeSocket is called from node in http.js. We intercept to update the idle_sockets map.
KeepAliveAgent.prototype.removeSocket = function (socket, name, host, port, local_address) {
    if (this.idle_sockets[name]) {
        var idx = this.idle_sockets[name].indexOf(socket);
        if (idx !== -1) {
            this.idle_sockets[name].splice(idx, 1);
            if (!this.idle_sockets[name].length) {
                delete this.idle_sockets[name];
            }
        }
    }

    http.Agent.prototype.removeSocket.call(this, socket, name, host, port, local_address);
};


function HTTPSKeepAliveAgent(options) {
    KeepAliveAgent.call(this, options);
    this.createConnection = https.globalAgent.createConnection; // node Agent API
}
inherits(HTTPSKeepAliveAgent, KeepAliveAgent);

// defaultPort is part of the node API for Agent
HTTPSKeepAliveAgent.prototype.defaultPort = 443;

HTTPSKeepAliveAgent.prototype.is_socket_usable = function (socket) {
    // TLS sockets null out their secure pair's ssl field in destroy() and do not set destroyed the way non-secure sockets do.
	return socket.pair && socket.pair.ssl;
};

module.exports = function init() {
    return {
        HTTP: KeepAliveAgent,
        HTTPS: HTTPSKeepAliveAgent
    };
};
