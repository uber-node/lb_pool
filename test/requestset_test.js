// Copyright 2013 Voxer IP LLC. All rights reserved.

var assert = require("assert");

var PoolRequestSet;

var endpoint = {
    request: function () {}
};

var unhealthy = {
    request: function (options, callback) { callback({ message: "no endpoints"}); }
};

function succeeding_request(options, cb) {
    return cb(null, {}, "foo");
}

function failing_request(options, cb) {
    return cb({
        message: "crap",
        reason: "ihateyou"
    });
}

function hangup_request(options, cb) {
    return cb({
        message: "hang up",
        reason: "socket hang up"
    });
}

function aborted_request(options, cb) {
    return cb({
        message: "aborted",
        reason: "aborted"
    });
}

var pool = {
    options: { max_retries: 5 },
    get_endpoint: function () {
        return endpoint;
    },
    on_retry: function () {},
    length: 3
};

PoolRequestSet = require("../pool_request_set")({});

describe("PoolRequestSet", function () {
    it("defaults attempt count to at least 2", function () {
        var r = new PoolRequestSet({length: 1, options: { max_retries: 5 }}, {}, null);
        assert.equal(r.max_attempts, 2);
    });

    it("defaults attempt count to at most max_retries + 1", function () {
        var r = new PoolRequestSet({length: 9, options: { max_retries: 4 }}, {}, null);
        assert.equal(r.max_attempts, 5);
    });

    it("defaults attempt count to pool.length", function () {
        var r = new PoolRequestSet({length: 4, options: { max_retries: 5 }}, {}, null);
        assert.equal(r.max_attempts, 4);
    });

    describe("do_request()", function () {
        it("calls the callback on success", function (done) {
            var r = new PoolRequestSet(pool, {}, function (err, res, body) {
                assert.equal(err, null);
                assert.equal(body, "foo");
                done();
            });
            endpoint.request = succeeding_request;
            r.do_request();
        });

        it("calls the callback on error", function (done) {
            var r = new PoolRequestSet(pool, {}, function (err, res, body) {
                assert.strictEqual(err.message, "crap");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
            endpoint.request = failing_request;
            r.do_request();
        });

        it("calls the callback with a 'no endpoints' error when there's no endpoints to service the request", function (done) {
            var p = {
                options: { max_retries: 5 },
                get_endpoint: function () { return unhealthy; },
                length: 0,
                on_retry: function () {}
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.strictEqual(err.message, "no endpoints");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
            r.do_request();
        });

        it("retries hangups once", function (done) {
            var i = 0;
            var p = {
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[i++]; },
                on_retry: function () {},
                length: 2,
                endpoints: [{ request: hangup_request }, { request: succeeding_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.equal(err, null);
                assert.equal(body, "foo");
                done();
            });
            r.do_request();
        });

        it("retries hangups once then fails", function (done) {
            var p = {
                i: 0,
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[this.i++]; },
                on_retry: function () {},
                length: 3,
                endpoints: [{ request: hangup_request }, { request: hangup_request }, { request: succeeding_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.strictEqual(err.reason, "socket hang up");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
            r.do_request();
        });

        it("retries aborts once", function (done) {
            var p = {
                i: 0,
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[this.i++]; },
                on_retry: function () {},
                length: 2,
                endpoints: [{ request: aborted_request }, { request: succeeding_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.equal(err, null);
                assert.equal(body, "foo");
                done();
            });
            r.do_request();
        });

        it("retries aborts once then fails", function (done) {
            var p = {
                i: 0,
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[this.i++]; },
                on_retry: function () {},
                length: 3,
                endpoints: [{ request: aborted_request }, { request: aborted_request }, { request: succeeding_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.strictEqual(err.reason, "aborted");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
            r.do_request();
        });

        it("fail, fail, then abort will call back with 'aborted'", function (done) {
            var p = {
                i: 0,
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[this.i++]; },
                on_retry: function () {},
                length: 3,
                endpoints: [{ request: failing_request }, { request: failing_request }, { request: aborted_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.strictEqual(err.reason, "aborted");
                assert.strictEqual(res, undefined);
                assert.strictEqual(body, undefined);
                done();
            });
            r.do_request();
        });

        it("retries up to the first success", function (done) {
            var p = {
                i: 0,
                options: { max_retries: 5 },
                get_endpoint: function () { return this.endpoints[this.i++]; },
                on_retry: function () {},
                length: 4,
                endpoints: [{ request: failing_request }, { request: failing_request }, { request: succeeding_request }, { request: failing_request }]
            };
            var r = new PoolRequestSet(p, {}, function (err, res, body) {
                assert.equal(err, null);
                assert.equal(body, "foo");
                done();
            });
            r.do_request();
        });
    });
});
