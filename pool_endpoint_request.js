// Copyright 2013 Voxer IP LLC. All rights reserved.

var Stream = require("stream"),
    inherits = require("util").inherits,
    GO;

function noop() {
    return false;
}

function PoolEndpointRequest(endpoint, options, callback) {
    options.host = endpoint.ip;
    options.port = endpoint.port;
    options.retry_filter = options.retry_filter || noop;
    options.timeout = options.timeout || endpoint.timeout;
    options.headers = options.headers || {};
    if (options.agent !== false) {
        options.agent = endpoint.agent;
    }
    if (typeof options.encoding === "string") {
        options.encoding = options.encoding || "utf8";
    }

    this.id = endpoint.request_count++;
    this.endpoint = endpoint;
    this.options = options;
    this.callback = callback || noop; // note that this.endpoint reaches in and calls this
    this.last_touched = Date.now();
    this.req_end = null;
    this.res_start = null;

    this.response = null;
    this.writable = true;
    this.readable = true;

    this.buffer_body = options.buffer_body !== false;
    this.body_chunks = [];
    this.body_length = 0;

    this.timed_out = false;

    // message_router uses these next two, because of specialized backpressure logic
    this.buffered_writes = 0;
    this.buffered_writes_bytes = 0;
    this.state = "init";
    this.destroyed = false;

    this.out_request = null;
}

inherits(PoolEndpointRequest, Stream);

PoolEndpointRequest.prototype.start = function () {
    var self = this;
    this.out_request = this.endpoint.http.request(this.options);
    this.out_request.on("response", function (response) { self.on_response(response); });
    this.out_request.on("error", function (err) { self.on_error(err); });
    this.out_request.on("drain", function () { self.on_drain(); });

    var data = this.options.data;
    if (!data && this.options.end === false) {
        return;
    }
    if (!data) {
        return this.end();
    }
    if (data instanceof Stream) {
        return data.pipe(this);
    }

    this.out_request.setHeader("Content-Length", Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data));
    this.end(data);
};

PoolEndpointRequest.prototype.on_response = function (response) {
    var self = this;
    this.response = response;
    this.state = "res_start";
    this.res_start = Date.now();

    response.on("data", function (chunk) { self.on_data(chunk); });
    response.on("end", function () { self.on_end(); });
    response.on("aborted", function () { self.on_aborted(); });
};

PoolEndpointRequest.prototype.on_error = function (err) {
    if (!this.callback) {
        return;
    }

    this.writable = false;
    this.readable = false;
    this.state = "error";

    var msg = this.endpoint.name + " error: " + (this.timed_out ? "request timed out" : err.message);
    this.endpoint.request_failed({
        reason: err.message,
        attempt: this,
        message: msg,
    }, this);
};

PoolEndpointRequest.prototype.on_drain = function () {
    this.last_touched = Date.now();
    this.buffered_writes = 0;
    this.buffered_writes_bytes = 0;
    this.emit("drain");
};

PoolEndpointRequest.prototype.on_data = function (chunk) {
    this.last_touched = Date.now();
    if (this.buffer_body) {
        this.body_chunks.push(chunk);
        this.body_length += chunk.length;
    }
    this.state = "res_read";
    this.emit("data", chunk);
};

PoolEndpointRequest.prototype.on_end = function () {
    if (!this.callback) {
        return;
    }

    var self = this;
    this.readable = false;

    if (this.callback === null) { return; }
    if (this.timed_out) { return this.on_aborted(); }

    this.state = "res_end";
    this.emit("end");

    var body;
    if (this.buffer_body) {
        var body_buf = Buffer.concat(this.body_chunks, this.body_length);
        if (this.options.encoding !== null) {
            body = body_buf.toString(this.options.encoding);
        } else {
            body = body_buf;
        }
    }

    var delay = this.options.retry_filter(this.options, this.response, body);
    if (delay !== false) { // delay may be 0
        return this.endpoint.filter_rejected({
            delay: delay,
            reason: "filter",
            attempt: this,
            message: self.endpoint.name + " error: rejected by filter"
        }, this);
    }
    this.endpoint.request_succeeded(this, this.response, body);
};

PoolEndpointRequest.prototype.on_aborted = function () {
    if (!this.callback) {
        return;
    }

    var msg = this.endpoint.name + " error: ";
    msg += this.timed_out ? "response timed out" : "connection aborted";
    this.state = "res_aborted";
    this.endpoint.request_failed({
        reason: "aborted",
        attempt: this,
        message: msg,
    }, this);
};


PoolEndpointRequest.prototype.write = function (buf) {
    // Prevent memory leak in node 0.8.16
    if (this.out_request.socket && this.out_request.socket.destroyed) {
        this.out_request.emit("close");
        return false;
    }
    var success = this.out_request.write(buf);
    if (success) {
        this.last_touched = Date.now();
        this.buffered_writes = 0;
        this.buffered_writes_bytes = 0;
        this.state = "req_write";
    } else {
        this.buffered_writes += 1;
        this.buffered_writes_bytes += buf.length;
        this.state = "req_write_buffer";
    }
    return success;
};

PoolEndpointRequest.prototype.end = function (buf) {
    this.req_end = Date.now();
    this.last_touched = Date.now();
    this.writable = false;
    this.state = "req_end";
    return this.out_request.end(buf);
};

PoolEndpointRequest.prototype.destroy = function () {
    this.writable = false;
    this.readable = false;
    this.state = "abort";
    this.destroyed = true;
    // Don't call destroy cause that will throw an exception when req.socket doesnt exist.
    this.out_request.abort();
};

PoolEndpointRequest.prototype.abort = PoolEndpointRequest.prototype.destroy;

PoolEndpointRequest.prototype.done = function (err, response, body) {
    var start = this.req_end || Date.now(),
        end = this.res_start || Date.now();
    this.callback(err, response, body, end - start);
    this.emit("done", err, response, body, this);
    this.callback = null;
};

module.exports = function init(new_GO) {
    GO = new_GO;

    return PoolEndpointRequest;
};
