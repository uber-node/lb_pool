lb_pool
=======

In-process HTTP load balancer client with retries and backpressure for node.js.

If you use HTTP for IPC, or if you consume public APIs with HTTPS, then `lb_pool` can help make your system more reliable, and possibly even faster.

`lb_pool` will use HTTP/1.1 keepalive to all of the available servers, distributing the load while maintaining and reusing TCP connections as appropriate. If a request fails due to a socket error or a user-defined failure condition, the request will be retried on another node. If there are too many pending requests into a pool, new requests are failed immediately to enforce backpressure and guard against cascading failures.

This module is inspired by and rewritten from [poolee](https://github.com/dannycoates/poolee), which is more actively maintained than `lb_pool`. `lb_pool` is similar in many ways to Twitter's [finagle](https://github.com/twitter/finagle).

# Usage Example

```javascript

var LB_Pool = require("lb_pool");

var servers = [
    "10.0.0.1:8000",
    "10.0.0.2:8000",
    "10.0.0.3:8000"
];

var auth_pool = new LB_Pool(require("http"), servers, {
    max_pending: 300,
    ping: "/ping",
    timeout: 10000,
    max_sockets: 2,
    name: "auth"
});

auth_pool.get("/api/auth_validate?user=mjr", function (err, res, body) {
    // handle error or response
});
```

# Consuming external APIs with HTTPS

If your application consumes public APIs, you can get better performance and reliability by using `lb_pool`:

```javascript

var LB_Pool = require("lb_pool");

var servers = [
    "api.facebook.com:443",
    "api.facebook.com:443"
];

var auth_pool = new LB_Pool(require("https"), servers, {
    max_pending: 10,
    ping: "/ping",
    timeout: 10000,
    max_sockets: 4,
    name: "fb"
});

auth_pool.get("/me?token=aaaaaaaaaaaa", function (err, res, body) {
    // handle error or response
});
```

